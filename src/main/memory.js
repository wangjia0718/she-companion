'use strict';

// 记忆卡：归一化、相似度、打分检索、合并去重、抽取、裁剪、抑制（Spec 7 / 计划 Task 5）。
// 只用 Node 标准库；CommonJS。
//
// 约定：
// - 卡片形状见 Spec 5.3：{ id, kind, text, tags, variants, importance, createdAt, updatedAt,
//   hits, sourceMessageId, embedding }；kind ∈ fact|preference|event|relation；importance ∈ 1..5。
// - 所有入参都不被改动：mergeCards / prune / suppress 都返回新值。
// - 抽取输出的解析有硬上限（64KB / 20 个候选 / 64 层嵌套），单次栈扫描，超限返回 null。
// - 单卡 text 超过 300 字素截断为「头 200 + …（内容过长已截断）+ 尾 60」，避免砍掉尾部事实。
// - 抑制登记表（suppressed）必须落盘，否则重启后删掉的记忆会被重新抽出：
//     memory.json = { cards, suppressed: [{ norm, until }], lastExtractedMessageId }
//   进程内为了少传一个参数，登记表同时挂在返回数组的不可枚举属性 `cards.suppressed` 上；
//   落盘时用 `suppressedOf(cardsOrMemory)` 取出、读回时用 `attachSuppressed(cards, list)` 挂回，
//   或直接调用 `mergeCards(memory, incoming)` / 传 `{ suppressed }`。
// - 合并/抑制用 isSameTopic：否定极性一致 +（非真子串时 Jaccard ≥0.72，或真子串时仅允许
//   连接补充/粒度后缀/前置修饰），避免「猫 / 猫粮」「咖啡 / 咖啡色」这类加字变义的合并。
//   similarity() 只返回纯 Jaccard，用于排序/比较等非判定场景。
// - 中文检索失败的典型原因是标点/空格没去掉，normalizeText 一律用 NFKC + 只留字母数字。

const llm = require('./llm');
const prompt = require('./prompt');

const DAY_MS = 24 * 60 * 60 * 1000;
const MERGE_THRESHOLD = 0.72;
const DEFAULT_TOP_K = 12;
const DEFAULT_LIMIT = 2000;
const SUPPRESS_DAYS = 30;
const RECENT_EVENT_DAYS = 3;
const RECENCY_HALF_LIFE_DAYS = 45;
const DEFAULT_IMPORTANCE = 3;
const MAX_TAGS = 8;
const MAX_VARIANTS = 5;
const MAX_CARD_CHARS = 300;
const CARD_HEAD_CHARS = 200;
const CARD_TAIL_CHARS = 60;
const TRUNCATE_MARKER = '…（内容过长已截断）';
// 同主题判定（补充例外，仅用于真子串关系，见 topicMatchScore）
const TRAIL_PUNCT = /[。！？；，、,.!?;:：…~～"'“”‘’（）()【】\[\]《》<>]+$/u;
const TRAIL_PARTICLES = /[啊呢了吧嘛哦呀哈啦哎嗯哟]+$/u;
const CLAUSE_SEPARATORS = /[。！？；\n]/;
const SUPPLEMENT_CONNECTORS = ['以及', '和', '与', '及', '、'];
// 逗号只在「同一件事的简短补充」时允许：
// 后半句不能出现新主语/代词、不能出现动作或判断谓词、不能是事件转场词开头。
const CLAUSE_PRONOUNS = /(用户|我们|你们|他们|她们|咱们|自己|我|你|他|她|它)/u;
const CLAUSE_EVENT_WORDS = /(去了|去|住在|住|搬家|买|养|想去|上班|下班|睡觉|出门|回家|回来|吃|喝|做|工作|玩|下雨|发生|在|是|有)/u;
const CLAUSE_EVENT_PREFIX = ['结果', '然后', '所以', '后来', '于是', '接着', '但是', '不过', '感觉', '觉得', '发现', '听说'];
const MAX_CLAUSE_EXTRA = 20;
// 粒度后缀：只收行政/地址粒度，不收 店/馆/园/院（那些会改变宾语含义）
const SUPPLEMENT_SUFFIX = /^(区|市|县|省|镇|乡|街道|路|号|楼|室|层)$/;
const SUPPLEMENT_PREFIX_TAILS = ['的', '在', '了', '时候', '最近', '今天', '昨天', '前天', '因为'];
const MAX_CONNECTOR_EXTRA = 30;
const MAX_PREFIX_EXTRA = 10;
// 模型输出解析硬上限（防止超长/畸形文本把主进程卡住）
const MAX_PARSE_BYTES = 64 * 1024;
const MAX_PARSE_CANDIDATES = 20;
const MAX_PARSE_DEPTH = 64;
// 否定词 + 例外词：命中例外先剔除，再判断是否还有否定词（「还没」「不错」不是否定）
const NEGATION = /[不没别未无莫]/;
const NEG_EXCEPTIONS = [
  '还没', '不错', '不但', '不仅', '不同', '无论', '未来', '无线', '无糖',
  '别的', '别人', '分别', '特别', '区别', '不久', '不断', '差不多', '巴不得', '不错过',
];
const KINDS = new Set(['fact', 'preference', 'event', 'relation']);

// 设问里出现这些词，说明用户在问「过去某段时间」，除了打分还要无条件补最近的事件卡
const TIME_WORDS = [
  '昨天', '昨晚', '前天', '前晚', '上周', '上上周', '上个月', '去年',
  '那天', '那次', '那阵子', '前几天', '前些天', '上次', '之前', '刚才',
  '今天', '今晚', '本周', '这周', '最近',
];

// 中文按二元组 + 单字（单字用来兜住「下周交方案」这种短句）；英文/数字按小写词
const HAN_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/;
const TOKEN_RUNS = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+|[a-z0-9]+/g;

let idSeq = 0;

// ---------- 基础工具 ----------

function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function stampOf(value) {
  const date = toDate(value);
  return date ? date.getTime() : null;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 重要度归一化到 1..5；缺失/非法回落 3，超界夹紧，不抛错 */
function normalizeImportance(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_IMPORTANCE;
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_IMPORTANCE;
  return clamp(Math.round(number), 1, 5);
}

function hitsOf(card) {
  const number = Number(card && card.hits);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isCard(card) {
  return Boolean(card) && typeof card === 'object' && typeof card.text === 'string' && card.text.trim() !== '';
}

function cardText(card) {
  return card && typeof card.text === 'string' ? card.text.trim() : '';
}

/**
 * 归一化文本：NFKC（全角转半角、全角空格转普通空格）→ 小写 → 去掉所有标点/空白/符号。
 * 保留中英文与数字（含其他语言的字母）。'我 下周要交《季度方案》！' → '我下周要交季度方案'
 * 截断标记（…（内容过长已截断））先剥掉：它只是展示用，不参与相似度/抑制比对。
 */
function normalizeText(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text
    .split(TRUNCATE_MARKER)
    .join('')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 卡片侧词元：中文「单字 + 相邻二元组」，英文/数字整词（检索覆盖用，容忍单字查询） */
function tokenizeCard(normalized) {
  const tokens = new Set();
  if (!normalized) return tokens;
  const runs = normalized.match(TOKEN_RUNS);
  if (!runs) return tokens;
  for (const run of runs) {
    if (HAN_RUN.test(run.charAt(0))) {
      for (const char of run) tokens.add(char);
      for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
    } else {
      tokens.add(run);
    }
  }
  return tokens;
}

/**
 * 查询词元（检索打分用）：中文只取二元组，单字词取该字，英文/数字整词。
 * 单字不参与打分：否则「周末想去书店」会被含「周」的「下周三交方案」蹭到分，
 * 出现「零重合却入选」的假命中。
 */
function tokenizeQuery(normalized) {
  const tokens = new Set();
  if (!normalized) return tokens;
  const runs = normalized.match(TOKEN_RUNS);
  if (!runs) return tokens;
  for (const run of runs) {
    if (HAN_RUN.test(run.charAt(0))) {
      if (run.length === 1) tokens.add(run);
      else {
        for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
      }
    } else {
      tokens.add(run);
    }
  }
  return tokens;
}

/**
 * 主题词元（合并/抑制判定用）：中文只取相邻二元组，单字不参与（避免「猫 / 狗」靠单字蹭分），
 * 英文/数字按小写整词。孤立单字与标点占多数的文本会得到空集合 → 相似度 0。
 */
function tokenizeTopic(normalized) {
  const tokens = new Set();
  if (!normalized) return tokens;
  const runs = normalized.match(TOKEN_RUNS);
  if (!runs) return tokens;
  for (const run of runs) {
    if (HAN_RUN.test(run.charAt(0))) {
      for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
    } else {
      tokens.add(run);
    }
  }
  return tokens;
}

function hasNegation(normalized) {
  return NEGATION.test(normalized);
}

/**
 * 否定极性：先剔除例外词（还没 / 不错 / 特别 / 未来 / 无糖 …）再找否定词。
 * @param {string} text
 * @returns {1|-1} 1 = 肯定，-1 = 否定
 */
function polarity(text) {
  let normalized = normalizeText(text);
  for (const word of NEG_EXCEPTIONS) normalized = normalized.split(word).join('');
  return hasNegation(normalized) ? -1 : 1;
}

/**
 * 纯字面相似度（0..1）：中文二元组 / 英文词的 Jaccard = 交集 / 并集。
 * 注意：**不含**否定判定与子集例外，因此「喜欢咖啡」与「不喜欢咖啡」也有较高分。
 * 合并/抑制的同主题判定请用 isSameTopic()。
 * @returns {number}
 */
function similarity(a, b) {
  const ta = tokenizeTopic(normalizeText(a));
  const tb = tokenizeTopic(normalizeText(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) intersection += 1;
  }
  if (intersection === 0) return 0;
  const union = ta.size + tb.size - intersection;
  return clamp(intersection / union, 0, 1);
}

/** 归一化字符 → 原始字符串下标的边界表（boundaries[i] = 第 i 个归一化字符在 raw 中的结束位置） */
function normalizedCharBoundaries(raw) {
  const text = typeof raw === 'string' ? raw : String(raw === undefined || raw === null ? '' : raw);
  const boundaries = [0];
  let normalized = '';
  for (let i = 0; i < text.length; i += 1) {
    const piece = text[i].normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (!piece) continue;
    normalized += piece;
    for (let k = 0; k < piece.length; k += 1) boundaries.push(i + 1);
  }
  return { normalized, boundaries };
}

/** 连接补充：和/与/及/、 直接放行；逗号只允许「同一件事的简短补充」 */
function allowedConnectorExtra(extra) {
  if (!extra) return false;
  if (Array.from(extra).length > MAX_CONNECTOR_EXTRA) return false;
  const comma = /^[，,](.*)$/u.exec(extra);
  if (comma) {
    const tail = comma[1];
    if (!tail) return false;
    if (Array.from(tail).length > MAX_CLAUSE_EXTRA) return false;
    if (CLAUSE_EVENT_PREFIX.some((word) => tail.startsWith(word))) return false;
    if (CLAUSE_PRONOUNS.test(tail)) return false;
    if (CLAUSE_EVENT_WORDS.test(tail)) return false;
    return true;
  }
  return SUPPLEMENT_CONNECTORS.some((connector) => extra.startsWith(connector));
}

/** 粒度后缀：extraAfter 恰好是 区/市/县/... 这类单字后缀 */
function allowedGranularityExtra(extra) {
  return SUPPLEMENT_SUFFIX.test(extra);
}

/** 前置修饰：extraBefore ≤10 字且以 的|在|了|时候|最近|今天|昨天|因为 结尾 */
function allowedPrefixExtra(extra) {
  if (!extra) return false;
  if (Array.from(extra).length > MAX_PREFIX_EXTRA) return false;
  return SUPPLEMENT_PREFIX_TAILS.some((tail) => extra.endsWith(tail));
}

/** 保留标点的归一化：NFKC + 小写 + 去空白，标点原样留下 */
function normalizeRaw(text) {
  return String(text == null ? '' : text).normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

/** 去掉结尾标点与语气词后的「核心文本」；只剥尾部，不动中间的逗号句号 */
function coreOf(text) {
  let s = normalizeRaw(text);
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const next = s.replace(TRAIL_PUNCT, '').replace(TRAIL_PARTICLES, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** 内部是否还有句末标点（结尾的句号不算多事实） */
function hasInternalClause(raw) {
  const s = normalizeRaw(raw).replace(TRAIL_PUNCT, '');
  return CLAUSE_SEPARATORS.test(s);
}

/** 判定多出来的一侧是否属于允许的补充形式（中间插入一律不允许） */
function supplementExtrasAllowed(extraBefore, extraAfter) {
  if (!extraBefore && extraAfter) return allowedConnectorExtra(extraAfter) || allowedGranularityExtra(extraAfter);
  if (extraBefore && !extraAfter) return allowedPrefixExtra(extraBefore);
  return false;
}

/**
 * 同主题判定 + 打分（mergeCards / suppress / isSuppressed 统一使用）。
 *
 * 规则（顺序不可调换）：
 * 1. 否定极性不同 → false；
 * 2. 去掉结尾标点与语气词后完全相等 → true（「…啊」「…呢」「…。」不影响）；
 * 3. 真子串关系 → 只认补充例外，命中即结论、不回落 Jaccard：
 *    a. 长句内部若还有句末标点（多事实日记）→ false；
 *    b. 多出来的一侧只能是：连接补充（和/与/及/、/，…）、粒度后缀（区/市/街/路…）、
 *       或 ≤10 字的前置修饰（今天/最近/…的）；其它加字（粮/色/因/味/店/馆…）一律 false。
 * 4. 其余情况按二元组 Jaccard ≥ 0.72。
 *
 * @returns {{same: boolean, jaccard: number, coverage: number}}
 */
function topicMatchScore(a, b) {
  const empty = { same: false, jaccard: 0, coverage: 0 };
  if (polarity(a) !== polarity(b)) return empty;

  const rawA = normalizeRaw(a);
  const rawB = normalizeRaw(b);
  const coreA = coreOf(rawA);
  const coreB = coreOf(rawB);
  if (!coreA || !coreB) return empty;

  const ta = tokenizeTopic(normalizeText(a));
  const tb = tokenizeTopic(normalizeText(b));
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) intersection += 1;
  }
  const union = ta.size + tb.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const coverage = Math.min(ta.size, tb.size) > 0 ? intersection / Math.min(ta.size, tb.size) : 0;

  if (coreA === coreB) return { same: true, jaccard, coverage };

  const aIsShort = coreA.length <= coreB.length;
  const shortCore = aIsShort ? coreA : coreB;
  const longCore = aIsShort ? coreB : coreA;
  const longRaw = aIsShort ? rawB : rawA;
  const index = longCore.indexOf(shortCore);
  if (index !== -1) {
    if (hasInternalClause(longRaw)) return { same: false, jaccard, coverage };
    const extraBefore = longCore.slice(0, index);
    const extraAfter = longCore.slice(index + shortCore.length);
    return { same: supplementExtrasAllowed(extraBefore, extraAfter), jaccard, coverage };
  }

  return { same: jaccard >= MERGE_THRESHOLD, jaccard, coverage };
}

/** 是否同一主题（对外语义入口） */
function isSameTopic(a, b) {
  return topicMatchScore(a, b).same;
}

/** 两个向量的余弦相似度；不可比时返回 0（负相关按 0 处理，避免拉低分数） */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, clamp(dot / (Math.sqrt(normA) * Math.sqrt(normB)), -1, 1));
}

/** 查询词元被卡片覆盖的比例；查询为空时为 0 */
function coverageOf(cardTokens, queryTokens) {
  if (queryTokens.size === 0 || cardTokens.size === 0) return 0;
  let hit = 0;
  for (const token of queryTokens) {
    if (cardTokens.has(token)) hit += 1;
  }
  return hit / queryTokens.size;
}

/**
 * 短句包含度（0..1）：查询的二元组有多少出现在文本里。
 * 只用于检索覆盖率（例如查询「下周交方案」能召回「我下周要交季度方案」），
 * 不参与 mergeCards / suppress 的同主题判定。
 * @param {string} query
 * @param {string} text
 * @returns {number}
 */
function containment(query, text) {
  return coverageOf(tokenizeCard(normalizeText(text)), tokenizeQuery(normalizeText(query)));
}

// ---------- 抑制登记（删除后 30 天不再被抽出） ----------

/** 清洗并去重登记表；非法项丢弃 */
function readSuppressedList(raw) {
  const list = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return list;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.norm !== 'string' || entry.norm === '') continue;
    const until = entry.until;
    const key = `${entry.norm}|${until === undefined ? '' : String(until)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ norm: entry.norm, until });
  }
  return list;
}

/**
 * 取抑制登记表，兼容三种存放位置：
 * - 卡片数组上的不可枚举属性：`cards.suppressed`
 * - memory 对象：`{ cards, suppressed }`
 * - memory 对象里卡片数组上的属性：`memory.cards.suppressed`
 * @param {Card[]|{cards?: Card[], suppressed?: Array}} source
 * @returns {Array<{ norm: string, until: string }>}
 */
function suppressedOf(source) {
  const merged = [];
  if (Array.isArray(source)) {
    merged.push(...readSuppressedList(source.suppressed));
  } else if (source && typeof source === 'object') {
    merged.push(...readSuppressedList(source.suppressed));
    if (Array.isArray(source.cards)) merged.push(...readSuppressedList(source.cards.suppressed));
  }
  return readSuppressedList(merged);
}

/**
 * 把登记表挂回卡片数组（就地挂成不可枚举属性 `suppressed`）并返回同一数组，
 * 供 mergeCards / extractFromChat / suppress 直接使用。
 * @param {Card[]} cards
 * @param {Array<{ norm: string, until: string }>} list
 * @returns {Card[]}
 */
function attachSuppressed(cards, list) {
  if (!Array.isArray(cards)) return withSuppressed([], readSuppressedList(list));
  const merged = readSuppressedList([...(suppressedOf(cards)), ...readSuppressedList(list)]);
  return withSuppressed(cards, merged);
}

function withSuppressed(cards, suppressed) {
  Object.defineProperty(cards, 'suppressed', {
    value: suppressed,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return cards;
}

/**
 * 是否被抑制：传入**原始文本**（不是归一化文本），这样补充例外还能看到「，」这类
 * 影响子句判断的标点。
 */
function isSuppressed(text, now, registry) {
  const norm = normalizeText(text);
  if (!norm) return false;
  const nowMs = (toDate(now) || new Date()).getTime();
  for (const entry of registry) {
    // 未写 until 的条目视为无效；已过期的不再拦截
    const untilMs = stampOf(entry.until);
    if (untilMs === null || untilMs <= nowMs) continue;
    if (entry.norm === norm) return true;
    if (isSameTopic(entry.norm, text)) return true;
  }
  return false;
}

/**
 * 删除某条记忆时调用：把归一化文本登记为 30 天内抑制，
 * 并从卡片列表里移除归一化后完全相同的卡片（同主题的其他卡保留，交给人工判断）。
 * - 传卡片数组 → 返回新数组（带不可枚举的 suppressed 登记表）
 * - 传 memory 对象（`{ cards, suppressed, ... }`）→ 返回同形状对象，可直接 writeMemory 落盘：
 *     `store.writeMemory(dir, id, suppress(memory, text))`
 * @param {Card[]|{cards: Card[], suppressed?: Array}} cards
 * @param {string} text
 * @param {Date|string|number} [now]
 * @returns {Card[]|{cards: Card[], suppressed: Array<{norm: string, until: string}>}}
 */
function suppress(cards, text, now = new Date()) {
  const isMemory = !Array.isArray(cards)
    && Boolean(cards)
    && typeof cards === 'object'
    && Array.isArray(cards.cards);
  const list = cardsOf(cards).filter(isCard);
  const registry = suppressedOf(cards);
  const norm = normalizeText(text);
  const at = toDate(now) || new Date();
  if (norm) {
    registry.push({ norm, until: new Date(at.getTime() + SUPPRESS_DAYS * DAY_MS).toISOString() });
  }
  const kept = norm ? list.filter((card) => normalizeText(cardText(card)) !== norm) : list.slice();
  if (isMemory) return { ...cards, cards: kept, suppressed: registry };
  return withSuppressed(kept, registry);
}

// ---------- 打分与检索 ----------

function createQuery(query) {
  const normalized = normalizeText(query);
  return { normalized, tokens: tokenizeQuery(normalized) };
}

function scoreParts(card, query, { now = new Date(), vectorQuery } = {}) {
  const q = query && query.tokens ? query : createQuery(query);
  const tokens = tokenizeCard(normalizeText(cardText(card)));
  const coverage = coverageOf(tokens, q.tokens);
  const importance = normalizeImportance(card && card.importance);
  const createdMs = stampOf(card && card.createdAt);
  const nowMs = (toDate(now) || new Date()).getTime();
  let recency = 0;
  if (createdMs !== null) {
    const days = Math.max(0, (nowMs - createdMs) / DAY_MS);
    recency = Math.exp(-days / RECENCY_HALF_LIFE_DAYS);
  }
  const hits = hitsOf(card);
  const cosine = cosineSimilarity(card && card.embedding, vectorQuery);
  const score = 3.0 * coverage
    + 1.2 * (importance / 5)
    + 1.0 * recency
    + 0.4 * Math.log1p(hits) / 2
    + 2.5 * cosine;
  return { score, coverage, cosine, importance };
}

/**
 * 单卡打分（Spec 7.3）。
 * @param {object} card
 * @param {string} query
 * @param {{ now?: Date|string|number, vectorQuery?: number[] }} [options]
 * @returns {number}
 */
function scoreCard(card, query, { now = new Date(), vectorQuery } = {}) {
  if (!isCard(card)) return 0;
  return scoreParts(card, createQuery(query), { now, vectorQuery }).score;
}

function hasTimeWord(normalizedQuery) {
  if (!normalizedQuery) return false;
  return TIME_WORDS.some((word) => normalizedQuery.includes(normalizeText(word)));
}

function isRecentEvent(card, nowMs) {
  if (!card || card.kind !== 'event') return false;
  const createdMs = stampOf(card.createdAt);
  if (createdMs === null) return false;
  const days = (nowMs - createdMs) / DAY_MS;
  return days >= 0 && days <= RECENT_EVENT_DAYS;
}

function cardKey(card) {
  return typeof card.id === 'string' && card.id ? card.id : card;
}

/**
 * 检索：过滤 → 打分排序 → 取 Top K → 按 createdAt 正序返回。
 * - 关键词零重合且无向量、且重要度 < 5 的卡片不入选。
 * - 同一 id 的卡片只输出一次（即使调用方把同一对象传了两遍）。
 * - 查询含时间词时，最近 3 天的 event 卡无条件补进来（去重，可能超出 topK）。
 * @returns {Card[]} 卡片浅拷贝，额外带 score
 */
function retrieve(cards, query, { topK = DEFAULT_TOP_K, now = new Date(), vectorQuery } = {}) {
  const at = toDate(now) || new Date();
  const nowMs = at.getTime();
  const q = createQuery(query);
  const limit = Number.isInteger(topK) && topK >= 0 ? topK : DEFAULT_TOP_K;

  const seen = new Set();
  const list = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!isCard(card)) continue;
    const key = cardKey(card);
    if (seen.has(key)) continue; // 同 id 重复传入只留第一条
    seen.add(key);
    list.push(card);
  }

  const ranked = [];
  for (const card of list) {
    const parts = scoreParts(card, q, { now: at, vectorQuery });
    // 零重合 + 无向量 → 只有重要度 5 的卡例外
    if (parts.coverage <= 0 && parts.cosine <= 0 && parts.importance < 5) continue;
    ranked.push({ card, score: parts.score });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const important = normalizeImportance(b.card.importance) - normalizeImportance(a.card.importance);
    if (important !== 0) return important;
    return (stampOf(b.card.updatedAt) || 0) - (stampOf(a.card.updatedAt) || 0);
  });

  const picked = ranked.slice(0, limit);
  const chosen = new Set(picked.map((item) => cardKey(item.card)));

  if (hasTimeWord(q.normalized)) {
    for (const card of list) {
      if (chosen.has(cardKey(card)) || !isRecentEvent(card, nowMs)) continue;
      const parts = scoreParts(card, q, { now: at, vectorQuery });
      picked.push({ card, score: parts.score });
      chosen.add(cardKey(card));
    }
  }

  const output = picked.map((item) => ({ ...item.card, score: item.score }));
  output.sort((a, b) => (stampOf(a.createdAt) || 0) - (stampOf(b.createdAt) || 0));
  return output;
}

// ---------- 合并 ----------

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** 变体列表：去重、最多保留最近 MAX_VARIANTS 条（最后一条恒为当前 text） */
function normalizeVariants(value, text) {
  const list = [];
  const push = (item) => {
    if (typeof item !== 'string') return;
    const variant = item.trim();
    if (!variant || list.includes(variant)) return;
    list.push(variant);
  };
  if (Array.isArray(value)) value.forEach(push);
  if (text) push(text);
  return list.slice(-MAX_VARIANTS);
}

function newCard(raw, now) {
  const at = toDate(now) || new Date();
  idSeq += 1;
  const created = stampOf(raw.createdAt) !== null ? raw.createdAt : at.toISOString();
  const updated = stampOf(raw.updatedAt) !== null ? raw.updatedAt : created;
  const text = cardText(raw);
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id ? raw.id : `m-${at.getTime()}-${idSeq}`,
    kind: KINDS.has(raw.kind) ? raw.kind : 'fact',
    text,
    tags: normalizeTags(raw.tags),
    variants: normalizeVariants(raw.variants, text),
    importance: normalizeImportance(raw.importance),
    createdAt: created,
    updatedAt: updated,
    hits: hitsOf(raw) || 1,
    sourceMessageId: typeof raw.sourceMessageId === 'string' ? raw.sourceMessageId : null,
    embedding: Array.isArray(raw.embedding) && raw.embedding.length > 0 ? raw.embedding : null,
  };
}

/** existing 既可以是卡片数组，也可以是 memory 对象 `{ cards, suppressed }` */
function cardsOf(source) {
  if (Array.isArray(source)) return source;
  if (source && typeof source === 'object' && Array.isArray(source.cards)) return source.cards;
  return [];
}

/** 与卡片当前文本和所有历史变体比，取得分最高的同主题结果（无命中时 same=false） */
function topicScore(card, text) {
  let best = topicMatchScore(cardText(card), text);
  const variants = Array.isArray(card.variants) ? card.variants : [];
  for (const variant of variants) {
    if (!variant || variant === card.text) continue;
    const score = topicMatchScore(variant, text);
    if (!score.same) continue;
    if (!best.same || score.jaccard > best.jaccard
      || (score.jaccard === best.jaccard && score.coverage > best.coverage)) {
      best = score;
    }
  }
  return best;
}

/**
 * 合并新抽出的卡片到已有列表（Spec 7.2）。
 * - isSameTopic 视为同主题：更新 text/updatedAt、hits+1、importance 取大、tags 取并集，
 *   并把新表述追加进 variants（最多 5 条）。
 * - 与「当前文本 + 所有 variants」比较；多条命中时选**最相似**的（Jaccard 优先、其次 coverage）。
 * - 命中未过期的 suppressed 文本直接丢弃。
 * 落盘请用 `{ ...memory, cards, suppressed: suppressedOf(cards) }` 或 `suppress(memory, text)`。
 * @param {Card[]|{cards?: Card[], suppressed?: Array}} existing
 * @param {Card[]} incoming
 * @param {{ now?: Date|string|number, suppressed?: Array<{norm: string, until: string}> }} [options]
 *   suppressed 显式给出时优先于数组/对象上的登记表。
 * @returns {Card[]} 新数组，登记表继续挂在数组的不可枚举属性 `suppressed` 上
 */
function mergeCards(existing, incoming, { now = new Date(), suppressed } = {}) {
  const registry = suppressed !== undefined ? readSuppressedList(suppressed) : suppressedOf(existing);
  const at = toDate(now) || new Date();
  const out = cardsOf(existing)
    .filter(isCard)
    .map((card) => {
      const text = cardText(card);
      return { ...card, text, variants: normalizeVariants(card.variants, text) };
    });
  const list = Array.isArray(incoming) ? incoming.filter(isCard) : [];

  for (const raw of list) {
    const text = cardText(raw);
    const norm = normalizeText(text);
    if (!norm || isSuppressed(text, at, registry)) continue;

    let best = null;
    let bestScore = null;
    for (const card of out) {
      const score = topicScore(card, text);
      if (!score.same) continue;
      if (
        !bestScore
        || score.jaccard > bestScore.jaccard
        || (score.jaccard === bestScore.jaccard && score.coverage > bestScore.coverage)
      ) {
        best = card;
        bestScore = score;
      }
    }

    if (best) {
      best.variants = normalizeVariants([...best.variants, text], text);
      best.text = text;
      best.updatedAt = at.toISOString();
      best.hits = hitsOf(best) + 1;
      best.importance = Math.max(normalizeImportance(best.importance), normalizeImportance(raw.importance));
      best.tags = normalizeTags([...(Array.isArray(best.tags) ? best.tags : []), ...(Array.isArray(raw.tags) ? raw.tags : [])]);
      if (!best.embedding && Array.isArray(raw.embedding) && raw.embedding.length > 0) {
        best.embedding = raw.embedding;
      }
      continue;
    }

    out.push(newCard(raw, at));
  }

  return withSuppressed(out, registry);
}

// ---------- 抽取 ----------

function extractionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function personaBrief(character) {
  const source = character && typeof character === 'object' ? character : {};
  const persona = source.persona && typeof source.persona === 'object' ? source.persona : {};
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : []);
  const parts = [`名字：${typeof source.name === 'string' && source.name.trim() ? source.name.trim() : '她'}`];
  const traits = list(persona.traits);
  if (traits.length) parts.push(`性格：${traits.join('、')}`);
  if (typeof persona.speechStyle === 'string' && persona.speechStyle.trim()) parts.push(`说话：${persona.speechStyle.trim()}`);
  if (typeof persona.background === 'string' && persona.background.trim()) parts.push(`背景：${persona.background.trim()}`);
  if (typeof persona.relationship === 'string' && persona.relationship.trim()) parts.push(`关系：${persona.relationship.trim()}`);
  return `【角色设定】${parts.join('；')}`;
}

/** 抽取用消息：复用 prompt.buildExtractMessages，并把角色设定补进 system（计划 Task 5） */
function buildExtractMessages({ character, messages, existingCards }) {
  const base = prompt.buildExtractMessages({ character, messages, existingCards });
  const brief = personaBrief(character);
  const system = base[0];
  if (brief && system && typeof system.content === 'string') {
    base[0] = { role: 'system', content: `${brief}\n\n${system.content}` };
  }
  return base;
}

/** 按字素簇切分；Node 缺 Intl.Segmenter 时退回按码点切（与 prompt.js 的做法一致） */
let graphemeSegmenter = null;
let graphemeSegmenterReady = false;

function segmentGraphemes(text) {
  const source = typeof text === 'string' ? text : '';
  if (
    !graphemeSegmenterReady
    && typeof Intl === 'object'
    && Intl
    && typeof Intl.Segmenter === 'function'
  ) {
    try {
      graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      graphemeSegmenter = null;
    }
  }
  graphemeSegmenterReady = true;

  if (graphemeSegmenter) {
    const clusters = [];
    for (const part of graphemeSegmenter.segment(source)) clusters.push(part.segment);
    return clusters;
  }
  return Array.from(source);
}

/**
 * 单卡文本截断：超过 300 字素时保留「头 200 + 标记 + 尾 60」。
 * 不整段砍掉结尾，避免「用户对花生严重过敏」这类关键事实落在尾部时被截没；
 * 切口按字素簇对齐，emoji 不会被劈成半个。
 */
function truncateCardText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  const clusters = segmentGraphemes(text);
  if (clusters.length <= MAX_CARD_CHARS) return text;
  const head = clusters.slice(0, CARD_HEAD_CHARS).join('');
  const tail = clusters.slice(-CARD_TAIL_CHARS).join('');
  return `${head}${TRUNCATE_MARKER}${tail}`;
}

/**
 * 单次栈扫描找出顶层平衡 JSON 片段（跳过字符串内的括号），O(n)。
 * 硬上限：嵌套深度 > 64 或候选 > 20 直接返回 null（宁可当次解析失败，也不能卡住主进程）。
 * @returns {string[]|null}
 */
function scanCandidates(text) {
  const spans = [];
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[' || char === '{') {
      stack.push(i);
      if (stack.length > MAX_PARSE_DEPTH) return null;
    } else if (char === ']' || char === '}') {
      if (stack.length === 0) continue; // 多余的闭括号忽略
      const start = stack.pop();
      if (stack.length === 0) {
        spans.push(text.slice(start, i + 1));
        if (spans.length > MAX_PARSE_CANDIDATES) return null;
      }
    }
  }
  return spans;
}

/** 数组里是否至少有一项带记忆 kind（fact/preference/event/relation） */
function hasKindItem(array) {
  return array.some((item) => item && typeof item === 'object' && KINDS.has(item.kind));
}

/** 数组里是否至少有一项带 text 字段（兜底用） */
function hasTextItem(array) {
  return array.some((item) => item && typeof item === 'object' && typeof item.text === 'string');
}

/**
 * 从解析出的 JSON 值里找符合条件的数组：优先对象上的 cards，其次逐层展开嵌套数组/对象。
 * @param {any} value
 * @param {(array: any[]) => boolean} matchArray 数组是否合格
 * @param {number} [depth]
 * @returns {Array|null}
 */
function pickCards(value, matchArray, depth = 0) {
  if (depth > MAX_PARSE_DEPTH) return null;

  if (Array.isArray(value)) {
    if (value.length > 0 && matchArray(value)) return value;
    for (const item of value) {
      if (item && typeof item === 'object') {
        const found = pickCards(item, matchArray, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'cards') && Array.isArray(value.cards)) {
      if (value.cards.length === 0) return value.cards; // 模型明确回答「没有可记的」
      const found = pickCards(value.cards, matchArray, depth + 1);
      if (found) return found;
    }
    for (const key of Object.keys(value)) {
      if (key === 'cards') continue;
      const child = value[key];
      if (child && typeof child === 'object') {
        const found = pickCards(child, matchArray, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/**
 * 解析模型输出里的卡片数组：整体 JSON 优先，失败再按顶层平衡片段逐个尝试。
 * 硬上限：输入 ≤ 64KB、候选 ≤ 20、嵌套 ≤ 64；超限返回 null（由上层重试/丢弃）。
 * 候选优先级：数组元素带 kind ∈ fact|preference|event|relation 的优先返回；
 * 找不到时才退回「带 text 的数组」，避免把示例 `[{"text":"这是说明"}]` 当结果。
 * @param {string} raw
 * @returns {Array|null}
 */
function parseCards(raw) {
  const source = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!source) return null;
  if (Buffer.byteLength(source, 'utf8') > MAX_PARSE_BYTES) return null;

  const regions = [];
  const fenced = source.match(/```[ \t]*[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (fenced && fenced[1].trim()) regions.push(fenced[1].trim());
  regions.push(source);

  const values = [];
  let emptyArray = null;

  for (const region of regions) {
    const whole = tryParse(region);
    if (whole.ok) {
      values.push(whole.value);
      if (Array.isArray(whole.value) && whole.value.length === 0) emptyArray = whole.value;
    }

    const spans = scanCandidates(region);
    if (spans === null) return null;
    for (const span of spans) {
      const parsed = tryParse(span);
      if (parsed.ok) {
        values.push(parsed.value);
        if (Array.isArray(parsed.value) && parsed.value.length === 0) emptyArray = parsed.value;
      }
    }
  }

  let textFallback = null;
  for (const value of values) {
    const byKind = pickCards(value, hasKindItem);
    if (byKind) return byKind;
    if (!textFallback) {
      const byText = pickCards(value, hasTextItem);
      if (byText) textFallback = byText;
    }
  }
  if (textFallback) return textFallback;
  return emptyArray;
}

function lastMessageId(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message && typeof message.id === 'string' && message.id) return message.id;
  }
  return null;
}

/**
 * 从对话里抽取记忆卡（Spec 7.1）。
 * 要求模型只输出 [{kind,text,importance}]；解析失败重试 1 次，仍失败返回 []（不阻塞聊天）。
 * - 单卡 text 超过 300 字素截断为「头 200 + 标记 + 尾 60」；
 * - 同归一化文本的重复项保留 importance 较大的那条；
 * - 命中 suppressed 的文本直接丢弃。
 * @param {{ character?: object, messages?: object[], existing?: Card[]|{cards?: Card[], suppressed?: Array},
 *           profile: object, embeddingProfile?: object, signal?: AbortSignal,
 *           onUsage?: (usage: object) => void, onFailure?: (error: Error) => void }} options
 *   onUsage：每次模型调用成功后回报 usage（供调用方记后台用量，可选）
 *   onFailure：模型调用或解析失败时回报（供调用方做退避，可选）
 * @returns {Promise<Card[]>} 新卡片（不含合并，合并交给 mergeCards）
 */
async function extractFromChat({
  character, messages, existing, profile, embeddingProfile, signal, onUsage, onFailure,
} = {}) {
  if (!profile || typeof profile !== 'object') {
    throw extractionError('记忆抽取需要后台模型配置（profile），当前没有可用配置', 'NO_PROFILE');
  }
  const history = Array.isArray(messages) ? messages.filter((message) => message && typeof message === 'object') : [];
  if (history.length === 0) return [];

  const registry = suppressedOf(existing);
  const existingCards = cardsOf(existing).filter(isCard);
  const promptMessages = buildExtractMessages({ character, messages: history, existingCards });

  let items = null;
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    if (signal && signal.aborted) throw extractionError('已取消本次请求', 'ABORTED');
    const request = attempt === 0
      ? promptMessages
      : [...promptMessages, { role: 'user', content: '上一次输出无法解析。请重新输出，只给 JSON 数组，不要任何解释或代码围栏。' }];
    let text = '';
    try {
      const result = await llm.chat({ profile, messages: request, signal, retry: 0 });
      text = result && typeof result.text === 'string' ? result.text : '';
      if (typeof onUsage === 'function') {
        try {
          onUsage(result && result.usage);
        } catch {
          /* 记账失败不影响抽取 */
        }
      }
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      if (typeof onFailure === 'function') {
        try {
          onFailure(error);
        } catch {
          /* 回调自身出错忽略 */
        }
      }
      continue; // 传输失败也按「失败重试一次」处理
    }
    const parsed = parseCards(text);
    if (parsed) {
      items = parsed;
      break;
    }
    if (typeof onFailure === 'function') {
      try {
        onFailure(new Error('记忆抽取结果无法解析'));
      } catch {
        /* 回调自身出错忽略 */
      }
    }
  }
  if (!items) return [];

  const now = new Date();
  const at = now.toISOString();
  const sourceMessageId = lastMessageId(history);
  // 归一化文本 → 卡片：重复项保留 importance 较大的那条（顺序按首次出现）
  const byNorm = new Map();

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const text = truncateCardText(item.text);
    if (!text) continue;
    const norm = normalizeText(text);
    if (!norm || isSuppressed(text, now, registry)) continue;

    const candidate = {
      id: `m-${now.getTime()}-${idSeq + 1}`,
      kind: KINDS.has(item.kind) ? item.kind : 'fact',
      text,
      tags: normalizeTags(item.tags),
      variants: [text],
      importance: normalizeImportance(item.importance),
      createdAt: at,
      updatedAt: at,
      hits: 1,
      sourceMessageId,
      embedding: null,
    };

    const previous = byNorm.get(norm);
    if (!previous) {
      idSeq += 1;
      byNorm.set(norm, candidate);
      continue;
    }
    if (candidate.importance > previous.importance) {
      previous.kind = candidate.kind;
      previous.tags = candidate.tags;
      previous.importance = candidate.importance;
    }
  }

  const cards = [...byNorm.values()];

  if (embeddingProfile && typeof embeddingProfile === 'object' && cards.length > 0) {
    for (const card of cards) {
      if (signal && signal.aborted) break;
      try {
        const vector = await llm.embeddings({ profile: embeddingProfile, input: card.text, signal });
        if (Array.isArray(vector) && vector.length > 0 && vector.every((value) => Number.isFinite(value))) {
          card.embedding = vector;
        }
      } catch {
        // 单条失败只影响这一条，不阻断其他卡片
      }
    }
  }

  return cards;
}

// ---------- 裁剪 ----------

/**
 * 卡片数量上限：超出时淘汰「低重要度 + 最久未命中（updatedAt 最旧）」。
 * @returns {Card[]} 保留原顺序的新数组
 */
function prune(cards, limit = DEFAULT_LIMIT) {
  const registry = suppressedOf(cards);
  const list = cardsOf(cards).filter(isCard);
  const max = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_LIMIT;
  if (list.length <= max) return withSuppressed(list, registry);

  const ranked = list.map((card, index) => ({
    index,
    importance: normalizeImportance(card.importance),
    lastTouched: stampOf(card.updatedAt) !== null ? stampOf(card.updatedAt) : (stampOf(card.createdAt) || 0),
    hits: hitsOf(card),
  }));
  ranked.sort((a, b) => (b.importance - a.importance)
    || (b.lastTouched - a.lastTouched)
    || (b.hits - a.hits)
    || (a.index - b.index));

  const keep = new Set(ranked.slice(0, max).map((item) => item.index));
  return withSuppressed(list.filter((card, index) => keep.has(index)), registry);
}

module.exports = {
  normalizeText,
  similarity,
  isSameTopic,
  polarity,
  containment,
  scoreCard,
  retrieve,
  mergeCards,
  extractFromChat,
  prune,
  suppress,
  suppressedOf,
  attachSuppressed,
  // 便于其他模块/测试复用
  parseCards,
  normalizeImportance,
  MERGE_THRESHOLD,
  SUPPRESS_DAYS,
  MAX_VARIANTS,
  MAX_CARD_CHARS,
  CARD_HEAD_CHARS,
  CARD_TAIL_CHARS,
  TRUNCATE_MARKER,
  MAX_PARSE_BYTES,
  MAX_PARSE_CANDIDATES,
  MAX_PARSE_DEPTH,
  TIME_WORDS,
};
