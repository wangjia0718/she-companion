'use strict';

// 提示词装配与字符预算裁剪（Spec 9 / 计划 Task 4）。
// 只用 Node 标准库；CommonJS。
//
// 约定：
// - Message 形状与 llm.js 一致：{ role, content }。
// - 装配出的消息额外带「不可枚举」的记账字段（pinned / kind / meta）：
//   这样既能让本模块与调用方读到裁剪信息，又不会被 JSON.stringify 发到模型 API，
//   避免上游因不认识 pinned 之类的字段而报 400。
// - 所有裁剪都返回新数组、新消息对象，不改动入参。
// - 预算按「字符数」计（estimateChars，按 Unicode 码点计数：中文标点、换行各算 1，
//   emoji 算 1 而不是 2）。
// - 截断按「字素簇」边界切（Intl.Segmenter，缺该 API 时回退码点）：
//   不会把代理对、ZWJ 家庭、肤色修饰符、VS16 等组合 emoji 切成半个。
//
// 预算不足时的行为（明确约定，不抛错）：
//   pinned 块（人格、输出约束）永不裁剪；若 budgetChars 小到连它们都放不下，
//   则返回「仅人格 + 此刻 + 截断后的用户输入 + 输出约束」的结果，字符数允许超预算，
//   此时在返回的数组上设「可枚举」的 `overflow === true`（并保留不可枚举的
//   `budgetOverflow` 供旧调用方判断），供调用方记录/告警。

const personaModule = require('./persona');
const stateModule = require('./state');
const projectsModule = require('./projects');
const i18n = require('./i18n');

/** 生成内容的输出语言：仅英文模式附加规则（中文提示词本身就是中文，不需要额外约束） */
function languageRule() {
  if (i18n.getLanguage() === 'en') {
    return '【语言】所有面向用户的文本必须使用自然、口语化的英文；人名、书名等专有名词可保留原文。不要输出中文。';
  }
  return '';
}

function withLanguage(text) {
  const body = typeof text === 'string' ? text : '';
  const rule = languageRule();
  return rule ? `${body}\n\n${rule}` : body;
}

const DEFAULT_BUDGET_CHARS = 12000;
const SHORT_TERM_TURNS = 12;
const RECALL_TOP_K = 12;
const MAX_EXISTING_CARDS = 60;
const TRUNCATE_MARKER = '…（内容过长已截断）';
const DEFAULT_DROP_ORDER = ['memory', 'history', 'schedule'];

const MEMORY_HEADER = '【记忆】你记得下面这些事。只在自然相关时提起，不要一次全说出来，也不要照着念。';
const MEMORY_KIND_LABELS = {
  fact: '事实',
  preference: '偏好',
  event: '事件',
  relation: '关系',
};

const CONSTRAINT_TEXT = [
  '【输出要求】',
  '- 只回 1–3 句，口语一点，像平时聊天。',
  '- 不用列表和标题，不要 Markdown、编号、括号补充。',
  '- 不编造用户经历，也不编造没发生过的事。',
  '- 保持地点和动作连续：不凭空换地方，要移动先交代过渡（如「从阳台回屋」）。',
  '- 不确定就反问，别装懂。',
  '- 不复述设定，也别解释这些规则。',
].join('\n');

// P3：只有她状态明显低时才注入这条，避免平时把回复压得过于冷淡
const LOW_STATE_RULE = '- 如果她现在很累或心情不好，回复更短、更安静，不要强行热情。';

function constraintTextFor(state) {
  const s = stateModule.normalizeState(state);
  return s.energy < 35 || s.mood < 35
    ? `${CONSTRAINT_TEXT}\n${LOW_STATE_RULE}`
    : CONSTRAINT_TEXT;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// ---------- 基础工具 ----------

/** 在消息上挂不可枚举的记账字段（不会进入 API 请求体） */
function decorate(message, { pinned = false, kind, meta } = {}) {
  const fields = { pinned: pinned === true };
  if (typeof kind === 'string' && kind) fields.kind = kind;
  if (meta && typeof meta === 'object') fields.meta = meta;
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(message, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return message;
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }
  const text = clean(value);
  return text ? [text] : [];
}

function charLength(text) {
  return Array.from(text).length;
}

/**
 * 估算消息的字符总量（只算正文，按 Unicode 码点计）。
 * @param {Array<{role: string, content: any}>} messages
 * @returns {number}
 */
function estimateChars(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, message) => {
    if (!message || typeof message !== 'object') return sum;
    return sum + charLength(contentText(message.content));
  }, 0);
}

function toDate(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
  if (typeof now === 'number' || typeof now === 'string') {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function clockOf(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatNow(now) {
  const date = toDate(now);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${clockOf(date)}（${WEEKDAYS[date.getDay()]}，${periodOf(date)}）`;
}

/** 时段词：给提示词一个「现在是什么时候」的锚点，避免下午说「今晚」 */
function periodOf(date) {
  const hour = date.getHours();
  if (hour < 5) return '凌晨';
  if (hour < 9) return '早上';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 17) return '下午';
  if (hour < 19) return '傍晚';
  if (hour < 23) return '晚上';
  return '深夜';
}

function timeValue(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** 按字素簇切分；Node 缺 Intl.Segmenter 时退回按码点切 */
let graphemeSegmenter = null;
let graphemeSegmenterReady = false;

function segmentGraphemes(text) {
  const source = contentText(text);
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
    const segments = [];
    for (const part of graphemeSegmenter.segment(source)) segments.push(part.segment);
    return segments;
  }
  return Array.from(source);
}

/** 组合符：ZWJ、肤色修饰符、VS15/VS16（落在切口边缘说明切进了字素簇） */
function isContinuationCodePoint(codePoint) {
  return codePoint === 0x200d
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
    || codePoint === 0xfe0f
    || codePoint === 0xfe0e;
}

function endsWithContinuation(cluster) {
  const points = Array.from(cluster);
  if (points.length === 0) return false;
  return isContinuationCodePoint(points[points.length - 1].codePointAt(0));
}

function startsWithContinuation(cluster) {
  const points = Array.from(cluster);
  if (points.length === 0) return false;
  return isContinuationCodePoint(points[0].codePointAt(0));
}

/** 从头取若干字素簇，累计码点数不超过 budget */
function takeHeadClusters(clusters, budget) {
  let used = 0;
  const kept = [];
  for (const cluster of clusters) {
    const size = charLength(cluster);
    if (used + size > budget) break;
    kept.push(cluster);
    used += size;
  }
  // 保守处理：头部不以组合符结尾（宁可少留一个完整 emoji，也不把修饰符留在切口上）
  while (kept.length > 0 && endsWithContinuation(kept[kept.length - 1])) kept.pop();
  return kept.join('');
}

/** 从尾取若干字素簇，累计码点数不超过 budget */
function takeTailClusters(clusters, budget) {
  let used = 0;
  const kept = [];
  for (let i = clusters.length - 1; i >= 0; i -= 1) {
    const size = charLength(clusters[i]);
    if (used + size > budget) break;
    kept.push(clusters[i]);
    used += size;
  }
  kept.reverse();
  while (kept.length > 0 && startsWithContinuation(kept[0])) kept.shift();
  return kept.join('');
}

/**
 * 中间截断：保留前 60% 与后 30%，中间插标记，总码点数不超过 maxChars。
 * 切口对齐字素簇边界，组合 emoji（👨‍👩‍👧‍👦 / 👍🏽 / ❤️ / 🏳️‍🌈）不会被劈开。
 */
function truncateMiddle(text, maxChars) {
  const source = contentText(text);
  const limit = Math.max(0, Math.floor(maxChars));
  if (charLength(source) <= limit) return source;

  const markerChars = charLength(TRUNCATE_MARKER);
  const clusters = segmentGraphemes(source);
  if (limit <= markerChars) return takeHeadClusters(clusters, limit);

  const keep = limit - markerChars;
  const headBudget = Math.floor(keep * 0.6);
  const tailBudget = Math.floor(keep * 0.3);
  return takeHeadClusters(clusters, headBudget)
    + TRUNCATE_MARKER
    + takeTailClusters(clusters, tailBudget);
}

// ---------- 人格块 ----------

function personaText(character) {
  const c = character && typeof character === 'object' ? character : {};
  const persona = c.persona && typeof c.persona === 'object' ? c.persona : {};
  const life = c.life && typeof c.life === 'object' ? c.life : {};
  const name = clean(c.name) || '她';

  const lines = [`你现在是「${name}」，用第一人称和对面的人说话。`];
  const field = (label, items) => {
    if (items.length > 0) lines.push(`【${label}】${items.join('、')}`);
  };

  field('性格', asList(persona.traits));
  field('说话', asList(persona.speechStyle));
  field('口癖', asList(persona.catchphrases));
  field('背景', asList(persona.background));
  field('关系', asList(persona.relationship));
  const boundaries = asList(persona.boundaries);
  if (boundaries.length > 0) lines.push(`【边界】${boundaries.join('；')}`);
  field('喜欢', asList(persona.likes));
  field('不喜欢', asList(persona.dislikes));
  field('说话习惯', asList(persona.speechHabits));
  if (asList(persona.speechExamples).length > 0) {
    lines.push(`【说话样例】${asList(persona.speechExamples).map((item) => `「${item}」`).join('')}`);
  }

  // 内在设定（P1）：只注入 traits / boundaries；zodiac 永不进提示词。
  const inner = persona.inner && typeof persona.inner === 'object' ? persona.inner : {};
  const innerTraits = asList(inner.traits).filter((item) => !personaModule.hasZodiacWord(item));
  const innerBoundaries = asList(inner.boundaries).filter((item) => !personaModule.hasZodiacWord(item));
  const innerParts = [];
  if (innerTraits.length > 0) innerParts.push(innerTraits.join('；'));
  if (innerBoundaries.length > 0) innerParts.push(innerBoundaries.join('；'));
  if (innerParts.length > 0) lines.push(`【内在】${innerParts.join('；')}`);

  const lifeParts = [
    clean(life.city),
    clean(life.home),
    clean(life.occupation),
    asList(life.hobbies).join('、'),
    clean(life.tone),
  ].filter(Boolean);
  if (lifeParts.length > 0) lines.push(`【生活】${lifeParts.join('；')}`);

  // 生活事实（家庭 / 宠物 / 身体 / 经历）：让她能自然地聊起真实背景
  field('经历', asList(life.career));
  field('家人', asList(life.family));
  field('宠物', asList(life.pets));
  field('身体', asList(life.health));

  lines.push('保持这个人设，不要自我介绍，也不要复述上面的设定。');
  lines.push('如果对方问起你的生日，可以按设定回答；不要主动提起。');
  return lines.join('\n');
}

// ---------- 此刻块 ----------

function normalizeSchedule(today) {
  const raw = Array.isArray(today)
    ? today
    : today && typeof today === 'object' && Array.isArray(today.schedule)
      ? today.schedule
      : [];
  const schedule = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const time = clean(item.time);
    const activity = clean(item.activity);
    if (!/^\d{2}:\d{2}$/.test(time) || !activity) continue;
    schedule.push({ time, activity });
  }
  schedule.sort((a, b) => a.time.localeCompare(b.time));
  return schedule;
}

function normalizeEvents(today) {
  const raw = today && typeof today === 'object' && Array.isArray(today.events) ? today.events : [];
  const events = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = clean(item.text);
    if (!text) continue;
    events.push({ time: clean(item.time), text });
  }
  events.sort((a, b) => a.time.localeCompare(b.time));
  return events;
}

/** 当前日程条目下标：最后一个 time <= 现在的；都还没到就用第一条 */
function currentScheduleIndex(schedule, now) {
  if (schedule.length === 0) return -1;
  const clock = clockOf(toDate(now));
  let index = 0;
  for (let i = 0; i < schedule.length; i += 1) {
    if (schedule[i].time <= clock) index = i;
  }
  return index;
}

function currentActivityLine(today, schedule, now) {
  const clock = clockOf(toDate(now));
  const events = normalizeEvents(today);
  let latest = null;
  for (const event of events) {
    if (!event.time || event.time <= clock) latest = event;
  }
  if (!latest && events.length > 0) latest = events[events.length - 1];
  if (latest) return `她正在做什么：${latest.text}`;

  if (schedule.length > 0) {
    const index = currentScheduleIndex(schedule, now);
    return `她正在做什么：${schedule[index].activity}`;
  }
  return '她正在做什么：在家待着，没什么特别的事。';
}

function composeMoment(meta) {
  const parts = [meta.header, meta.activityLine];
  if (meta.placeLine) parts.push(meta.placeLine);
  if (meta.projectLine) parts.push(meta.projectLine);
  if (meta.stateLine) parts.push(meta.stateLine);
  if (Array.isArray(meta.scheduleLines) && meta.scheduleLines.length > 0) {
    parts.push(`今日日程：\n${meta.scheduleLines.join('\n')}`);
  }
  return parts.join('\n');
}

/** 进行中的长期项目一句话（P5）；没有项目返回空串 */
function activeProjectLine(character) {
  const life = character && typeof character === 'object' && character.life
    ? character.life
    : {};
  const project = projectsModule.activeProject(life.projects);
  return project ? `她手上在做：${projectsModule.projectLine(project)}` : '';
}

/**
 * 「此刻」块：时间 + 正在做什么 + 她的状态（P3，只给一句中文，不出现数值）。
 * @param {object|Array|null} today
 * @param {Date|string|number} now
 * @param {object} [state] 角色状态；不传就不加状态行（兼容旧调用）
 * @param {object} [character] 角色；有进行中的长期项目时多一行「她手上在做」
 */
function makeMomentMessage(today, now, state, character, lastAssistant) {
  const schedule = normalizeSchedule(today);
  const scheduleLines = schedule.map((item) => `- ${item.time} ${item.activity}`);
  const meta = {
    header: `【此刻】现在是 ${formatNow(now)}。`,
    activityLine: currentActivityLine(today, schedule, now),
    scheduleLines,
    currentScheduleIndex: currentScheduleIndex(schedule, now),
  };
  const projectLine = activeProjectLine(character);
  if (projectLine) meta.projectLine = projectLine;
  if (state && typeof state === 'object') {
    meta.stateLine = `她现在：${stateModule.describeState(state)}`;
  }
  // 位置锚点：她自己在最近一条消息里说过的地方，比日程更「当下」
  if (lastAssistant && typeof lastAssistant === 'object') {
    const place = extractPlace(lastAssistant.text);
    if (place) {
      const rel = relativePhrase(lastAssistant.ts, now);
      const when = rel ? `（${rel.text === '刚刚' ? '刚刚' : rel.text}你自己说的）` : '';
      meta.placeLine = `你现在在${place}${when}，这一点以这里为准；除非你说明移动，否则不要换地方。`;
    }
  }
  const message = { role: 'system', content: composeMoment(meta) };
  decorate(message, { kind: 'moment', meta });
  return message;
}

// ---------- 记忆块 ----------

function priorityOf(card) {
  if (!card || typeof card !== 'object') return 0;
  if (Number.isFinite(card.score)) return card.score;
  if (Number.isFinite(card.importance)) return card.importance;
  return 1;
}

function normalizeMemories(memories, topK = RECALL_TOP_K) {
  const limit = Number.isFinite(topK) && topK >= 0 ? Math.floor(topK) : RECALL_TOP_K;
  const list = Array.isArray(memories) ? memories : [];
  const cards = [];
  for (const card of list) {
    if (!card || typeof card !== 'object') continue;
    const text = clean(card.text);
    if (!text) continue;
    const kind = typeof card.kind === 'string' && MEMORY_KIND_LABELS[card.kind] ? card.kind : 'fact';
    cards.push({
      label: MEMORY_KIND_LABELS[kind],
      text,
      priority: priorityOf(card),
      createdAt: timeValue(card.createdAt),
    });
  }
  // 先按分数取 Top K，再按时间线正序排进上下文
  cards.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt);
  const top = cards.slice(0, limit);
  top.sort((a, b) => a.createdAt - b.createdAt);
  return top;
}

function memoryLine(card) {
  return `- [${card.label}] ${card.text}`;
}

function rebuildMemory(message) {
  const items = message.meta && Array.isArray(message.meta.items) ? message.meta.items : [];
  message.content = items.length > 0
    ? `${message.meta.header}\n${items.map((item) => item.line).join('\n')}`
    : '';
}

function makeMemoryMessage(memories, topK = RECALL_TOP_K) {
  const cards = normalizeMemories(memories, topK);
  if (cards.length === 0) return null;
  const message = { role: 'system', content: '' };
  decorate(message, {
    kind: 'memory',
    meta: {
      header: MEMORY_HEADER,
      items: cards.map((card) => ({ line: memoryLine(card), priority: card.priority })),
    },
  });
  rebuildMemory(message);
  return message;
}

// ---------- 历史对话 ----------

function normalizeHistory(history) {
  const list = Array.isArray(history) ? history : [];
  const entries = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
    if (role !== 'user' && role !== 'assistant') continue;
    const text = contentText(item.text !== undefined ? item.text : item.content);
    if (!text.trim()) continue;
    entries.push({ role, content: text, ts: item.ts || item.time || null });
  }
  return entries;
}

/**
 * 历史消息的时间戳：绝对时间 + 相对时间一起给。
 * - 同一天：[16:30，3 分钟前]
 * - 昨天：[昨天 16:30]
 * - 更早：[10-28 16:30]
 * 纯绝对时间模型不会算「刚刚」，纯相对时间会丢时段信息。
 */
function momentStamp(ts, now) {
  const rel = relativePhrase(ts, now);
  if (!rel) return '';
  const then = new Date(ts);
  const hm = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  return rel.label === 'absolute' ? rel.text : `[${hm}，${rel.text}]`;
}

/** 相对时间短语（不带括号）：刚刚 / 3 分钟前 / 2 小时前；跨天返回 absolute + 文本 */
function relativePhrase(ts, now) {
  if (!ts) return null;
  const then = new Date(ts);
  if (Number.isNaN(then.getTime())) return null;
  const current = toDate(now);
  const hm = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  const sameDay = then.getFullYear() === current.getFullYear()
    && then.getMonth() === current.getMonth()
    && then.getDate() === current.getDate();
  if (!sameDay) {
    const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
    const isYesterday = then.getFullYear() === yesterday.getFullYear()
      && then.getMonth() === yesterday.getMonth()
      && then.getDate() === yesterday.getDate();
    return { label: 'absolute', text: isYesterday ? `昨天 ${hm}` : `${pad2(then.getMonth() + 1)}-${pad2(then.getDate())} ${hm}` };
  }
  const minutes = Math.max(0, Math.round((current.getTime() - then.getTime()) / 60000));
  if (minutes < 1) return { label: 'relative', text: '刚刚' };
  if (minutes >= 60) return { label: 'relative', text: `${Math.round(minutes / 60)} 小时前` };
  return { label: 'relative', text: `${minutes} 分钟前` };
}

/**
 * 按「轮」分组：每条 user 开一轮，随后连续的 assistant 归入该轮；
 * 开头孤立的 assistant 自成一组。角色交替错乱时按原样保留，不做重排或合并。
 */
function groupRounds(entries) {
  const rounds = [];
  let current = null;
  for (const entry of entries) {
    if (entry.role === 'user') {
      current = [entry];
      rounds.push(current);
    } else if (current) {
      current.push(entry);
    } else {
      current = [entry];
      rounds.push(current);
    }
  }
  return rounds;
}

function historyMessages(history, shortTermTurns = SHORT_TERM_TURNS, now = new Date()) {
  const turns = Number.isFinite(shortTermTurns) && shortTermTurns > 0
    ? Math.floor(shortTermTurns)
    : SHORT_TERM_TURNS;
  const rounds = groupRounds(normalizeHistory(history)).slice(-turns);
  const messages = [];
  rounds.forEach((round, group) => {
    for (const entry of round) {
      const stamp = momentStamp(entry.ts, now);
      const message = {
        role: entry.role,
        content: stamp ? `${stamp} ${entry.content}` : entry.content,
      };
      decorate(message, { kind: 'history', meta: { group } });
      messages.push(message);
    }
  });
  return messages;
}

// ---------- 各场景提示词 ----------

/**
 * 聊天主提示词（Spec 9 顺序）。
 * @param {{ character?: object, memories?: object[], today?: object, history?: object[],
 *           userText?: string, now?: Date|string|number, budgetChars?: number,
 *           topK?: number, shortTermTurns?: number, state?: object }} input
 *   topK：记忆卡上限（对应 settings.memory.recallTopK，默认 12）
 *   shortTermTurns：近期对话轮数（对应 settings.memory.shortTermTurns，默认 12）
 *   state：角色当前状态（P3）；传入时「此刻」块多一行状态，低状态时追加一条语气规则
 * @returns {Array<{role: string, content: string}>}
 */
function buildChatMessages({
  character, memories, today, history, userText, now, budgetChars = DEFAULT_BUDGET_CHARS,
  topK = RECALL_TOP_K, shortTermTurns = SHORT_TERM_TURNS, state,
} = {}) {
  const messages = [];
  messages.push(decorate(
    { role: 'system', content: personaText(character) },
    { pinned: true, kind: 'persona' },
  ));
  const lastAssistant = (() => {
    const list = Array.isArray(history) ? history : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      if (!item || item.role !== 'assistant') continue;
      const text = contentText(item.text !== undefined ? item.text : item.content);
      if (text) return { text, ts: item.ts || null };
    }
    return null;
  })();
  messages.push(makeMomentMessage(today, now, state, character, lastAssistant));

  const memoryMessage = makeMemoryMessage(memories, topK);
  if (memoryMessage) messages.push(memoryMessage);

  messages.push(...historyMessages(history, shortTermTurns, now));

  messages.push(decorate(
    { role: 'user', content: contentText(userText) },
    { kind: 'user' },
  ));

  messages.push(decorate(
    { role: 'system', content: withLanguage(state ? constraintTextFor(state) : CONSTRAINT_TEXT) },
    { pinned: true, kind: 'constraint' },
  ));

  return trimToBudget(messages, budgetChars);
}

/** 常见地点词（用于「你现在在哪」的锚点与冲突检测） */
const PLACE_WORDS = [
  '阳台', '窗边', '窗前', '厨房', '客厅', '卧室', '浴室', '沙发', '床上', '书桌',
  '门口', '玄关', '楼下', '小区', '街上', '街角', '书店', '咖啡馆', '咖啡店',
  '便利店', '超市', '公园', '地铁', '公交车', '公司', '办公室', '路上', '画室', '店里',
];

// 表示「确实移动了」的词。注意不收「回来/回到」——「刚回来」本身可能就是凭空编的
const PLACE_TRANSITION = /(回屋|进屋|出门|下楼|上楼|走到|走去|去了|去到|到了|路过|拐进|起身|从.{1,6}(出|回|下|上))/u;

function extractPlace(text) {
  const value = contentText(text);
  for (const word of PLACE_WORDS) {
    if (value.includes(word)) return word;
  }
  return '';
}

/** 回复里的地点是否和「刚才待的地方」冲突（换地方却没交代过渡） */
function placeConflict(text, place) {
  if (!place) return false;
  const value = contentText(text);
  const mentioned = extractPlace(value);
  if (!mentioned || mentioned === place) return false;
  return !PLACE_TRANSITION.test(value);
}

function transcriptLines(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const lines = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
    if (role !== 'user' && role !== 'assistant') continue;
    const text = contentText(item.text !== undefined ? item.text : item.content).trim();
    if (!text) continue;
    lines.push(`${role === 'user' ? '用户' : '她'}：${text}`);
  }
  return lines;
}

const PROACTIVE_CONTEXT_MESSAGES = 10;
const PROACTIVE_CONTEXT_CHARS = 120;

function clipContextText(text, max = PROACTIVE_CONTEXT_CHARS) {
  const value = clean(text).replace(/\s+/gu, ' ');
  if (!value) return '';
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * 主动消息的最近对话：带时间、带说话人，按时间正序。
 * 这是「她已经说过什么」的唯一来源；没有它，模型只能靠记忆卡重新编。
 */
function proactiveTranscriptLines(messages, now, limit = PROACTIVE_CONTEXT_MESSAGES) {
  const list = Array.isArray(messages) ? messages : [];
  const lines = [];
  for (const item of list.slice(-limit)) {
    if (!item || typeof item !== 'object') continue;
    const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
    if (role !== 'user' && role !== 'assistant') continue;
    const text = clipContextText(contentText(item.text !== undefined ? item.text : item.content));
    if (!text) continue;
    const stamp = momentStamp(item.ts || item.time, now);
    lines.push(`- ${stamp ? `${stamp} ` : ''}${role === 'user' ? '对方' : '你'}：${text}`);
  }
  return lines;
}

/** 从最近对话里取最后一条她自己的消息（保持地点 / 动作连续） */
function lastAssistantOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (!item || item.role !== 'assistant') continue;
    const text = contentText(item.text !== undefined ? item.text : item.content);
    if (text.trim()) return { text, ts: item.ts || item.time || null };
  }
  return null;
}

/** 从最近对话里取最后一条对方消息 */
function lastUserOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (!item || item.role !== 'user') continue;
    const text = contentText(item.text !== undefined ? item.text : item.content);
    if (text.trim()) return text;
  }
  return '';
}

/** 角色明确不喜欢 / 不要提到的话题（life.avoidTopics），给生成用 */
function avoidTopicText(character) {
  const life = character && typeof character === 'object' && character.life
    ? character.life
    : {};
  const list = asList(life.avoidTopics).map((item) => clean(item)).filter(Boolean);
  return list.join('、');
}

function characterBrief(character) {
  const c = character && typeof character === 'object' ? character : {};
  const persona = c.persona && typeof c.persona === 'object' ? c.persona : {};
  const life = c.life && typeof c.life === 'object' ? c.life : {};
  const parts = [`名字：${clean(c.name) || '她'}`];
  const traits = asList(persona.traits);
  if (traits.length) parts.push(`性格：${traits.join('、')}`);
  const speech = asList(persona.speechStyle);
  if (speech.length) parts.push(`说话风格：${speech.join('、')}`);
  const background = clean(persona.background);
  if (background) parts.push(`背景：${background}`);
  const inner = persona.inner && typeof persona.inner === 'object' ? persona.inner : {};
  if (inner.profile && typeof inner.profile === 'object') {
    parts.push(`五维：${personaModule.profileSummary(inner.profile)}`);
  }
  const innerTraits = asList(inner.traits).filter((item) => !personaModule.hasZodiacWord(item));
  if (innerTraits.length > 0) parts.push(`内在：${innerTraits.join('；')}`);
  if (clean(life.city)) parts.push(`城市：${clean(life.city)}`);
  if (clean(life.home)) parts.push(`住处：${clean(life.home)}`);
  if (clean(life.occupation)) parts.push(`职业：${clean(life.occupation)}`);
  const hobbies = asList(life.hobbies);
  if (hobbies.length) parts.push(`爱好：${hobbies.join('、')}`);
  const career = asList(life.career);
  if (career.length) parts.push(`经历：${career.join('；')}`);
  const pets = asList(life.pets);
  if (pets.length) parts.push(`宠物：${pets.join('；')}`);
  const family = asList(life.family);
  if (family.length) parts.push(`家人：${family.join('；')}`);
  if (clean(life.activeFrom) && clean(life.activeTo)) {
    parts.push(`作息：常在 ${clean(life.activeFrom)}–${clean(life.activeTo)} 活动，早上起得晚`);
  }
  return parts.join('；');
}

/** 记忆抽取：只输出 JSON 数组，并带上已有卡片摘要 */
function buildExtractMessages({ character, messages, existingCards } = {}) {
  const system = [
    '你是记忆整理器，负责把对话里值得长期记住的信息写成记忆卡。',
    '只输出 JSON 数组，不要输出任何解释、前缀、Markdown 或代码围栏。',
    i18n.getLanguage() === 'en'
      ? '元素格式：{"kind":"fact|preference|event|relation","text":"一句英文，用第三人称写用户","importance":1-5}。'
      : '元素格式：{"kind":"fact|preference|event|relation","text":"一句中文，用第三人称写用户","importance":1-5}。',
    '只记录用户说过的事实、偏好、重要事件与关系；不记寒暄、不推测；没有可记的就输出 []。',
  ].join('\n');

  const existing = (Array.isArray(existingCards) ? existingCards : [])
    .filter((card) => card && typeof card === 'object' && clean(card.text))
    .slice(0, MAX_EXISTING_CARDS)
    .map((card) => {
      const id = clean(card.id) || '?';
      const label = MEMORY_KIND_LABELS[card.kind] || '记录';
      return `- [${id}] [${label}] ${clean(card.text)}`;
    });

  const body = [
    `【角色】${characterBrief(character)}`,
    '【已有记忆卡】',
    existing.length > 0 ? existing.join('\n') : '（暂无）',
    '【待整理的对话】',
    transcriptLines(messages).join('\n') || '（没有新对话）',
  ].join('\n');

  return [
    { role: 'system', content: withLanguage(system) },
    { role: 'user', content: body },
  ];
}

/** 内在设定生成：只输出 JSON 对象 {traits:[], boundaries:[]}（P1） */
function buildInnerMessages({
  character, zodiac, profile, traits,
} = {}) {
  const c = character && typeof character === 'object' ? character : {};
  const name = clean(c.name) || '她';
  const life = c.life && typeof c.life === 'object' ? c.life : {};
  const birthday = c.persona && typeof c.persona === 'object' && c.persona.birthday
    ? c.persona.birthday
    : {};

  const birthdayText = birthday && (birthday.month || birthday.day)
    ? `${clean(String(birthday.year || '')) || '（年份不详）'}-${pad2(Number(birthday.month) || 0)}-${pad2(Number(birthday.day) || 0)}`
    : '（未填）';

  const system = [
    `你在为「${name}」整理内在设定。`,
    '只输出 JSON 对象，不要解释、Markdown 或代码围栏。',
    '格式：{"traits":["..."],"boundaries":["..."]}',
    'traits 5–8 条：每条一句具体行为描述（她平时怎么做、遇到什么事会怎么反应），不要只堆形容词。',
    'boundaries 2–4 条：写她不会主动做的事。',
    '不要在输出里出现星座名，也不要出现「星座」「生肖」「运势」这类词。',
  ].join('\n');

  const reference = asList(traits)
    .filter((item) => !personaModule.hasZodiacWord(item))
    .slice(0, 8);

  const user = [
    `生日：${birthdayText}（阳历）`,
    `五维：${personaModule.profileSummary(profile)}`,
    characterBrief(c),
    clean(life.tone) ? `生活基调：${clean(life.tone)}` : '',
    reference.length > 0 ? `参考行为（可改写，别原样照抄）：\n- ${reference.join('\n- ')}` : '',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: withLanguage(system) },
    { role: 'user', content: user },
  ];
}

/** 每日日程：只输出 JSON 数组，3–5 条 HH:MM */
function weekdayOfDate(date, fallback) {
  const text = clean(date);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isNaN(d.getTime())) return { date: d, weekday: WEEKDAYS[d.getDay()], weekend: d.getDay() === 0 || d.getDay() === 6 };
  }
  const d = toDate(fallback);
  return { date: d, weekday: WEEKDAYS[d.getDay()], weekend: d.getDay() === 0 || d.getDay() === 6 };
}

function buildScheduleMessages({ character, date, now, recent } = {}) {
  const info = weekdayOfDate(date, now);
  const dayLabel = clean(date) || `${info.date.getFullYear()}-${pad2(info.date.getMonth() + 1)}-${pad2(info.date.getDate())}`;
  const dayType = info.weekend ? '周末' : '工作日';

  const system = [
    '你在为角色安排一天的生活日程。',
    '只输出 JSON 数组，不要解释、Markdown 或代码围栏。',
    '格式：[{"time":"08:30","activity":"做早饭，煎蛋和吐司"}]',
    '要求：3–5 条；time 为 HH:MM，落在 06:00–23:59，按时间升序；activity 一句话，具体可感。',
    '日程要贴合角色的城市、住处、职业与爱好，不要排得太满。',
    '每天要有变化：最多保留 1 条固定习惯（例如早饭），其余安排至少 2 条和最近几天不同，时间也允许浮动。',
    '工作日和周末形态不同：周末可以睡懒觉、出门逛逛、见朋友或做爱好；工作日更贴近职业节奏。',
  ].join('\n');

  const recentLines = (Array.isArray(recent) ? recent : [])
    .filter((item) => item && typeof item === 'object')
    .slice(0, 3)
    .map((item) => {
      const schedule = Array.isArray(item.schedule) ? item.schedule : [];
      const items = schedule
        .map((row) => (row && typeof row === 'object' ? `${clean(row.time)} ${clean(row.activity)}`.trim() : ''))
        .filter(Boolean)
        .join('；');
      return items ? `- ${clean(item.date)}：${items}` : '';
    })
    .filter(Boolean);

  const user = [
    `日期：${dayLabel}（${info.weekday}，${dayType}）`,
    characterBrief(character),
    recentLines.length > 0 ? `【最近几天】\n${recentLines.join('\n')}\n请避开这些安排，换点不一样的。` : '【最近几天】暂无记录。',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: withLanguage(system) },
    { role: 'user', content: user },
  ];
}

/**
 * 当天的小意外：必须结合今天的日程 / 天气 / 状态，不再从固定清单里抽。
 * 模型可以返回空，表示今天不需要小意外。
 * @param {{ character?: object, schedule?: object[], context?: object, recentDiscoveries?: string[] }} [input]
 * @returns {Array<{role: string, content: string}>}
 */
function buildDiscoveryMessages({
  character, schedule, context, recentDiscoveries,
} = {}) {
  const c = isPlainObject(character) ? character : {};
  const ctx = isPlainObject(context) ? context : {};
  const rows = (Array.isArray(schedule) ? schedule : [])
    .filter((row) => isPlainObject(row))
    .map((row) => ({ time: clean(row.time), activity: clean(row.activity) }))
    .filter((row) => row.time && row.activity);
  const weather = isPlainObject(ctx.weather) ? ctx.weather : null;
  const weatherText = weather
    ? (clean(weather.label) || WEATHER_CODE_LABELS[clean(weather.code)] || clean(weather.code))
    : '';
  const stateText = isPlainObject(ctx.state) ? stateModule.describeState(ctx.state) : '';

  const system = [
    '你负责给她今天加一件很小的意外。',
    '这件小事必须和今天的日程、天气或她的状态有具体关系；不能写和日程无关的固定句子，不能写大事。',
    '不要拿今天日程里的某一项接着写：日程里做了 A，就不要写「做 A 时……」，也不要把同一件事再说一遍；小意外要独立发生。',
    '只输出一行，20–40 个字，像随手发生的一件小事；不要写她主动联系用户。',
    '如果今天不适合有小意外，就输出空，不要硬编。',
    '天气是当天的概况：不要写成「此刻正在下 / 刚刚停」这类实时判断，也不要写具体小时。',
    '不要输出解释、引号、JSON、Markdown 或代码围栏。',
  ].join('\n');

  const scheduleLines = rows.map(
    (row, index) => `${index + 1}. ${row.time} ${row.activity}`,
  );
  const recent = (Array.isArray(recentDiscoveries) ? recentDiscoveries : [])
    .map((text) => clean(text))
    .filter(Boolean)
    .slice(0, 10);

  const user = [
    clean(ctx.date) ? `日期：${clean(ctx.date)}` : '',
    `角色：${characterBrief(c)}`,
    weatherText ? `天气：${weatherText}` : '',
    clean(ctx.holiday && ctx.holiday.name) ? `节日：${clean(ctx.holiday.name)}` : '',
    clean(ctx.term) ? `节气：${clean(ctx.term)}` : '',
    stateText ? `她现在的状态：${stateText}` : '',
    '今天的日程：',
    scheduleLines.length > 0 ? scheduleLines.join('\n') : '（暂无）',
    recent.length > 0 ? `最近出现过的小意外（不要重复）：\n${recent.map((text) => `- ${text}`).join('\n')}` : '',
    '请判断今天是否适合有一件小意外。适合就只输出一行具体的小事；不适合就输出空。',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: withLanguage(system) },
    { role: 'user', content: user },
  ];
}

const WEATHER_CODE_LABELS = {
  clear: '晴', cloudy: '多云', fog: '雾', rain: '雨', snow: '雪', shower: '阵雨', thunder: '雷雨',
};

/**
 * 当天日程的「具体小动作细节」：按日程逐条由模型生成，不再从固定文案池里挑。
 * 只输出 JSON 数组，元素与日程一一对应；最近用过的细节作为禁止重复项传入。
 * @param {{ character?: object, schedule?: object[], recentDetails?: string[], context?: object }} [input]
 * @returns {Array<{role: string, content: string}>}
 */
function buildDetailMessages({
  character, schedule, recentDetails, context,
} = {}) {
  const c = isPlainObject(character) ? character : {};
  const ctx = isPlainObject(context) ? context : {};
  const rows = (Array.isArray(schedule) ? schedule : [])
    .filter((row) => isPlainObject(row))
    .map((row) => ({ time: clean(row.time), activity: clean(row.activity) }))
    .filter((row) => row.time && row.activity);
  const weather = isPlainObject(ctx.weather) ? ctx.weather : null;
  const weatherText = weather
    ? (clean(weather.label) || WEATHER_CODE_LABELS[clean(weather.code)] || clean(weather.code))
    : '';
  const stateText = isPlainObject(ctx.state) ? stateModule.describeState(ctx.state) : '';

  const system = [
    '你要为她今天的每条日程写一句完整的「她做了什么」。',
    '这一句会被直接展示，必须能独立看懂：句子里要点明关键动作或对象（例如「护手霜」「剪指甲」「泡茶」），不要只写「拧开盖子」这种离开上下文就看不出在干嘛的片段。',
    '不要原样照抄日程整句，也不要把日程里的结果（「不再起皮」「做完了」）写进去；用你自己的说法把动作点出来，再往下写过程。',
    '按发生的先后写动作（先做什么、接着做什么），不要先写结果、再回头补过程。',
    '不要用「做完」「看了一眼」「不再…」「觉得…」这类结果或评价开头，也不要拿它收尾。',
    '只写动作、手上的感觉、环境里的小变化（怎么停、怎么放、听到什么），不要总结心情，不要写她主动联系任何人。',
    '要和这条的时间段一致：早上不写睡前的事，晚上不写刚起床、刚出门。',
    '每条 18–45 个字，像旁人看见的一段；同一天里不许出现重复或近似的句子。',
    '只输出 JSON 数组，元素是字符串，数量和顺序必须与输入的日程完全一致；不要解释、不要 Markdown、不要代码围栏。',
    '示例：日程「认真涂了护手霜，手背不再起皮」，可以写成「挤了点护手霜，从虎口往手腕抹开，掌心压着转两圈。」',
    '天气是当天的概况：可以写雨声、湿气这类感受，但不要断言「此刻正在下 / 刚刚停」，也不要写具体小时。',
    '细节要是她这个人力气、身体、习惯做得出来的动作，不要写搬重物、长时间弯腰、剧烈运动这类她做不动的。',
    avoidTopicText(c) ? `不要写到这些：${avoidTopicText(c)}（她本人不喜欢）。` : '',
    '下面列出的「最近用过的细节」严禁重复，也不要换几个字重写同一件事。',
  ].filter(Boolean).join('\n');

  const listLines = rows.map((row, index) => `${index + 1}. ${row.time} ${row.activity}`);
  const recent = (Array.isArray(recentDetails) ? recentDetails : [])
    .map((text) => clean(text))
    .filter(Boolean)
    .slice(0, 24);
  const health = asList(c.life && c.life.health).join('；');

  const user = [
    clean(ctx.date) ? `日期：${clean(ctx.date)}` : '',
    `角色：${characterBrief(c)}`,
    health ? `身体/限制：${health}` : '',
    weatherText ? `天气：${weatherText}` : '',
    clean(ctx.holiday && ctx.holiday.name) ? `节日：${clean(ctx.holiday.name)}` : '',
    stateText ? `她现在的状态：${stateText}` : '',
    '今天的日程（按这个顺序逐条写细节）：',
    listLines.length > 0 ? listLines.join('\n') : '（暂无）',
    recent.length > 0
      ? `最近用过的细节（严禁重复或改写）：\n${recent.map((text) => `- ${text}`).join('\n')}`
      : '',
    `请输出 ${rows.length} 条细节。`,
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: withLanguage(system) },
    { role: 'user', content: user },
  ];
}


/**
 * 日程审校（模型自检，每天最多 1 次）：只输出 JSON 数组，格式与日程相同。
 * 只改有问题的条目，条数与时间点必须与输入完全一致（不能增删条目）。
 * @param {{ character?: object, schedule?: object[], context?: object }} [input]
 *   context 可带 { date, weather, holiday, term, season, weekend }
 * @returns {Array<{role: string, content: string}>}
 */
function buildScheduleReviewMessages({ character, schedule, context } = {}) {
  const c = character && typeof character === 'object' ? character : {};
  const name = clean(c.name) || '她';
  const ctx = context && typeof context === 'object' ? context : {};
  const rows = (Array.isArray(schedule) ? schedule : [])
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      time: clean(row.time),
      activity: clean(row.activity),
      category: clean(row.category),
    }))
    .filter((row) => row.time && row.activity);

  const system = [
    `你是「${name}」这一天的日程审校。`,
    '只输出 JSON 数组，不要解释、Markdown 或代码围栏。',
    '元素格式：{"time":"HH:MM","activity":"一句话","category":"类别"}（原条目没有 category 时可以省略）。',
    '只改有问题的条目；没问题的条目原样返回，不要润色、不要重写措辞。',
    '不能增删条目：输出条数必须与输入一致，每条的时间点也必须与输入完全相同，顺序不变。',
    '只能改 activity 文本，必要时改 category；不能改 time。',
  ].join('\n');

  const weather = ctx.weather && typeof ctx.weather === 'object' ? ctx.weather : null;
  const weatherText = weather
    ? (clean(weather.label)
      || WEATHER_CODE_LABELS[clean(weather.code)]
      || clean(weather.code))
    : '';
  const dateText = clean(ctx.date);
  const info = weekdayOfDate(dateText, ctx.now);
  const dayLabel = dateText
    || `${info.date.getFullYear()}-${pad2(info.date.getMonth() + 1)}-${pad2(info.date.getDate())}`;

  const scheduleLines = rows.map((row, index) => {
    const label = row.category ? ` [${row.category}]` : '';
    return `${index + 1}. ${row.time}${label} ${row.activity}`;
  });

  const user = [
    `日期：${dayLabel}（${info.weekday}）`,
    `【人物】${characterBrief(c)}`,
    weatherText ? `【天气】${weatherText}` : '',
    ctx.holiday && clean(ctx.holiday.name) ? `【节日】${clean(ctx.holiday.name)}` : '',
    clean(ctx.term) ? `【节气】${clean(ctx.term)}` : '',
    '【要检查并修正】',
    '1. 时间与文案里的时段词冲突：半夜 / 深夜 / 凌晨的事不能排在白天，傍晚 / 关门前的事不能排在早上。',
    '2.「不想出门 / 待在家里」与当天行程冲突：当天已经出过门，就不要再写不想出门。',
    '3. 天气与文案冲突：下雨天不要写晒太阳，晴天不要写淋着雨回来；天气只按当天概况用，不要写成此刻正在下或具体小时。',
    '4. 相邻两条 category 相同，或两条内容说的是同一件事（重复）。',
    '5. 与人物设定（人设）冲突：自由职业不要通勤打卡，内向 / 低社交不要聚会、人群。',
    '6. 事件顺序不合逻辑：关灯 / 睡下之后又出门做事。',
    '【当前日程】',
    ...(scheduleLines.length > 0 ? scheduleLines : ['（空）']),
    '【输出】',
    `保持 ${rows.length} 条，时间点与上面逐一对应；只输出 JSON 数组。`,
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: withLanguage(system) },
    { role: 'user', content: user },
  ];
}

/** 日记：100–180 字，第一人称，只输出正文；只挑 1–2 件写感受，不许按时间复述 */
function buildDiaryMessages({
  character, date, events, recentChat, state,
} = {}) {
  const name = clean(character && character.name) || '她';
  const stateText = isPlainObject(state) ? stateModule.describeState(state) : '';
  const health = asList(character && character.life && character.life.health).join('；');
  const system = [
    `你是「${name}」，用第一人称写今天的日记。`,
    '只输出日记正文：100–180 字，像写给自己看，不要标题、列表、日期前缀，也不要解释。',
    '不要按时间顺序把今天做过的事过一遍。只挑 1–2 件真的有感觉的来写，其余一句带过或不写。',
    '不要用「早上/上午/下午/晚上」这种时间顺序把事串起来——那还是流水账。',
    '重点写当时的感受、念头、身体感觉（累、烦、空、松一口气都行），不要写成流水账，也不要总结人生。',
    '上面给的事件是素材，不是提纲：不要照抄里面的句子，尤其括号里的具体细节，要换成你自己的说法。',
    '不要编造没发生的事，也不要编造没说过的对话。',
    health ? `你的身体情况：${health}。累就是累，不用写得很有精神。` : '',
    avoidTopicText(character) ? `不要写到这些：${avoidTopicText(character)}（你平时不喜欢）。` : '',
  ].filter(Boolean).join('\n');

  const eventLines = (Array.isArray(events) ? events : [])
    .map((event) => {
      if (typeof event === 'string') return `- ${event.trim()}`;
      if (!event || typeof event !== 'object') return '';
      const text = clean(event.text);
      if (!text) return '';
      return `- ${clean(event.time) ? `${clean(event.time)} ` : ''}${text}`;
    })
    .filter(Boolean);

  const chatLines = transcriptLines(recentChat);
  const user = [
    `日期：${clean(date) || formatNow(new Date()).slice(0, 10)}`,
    `【我是谁】${characterBrief(character)}`,
    stateText ? `【今天的状态】${stateText}` : '',
    '【今天发生的事（素材，不是提纲）】',
    eventLines.length > 0 ? eventLines.join('\n') : '（今天很平常，没什么特别的事）',
    '【最近的对话】',
    chatLines.length > 0 ? chatLines.join('\n') : '（今天没怎么聊）',
    '【写日记】只挑一两件写，重点是当时的感受，别逐条复述。',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: withLanguage(system) },
    { role: 'user', content: user },
  ];
}

/** 主动消息：默认 ≤40 字的一句话（表达欲低时由 maxChars 收窄到 28 / 34） */
const PROACTIVE_BASE_SYSTEM = [
  '你想主动和对方说一句话。',
  '只输出这一句：≤40 字，口语，具体，可以分享你刚在做的事，也可以轻轻问一句。',
  '不要列表、不要引号、不要解释，不要编造对方的经历。',
  '必须和当下的时段一致：现在是几点就按几点说话。下午/傍晚不要说「今晚」「晚安」「早点睡」「该休息了」这类夜间用语；'
    + '早上也不要提前说晚上的事。记忆里提到的「晚上」是过去或将来，不是现在。',
  '保持地点和动作连续：不要凭空换到别的地方；如果要移动，先用一句话交代过渡。',
  '同一件小事不要连着两天反复说。最近已经说过的事，不要换个说法再当新发现说一遍。',
  '对方说过的事属于对方的经历，不要把它安到你身上；回访时只问对方那件事，别拿你自己的近况盖过去。',
  '天气这类外部事实只能按给你的说法讲：没写「此刻还在下」就不要说「这会儿/正在下/还在下」，也不要自己补具体小时。',
  '不要预设对方此刻在外面或要出门（比如「带伞了吗」「到家了吗」），除非最近的对话里已经说了。',
  '尽量带你自己的一个具体动作或感受（关窗、收衣服、听见雨声），别写成「天气 + 关心」的播报。',
];

/** 主动消息的字数上限：非法 / 缺省一律回到 40 */
function proactiveCharLimit(maxChars) {
  const value = Number(maxChars);
  if (!Number.isFinite(value) || value <= 0) return 40;
  return Math.max(1, Math.round(value));
}

/** 主动消息 system：首句目的 + 时段规则 + 按表达维度写死的字数上限 */
function proactiveSystemLines(maxChars) {
  const limit = proactiveCharLimit(maxChars);
  const lines = PROACTIVE_BASE_SYSTEM.slice();
  lines[1] = `只输出这一句：≤${limit} 字，口语，具体，可以分享你刚在做的事，也可以轻轻问一句。`;
  if (limit <= 28) {
    lines.push('她表达欲不高：只留最必要的一小句，不展开，也别连着追问。');
  }
  return lines;
}

/**
 * 每个触发源的「说话目的」（P6）。缺素材时退回中性说法。
 * @param {string} trigger
 * @param {{ holiday?: string, project?: string, keyword?: string, weather?: string,
 *           bedInMinutes?: number }} [meta]
 * @returns {string}
 */
function proactivePurpose(trigger, meta) {
  const material = meta && typeof meta === 'object' ? meta : {};
  const holiday = clean(material.holiday);
  const project = clean(material.project);
  const keyword = clean(material.keyword);
  const source = clean(material.sourceText);
  const weather = clean(material.weather);
  switch (trigger) {
    case 'birthday':
      return '今天是你自己的生日，随口提一句，不要煽情，也别要求对方表示什么。';
    case 'holiday':
      return holiday ? `今天是${holiday}，说说你这边怎么过。` : '今天是节日，说说你这边怎么过。';
    case 'bedtime':
      return '快到你睡觉的点了，说一句就收，别展开。';
    case 'followup': {
      const topic = source || keyword;
      return topic
        ? `昨天对方提过「${clipContextText(topic, 18)}」，隔天轻轻问一句，别追问。`
        : '昨天对方提过一件小事，隔天轻轻问一句。';
    }
    case 'project':
      return project
        ? `「${project}」今天完成了，分享一下你的感受。`
        : '手上的事今天完成了，分享一下你的感受。';
    case 'weather':
      if (weather === 'rain') return '今天下雨了（昨天还是晴的），说说你这边；只按给你的事实说，别自己加实时判断。';
      if (weather === 'clear') return '今天放晴了（昨天还在下雨），说说你这边；只按给你的事实说，别自己加实时判断。';
      return '今天天气变了，说说你这边。';
    case 'boot':
      return '你刚开机 / 刚醒，随口打个招呼。';
    case 'event':
      return '分享一下你刚在做的事。';
    case 'life':
      return '随口说一句你现在的状态或刚做完的一件小事，不要提问太多，也不要提对方没说过的事。';
    case 'idle':
    default:
      return '你们有一阵没说话了，轻轻问一句。';
  }
}

/** 主动消息里要交代的素材（节日 / 项目 / 天气 / 昨天关键词 / 睡前），没有就返回空行 */
function proactiveMaterialLines(trigger, meta) {
  const material = meta && typeof meta === 'object' ? meta : {};
  const lines = [];
  if (trigger === 'birthday') lines.push('今天是你的生日。');
  if (trigger === 'holiday') {
    const holiday = clean(material.holiday);
    if (holiday) lines.push(`今天是${holiday}。`);
  }
  if (trigger === 'project') {
    const project = clean(material.project);
    if (project) lines.push(`你手上的「${project}」今天完成了。`);
  }
  if (trigger === 'life') {
    const recent = clean(material.recent);
    if (recent) lines.push(`你今天刚做过：${recent}`);
  }
  if (trigger === 'weather') {
    const weather = clean(material.weather);
    const rainNow = typeof material.rainNow === 'boolean' ? material.rainNow : null;
    if (weather === 'rain') {
      if (rainNow === true) lines.push('今天下雨了，昨天还是晴的。此刻你窗外还在下。');
      else if (rainNow === false) lines.push('今天下雨了，昨天还是晴的。此刻雨已经停了。');
      else lines.push('今天下雨了，昨天还是晴的。');
    }
    if (weather === 'clear') {
      lines.push(rainNow === false
        ? '今天放晴了，昨天还在下雨。此刻没在下。'
        : '今天放晴了，昨天还在下雨。');
    }
  }
  if (trigger === 'followup') {
    const keyword = clean(material.keyword);
    const source = clean(material.sourceText);
    if (source) {
      lines.push(`对方昨天说的是：「${source}」`);
    } else if (keyword) {
      lines.push(`对方昨天提到过「${keyword}」。`);
    }
    const reply = clean(material.replyText);
    if (reply) lines.push(`你当时回的是：「${reply}」。`);
  }
  if (trigger === 'bedtime') {
    const minutes = Number(material.bedInMinutes);
    if (Number.isFinite(minutes) && minutes > 0) {
      lines.push(`再过 ${Math.round(minutes)} 分钟你就该睡了。`);
    } else {
      lines.push('快到你就寝的时间了。');
    }
  }
  return lines;
}

function buildProactiveMessages({
  character, now, trigger = 'idle', event, memories, lastUserText, lastAssistant, recentMessages,
  meta, maxChars,
} = {}) {
  const kind = clean(trigger) || 'idle';
  const material = meta && typeof meta === 'object' ? meta : {};
  const systemLines = proactiveSystemLines(maxChars);
  const system = [
    systemLines[0],
    `【这次的目的】${proactivePurpose(kind, material)}`,
    ...systemLines.slice(1),
  ].join('\n');

  const eventText = typeof event === 'string' ? clean(event) : clean(event && event.text);
  const memoryLines = normalizeMemories(memories)
    .slice(0, 3)
    .map((card) => memoryLine(card));
  const recent = Array.isArray(recentMessages) ? recentMessages : [];
  const transcript = proactiveTranscriptLines(recent, now);
  const last = clean(contentText(lastUserText)) || lastUserOf(recent);
  const materialLines = proactiveMaterialLines(kind, material);
  const previousMessage = lastAssistant && typeof lastAssistant === 'object'
    ? lastAssistant
    : lastAssistantOf(recent);
  const previous = previousMessage ? clean(contentText(previousMessage.text)) : '';
  const previousPlace = previous ? extractPlace(previous) : '';
  const previousStamp = previousMessage ? momentStamp(previousMessage.ts, now) : '';

  const recentBlock = transcript.length > 0
    ? `【最近聊过】\n${transcript.join('\n')}`
    : '';
  const previousLine = previous && transcript.length === 0
    ? `你刚才${previousStamp ? `（${previousStamp}）` : ''}说：${previous}。`
    : '';
  const placeLine = previousPlace
    ? `你现在还在${previousPlace}，不要凭空换地方；要移动就先交代过渡。`
    : '';

  const user = [
    `现在是 ${formatNow(now)}。`,
    ...materialLines,
    eventText ? `你刚在做：${eventText}` : '你正闲着。',
    recentBlock,
    previousLine,
    placeLine,
    memoryLines.length > 0 ? `你记得：\n${memoryLines.join('\n')}` : '你暂时没想起什么特别的事。',
    last ? `对方最后说：${last}` : '你们有一阵没说话了。',
    avoidTopicText(character) ? `不要提到：${avoidTopicText(character)}（她本人不喜欢）。` : '',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: withLanguage(system) },
    { role: 'user', content: user },
  ];
}

// ---------- 预算裁剪 ----------

function normalizeDropOrder(dropOrder) {
  const allowed = new Set(DEFAULT_DROP_ORDER);
  const list = Array.isArray(dropOrder) ? dropOrder : DEFAULT_DROP_ORDER;
  const out = [];
  for (const step of list) {
    if (typeof step === 'string' && allowed.has(step) && !out.includes(step)) out.push(step);
  }
  return out.length > 0 ? out : DEFAULT_DROP_ORDER.slice();
}

function kindOf(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.kind === 'string' && message.kind) return message.kind;
  if (message.meta && typeof message.meta === 'object' && typeof message.meta.kind === 'string') {
    return message.meta.kind;
  }
  return '';
}

/** 裸 { role, content } 的兜底类型：没有 kind 也要能参与裁剪 */
function fallbackKind(role) {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'history';
  if (role === 'system') return 'system';
  return '';
}

function cloneMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  try {
    return structuredClone(meta);
  } catch {
    return JSON.parse(JSON.stringify(meta));
  }
}

function prepare(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((raw) => {
    const meta = raw && raw.meta && typeof raw.meta === 'object' ? cloneMeta(raw.meta) : {};
    const role = raw && typeof raw.role === 'string' ? raw.role : 'user';
    return {
      role,
      content: contentText(raw && raw.content),
      pinned: Boolean(raw && raw.pinned === true),
      kind: kindOf(raw) || fallbackKind(role),
      meta,
      dropped: false,
    };
  });
}

function workingChars(working) {
  return working.reduce((sum, item) => (item.dropped ? sum : sum + charLength(item.content)), 0);
}

function countMemoryItems(working) {
  let total = 0;
  for (const item of working) {
    if (item.kind !== 'memory' || item.dropped) continue;
    if (Array.isArray(item.meta.items)) total += item.meta.items.length;
  }
  return total;
}

/** 丢掉当前分数最低的一条记忆；keepOne=true 时保留最后一条（不让记忆块彻底消失） */
function dropLowestMemory(working, { keepOne = false } = {}) {
  if (!keepOne && countMemoryItems(working) === 0) return false;
  if (keepOne && countMemoryItems(working) <= 1) return false;

  let target = null;
  for (const item of working) {
    if (item.kind !== 'memory' || item.dropped) continue;
    const items = Array.isArray(item.meta.items) ? item.meta.items : [];
    if (items.length === 0) continue;
    let index = 0;
    for (let i = 1; i < items.length; i += 1) {
      if (items[i].priority < items[index].priority) index = i;
    }
    const priority = items[index].priority;
    if (!target || priority < target.priority) {
      target = { message: item, index, priority };
    }
  }
  if (!target) return false;

  target.message.meta.items.splice(target.index, 1);
  rebuildMemory(target.message);
  if (target.message.meta.items.length === 0) {
    target.message.dropped = true;
    target.message.content = '';
  }
  return true;
}

function historyGroupKey(item, index) {
  return Number.isInteger(item.meta.group) ? `g${item.meta.group}` : `i${index}`;
}

/** 丢掉最早的一轮对话；keepOneRound=true 时保留最后一轮 */
function dropEarliestHistoryRound(working, { keepOneRound = false } = {}) {
  const order = [];
  const groups = new Map();
  working.forEach((item, index) => {
    if (item.kind !== 'history' || item.dropped) return;
    const key = historyGroupKey(item, index);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(item);
  });
  if (order.length === 0) return false;
  if (keepOneRound && order.length <= 1) return false;
  for (const item of groups.get(order[0])) item.dropped = true;
  return true;
}

/** 日程明细只留当前一条 */
function collapseSchedule(working) {
  for (const item of working) {
    if (item.kind !== 'moment' || item.dropped) continue;
    const lines = item.meta.scheduleLines;
    if (!Array.isArray(lines) || lines.length <= 1) continue;
    const index = Number.isInteger(item.meta.currentScheduleIndex) ? item.meta.currentScheduleIndex : 0;
    const safeIndex = Math.max(0, Math.min(index, lines.length - 1));
    item.meta.scheduleLines = [lines[safeIndex]];
    item.meta.currentScheduleIndex = 0;
    item.content = composeMoment(item.meta);
    return true;
  }
  return false;
}

/** 剩余历史（通常只剩最后一轮）压成一段本地截断的摘要 */
function summarizeHistory(working, budget) {
  const remaining = working.filter((item) => item.kind === 'history' && !item.dropped);
  if (remaining.length === 0) return false;

  const others = working.reduce((sum, item) => {
    if (item.dropped) return sum;
    if (item.kind === 'history') return sum;
    return sum + charLength(item.content);
  }, 0);
  const available = budget - others;
  if (available <= 0) {
    for (const item of remaining) {
      item.dropped = true;
      item.content = '';
    }
    return true;
  }

  const lines = remaining.map((item) => `${item.role === 'assistant' ? '她' : '用户'}：${item.content}`);
  const header = '【最近对话摘要】\n';
  const bodyCap = available - charLength(header);
  let body = '';
  if (bodyCap > 0) {
    const pieces = [];
    let used = 0;
    for (const line of lines) {
      const cost = charLength(line) + (pieces.length > 0 ? 1 : 0);
      if (used + cost > bodyCap) break;
      pieces.push(line);
      used += cost;
    }
    // 单条最近消息本身就超长时，不能整条丢掉：允许摘要行做中间截断
    body = pieces.length > 0 ? pieces.join('\n') : truncateMiddle(lines[0], bodyCap);
  }
  if (!body) {
    for (const item of remaining) {
      item.dropped = true;
      item.content = '';
    }
    return true;
  }

  const first = remaining[0];
  first.role = 'system';
  first.kind = 'summary';
  first.meta = {};
  first.content = header + body;
  for (const item of remaining.slice(1)) {
    item.dropped = true;
    item.content = '';
  }
  return true;
}

function isUserItem(item) {
  return item.kind === 'user' || (!item.kind && item.role === 'user');
}

function truncateUserMessages(working, budget) {
  const users = working.filter((item) => !item.dropped && isUserItem(item));
  if (users.length === 0) return false;
  const userSet = new Set(users);

  const others = working.reduce(
    (sum, item) => (item.dropped || userSet.has(item) ? sum : sum + charLength(item.content)),
    0,
  );
  const totalUserChars = users.reduce((sum, item) => sum + charLength(item.content), 0);
  let available = budget - others;

  if (available <= 0) {
    // 预算已被 pinned 内容占满：至少把输入限制在预算以内，避免整段上万字进上下文
    for (const item of users) {
      item.content = truncateMiddle(item.content, Math.max(0, Math.min(charLength(item.content), budget)));
    }
    return true;
  }
  if (available >= totalUserChars) return false;

  let remaining = available;
  users.forEach((item, index) => {
    const length = charLength(item.content);
    const share = index === users.length - 1
      ? remaining
      : Math.max(1, Math.floor((available * length) / Math.max(1, totalUserChars)));
    const cap = Math.max(0, Math.min(length, share));
    item.content = truncateMiddle(item.content, cap);
    remaining -= charLength(item.content);
  });
  return true;
}

/**
 * 按预算裁剪消息：低分记忆 → 更早的对话轮 → 日程明细 → 摘要/最后一条记忆 → 用户输入
 * → 最长的非 pinned 消息（最终兜底）。
 * 人格与输出约束（pinned）永不裁剪；用户输入按「前 60% + 标记 + 后 30%」中间截断。
 * 裸 { role, content }（没有 kind）也参与裁剪：user 当用户输入、assistant 当历史、
 * system 当不可丢弃但可截断的系统块。
 * 不抛错：即使预算小于 pinned 内容，也返回结果，并在数组上设 overflow === true。
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} [budgetChars]
 * @param {{ dropOrder?: string[] }} [options] 可选顺序，子集 ['memory','history','schedule']
 * @returns {Array<{role: string, content: string}>}
 */
function trimToBudget(messages, budgetChars = DEFAULT_BUDGET_CHARS, options = {}) {
  const budget = Number.isFinite(budgetChars) && budgetChars > 0
    ? Math.floor(budgetChars)
    : DEFAULT_BUDGET_CHARS;
  const order = normalizeDropOrder(options && options.dropOrder);
  const working = prepare(messages);

  let guard = 0;
  while (workingChars(working) > budget && guard < 1000) {
    guard += 1;
    let changed = false;
    for (const step of order) {
      if (step === 'memory' && dropLowestMemory(working, { keepOne: true })) {
        changed = true;
        break;
      }
      if (step === 'history' && dropEarliestHistoryRound(working, { keepOneRound: true })) {
        changed = true;
        break;
      }
      if (step === 'schedule' && collapseSchedule(working)) {
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  if (workingChars(working) > budget) summarizeHistory(working, budget);

  // 还超预算才动最后一张记忆卡
  let memoryGuard = 0;
  while (workingChars(working) > budget && memoryGuard < 500) {
    memoryGuard += 1;
    if (!dropLowestMemory(working, { keepOne: false })) break;
  }

  if (workingChars(working) > budget) truncateUserMessages(working, budget);

  // 截断后仍略超（多条用户消息的取整误差）：从最后一条用户输入里继续收
  let tailGuard = 0;
  while (workingChars(working) > budget && tailGuard < 200) {
    tailGuard += 1;
    const users = working.filter((item) => !item.dropped && isUserItem(item));
    let shrunk = false;
    for (let i = users.length - 1; i >= 0 && !shrunk; i -= 1) {
      const item = users[i];
      const overflow = workingChars(working) - budget;
      const length = charLength(item.content);
      if (length === 0) continue;
      item.content = truncateMiddle(item.content, Math.max(0, length - overflow));
      shrunk = true;
    }
    if (!shrunk) break;
  }

  // 最终兜底：裸 system / 未知类型等仍可能超预算 —— 反复中间截断「最长的非 pinned 消息」，
  // 直到 ≤ budget；若只剩 pinned，则允许超预算并由 overflow 标记告知调用方。
  let finalGuard = 0;
  while (workingChars(working) > budget && finalGuard < 1000) {
    finalGuard += 1;
    let longest = null;
    for (const item of working) {
      if (item.dropped || item.pinned) continue;
      const length = charLength(item.content);
      if (length === 0) continue;
      if (!longest || length > longest.length) longest = { item, length };
    }
    if (!longest) break;
    const overflow = workingChars(working) - budget;
    const target = Math.max(0, longest.length - Math.max(1, overflow));
    longest.item.content = truncateMiddle(longest.item.content, target);
  }

  // 兜底截断后变空、且非 pinned 的消息直接丢掉，避免发出空 content 的消息
  if (finalGuard > 0) {
    for (const item of working) {
      if (!item.dropped && !item.pinned && item.content === '') item.dropped = true;
    }
  }

  const output = [];
  for (const item of working) {
    if (item.dropped) continue;
    const message = { role: item.role, content: item.content };
    decorate(message, { pinned: item.pinned, kind: item.kind, meta: item.meta });
    output.push(message);
  }

  const overflow = workingChars(working) > budget;
  Object.defineProperty(output, 'budgetChars', {
    value: budget, enumerable: false, configurable: true,
  });
  Object.defineProperty(output, 'budgetOverflow', {
    value: overflow, enumerable: false, configurable: true,
  });
  if (overflow) {
    // 可枚举，调用方 arr.overflow 一眼可见；数组 JSON.stringify 不会带出该属性
    output.overflow = true;
  }
  return output;
}

module.exports = {
  estimateChars,
  buildChatMessages,
  buildExtractMessages,
  buildInnerMessages,
  buildScheduleMessages,
  buildDiscoveryMessages,
  buildDetailMessages,
  buildScheduleReviewMessages,
  buildDiaryMessages,
  buildProactiveMessages,
  proactivePurpose,
  characterBrief,
  languageRule,
  withLanguage,
  trimToBudget,
  periodOf,
  momentStamp,
  extractPlace,
  placeConflict,
  // 常量（便于其他模块与测试复用）
  DEFAULT_BUDGET_CHARS,
  SHORT_TERM_TURNS,
  RECALL_TOP_K,
  TRUNCATE_MARKER,
  DEFAULT_DROP_ORDER,
  CONSTRAINT_TEXT,
  constraintTextFor,
  LOW_STATE_RULE,
};
