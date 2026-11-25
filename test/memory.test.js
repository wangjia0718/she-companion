'use strict';

// memory.js 测试：覆盖计划 Task 5 的 9 个必要点，另加：
// - mergeCards 对不相似的两条保持两条（含「猫/狗」「肯定/否定」回归）
// - retrieve 的 topK 小于候选数量、同 id 只输出一次
// - importance 非 1..5（0/6/'3'/null）时归一化不抛错
// - 卡片 text 为空串时被过滤
// - similarity = 纯二元组 Jaccard；同主题判定用 isSameTopic（否定例外 + 真子串补充例外）
// - polarity 对「还没/不错/特别/未来/无糖」等例外词不误判
// - isSameTopic 反例：猫粮/咖啡色/咖啡因/咖啡味蛋糕/偏好+日记 不合并；正例：连接补充/粒度后缀/前置修饰
// - suppressed 落盘往返（store 集成 + writeMemory 自动提升 + 按 norm 归并/ISO 化）
// - variants 解决传递性合并、单卡「头 200 + 标记 + 尾 60」字素级截断
// - parseCards 硬上限（20000 个未闭合 [ 50ms 内 null）、kind 候选优先、对象包装 / 示例数组 / 深层嵌套
// - 输出按 createdAt 升序、extractFromChat 的失败重试与无 profile 报错

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const llm = require('../src/main/llm');
const store = require('../src/main/store');
const {
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
  parseCards,
  normalizeImportance,
  MERGE_THRESHOLD,
  MAX_CARD_CHARS,
  CARD_HEAD_CHARS,
  CARD_TAIL_CHARS,
  MAX_PARSE_BYTES,
  MAX_PARSE_CANDIDATES,
  TRUNCATE_MARKER,
} = require('../src/main/memory');

const NOW = new Date('2026-10-26T21:00:00+08:00');
const DAY = 24 * 60 * 60 * 1000;

function card(text, extra = {}) {
  return {
    id: extra.id || `m-${Math.abs(text.length * 31 + (extra.importance || 3))}`,
    kind: extra.kind || 'event',
    text,
    tags: extra.tags || [],
    variants: extra.variants,
    importance: extra.importance === undefined ? 3 : extra.importance,
    createdAt: extra.createdAt || NOW.toISOString(),
    updatedAt: extra.updatedAt || extra.createdAt || NOW.toISOString(),
    hits: extra.hits === undefined ? 1 : extra.hits,
    sourceMessageId: null,
    embedding: extra.embedding === undefined ? null : extra.embedding,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-memory-'));
}

function daysAgo(days) {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

/** 临时替换 llm 的导出函数；测试结束自动还原（测试文件各自独立进程） */
function mockLlm(t, { chat, embeddings } = {}) {
  const originalChat = llm.chat;
  const originalEmbeddings = llm.embeddings;
  if (chat) llm.chat = chat;
  if (embeddings) llm.embeddings = embeddings;
  t.after(() => {
    llm.chat = originalChat;
    llm.embeddings = originalEmbeddings;
  });
}

const profile = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'm', capabilities: ['chat'] };
const embeddingProfile = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'emb', capabilities: ['embedding'] };

// ---------- 1. normalizeText ----------

test('normalizeText 去掉全角标点、空白，大小写与全角数字归一', () => {
  assert.equal(normalizeText('我 下周要交《季度方案》！'), '我下周要交季度方案');
  assert.equal(normalizeText('Hello, World！ ２０２６'), 'helloworld2026');
  assert.equal(normalizeText('  \n\t　'), '');
  assert.equal(normalizeText('我 下周要交，季度方案！'), normalizeText('我下周要交季度方案'));
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(123), '123');
});

// ---------- 2. similarity ----------

test('similarity：纯中文二元组 Jaccard；全角标点混排按真实值且不会判为同主题', () => {
  // 真实 Jaccard：交集 {下周, 方案} / 并集 10 个二元组 = 0.2
  assert.equal(similarity('我下周要交季度方案', '下周交方案'), 0.2);
  assert.equal(similarity('我 下周要交，季度方案！', '下周交方案'), 0.2);
  assert.ok(similarity('我 下周要交，季度方案！', '下周交方案') < MERGE_THRESHOLD);
  // 归一化一致 → 完全相同
  assert.equal(similarity('我 下周要交，季度方案！', '我下周要交季度方案'), 1);
  assert.equal(similarity('用户喜欢手冲咖啡', '用户喜欢手冲咖啡'), 1);
  assert.ok(similarity('用户喜欢手冲咖啡', '用户下周三要交季度方案') < 0.3);
  assert.equal(similarity('', '用户喜欢咖啡'), 0);
  assert.equal(similarity('！！', '？？'), 0);
  // 单字不参与合并相似度：猫 / 狗 只共享「用户,户喜,喜欢」= 3/5
  assert.equal(similarity('用户喜欢猫', '用户喜欢狗'), 0.6);
  assert.ok(similarity('用户喜欢猫', '用户喜欢狗') < MERGE_THRESHOLD);
  // similarity 只算字面重合，不掺否定（否定在 isSameTopic 里判）
  assert.equal(similarity('用户不喜欢手冲咖啡', '用户喜欢手冲咖啡'), 6 / 9);
  // 对称
  assert.equal(
    similarity('iphone 15 拍照不错', 'iphone15拍照还可以'),
    similarity('iphone15拍照还可以', 'iphone 15 拍照不错'),
  );
  // 英文按小写词匹配
  assert.ok(similarity('deadline 是下周三', 'DEADLINE 下周三') > 0.6);
  // containment 是另一回事：短查询能被长文本覆盖，供检索用
  assert.equal(containment('用户喜欢咖啡', '用户喜欢手冲咖啡'), 0.8);
  assert.ok(containment('下周交方案', '我 下周要交，季度方案！') > 0.4);
});

test('polarity：例外词（还没/不错/特别/未来/无糖…）不算否定', () => {
  assert.equal(polarity('用户下周三要交一份季度方案，还没定结构'), 1);
  assert.equal(polarity('拍照不错'), 1);
  assert.equal(polarity('特别喜欢'), 1);
  assert.equal(polarity('未来想去杭州'), 1);
  assert.equal(polarity('用户喜欢无糖咖啡'), 1);
  assert.equal(polarity('不但要交方案，还要汇报'), 1);
  assert.equal(polarity('别人都说好'), 1);

  assert.equal(polarity('用户不喜欢手冲咖啡'), -1);
  assert.equal(polarity('用户没去过杭州'), -1);
  assert.equal(polarity('用户没有猫'), -1);
  assert.equal(polarity('用户喜欢手冲咖啡'), 1);
});

test('isSameTopic：子集例外放行（Spec 原文），猫/狗与肯定/否定拦住', () => {
  const specOld = '用户下周三要交一份季度方案';
  const specNew = '用户下周三要交一份季度方案，还没定结构';
  // Jaccard 只有 12/17 ≈ 0.71（<0.72），但覆盖率 1 → 同主题
  assert.ok(similarity(specOld, specNew) < MERGE_THRESHOLD);
  assert.ok(similarity(specOld, specNew) > 0.7);
  assert.equal(isSameTopic(specOld, specNew), true);

  assert.equal(isSameTopic('用户喜欢猫', '用户喜欢狗'), false);
  assert.equal(isSameTopic('用户喜欢手冲咖啡', '用户不喜欢手冲咖啡'), false);
  assert.equal(isSameTopic('用户喜欢手冲咖啡', '用户讨厌应酬'), false);
  assert.equal(isSameTopic('', ''), false);
});

// ---------- 3. 零重合过滤，importance 5 例外 ----------

test('retrieve 过滤零重合卡片，importance=5 的卡例外', () => {
  const cards = [
    card('用户下周三要交一份季度方案', { id: 'a', importance: 3 }),
    card('用户常去的那家旧书店要关门了', { id: 'b', importance: 2 }),
    card('用户对花生过敏', { id: 'c', importance: 5 }),
    card('用户养了一只叫豆豆的猫', { id: 'd', importance: 3 }),
  ];

  const picked = retrieve(cards, '周末想去书店逛逛', { now: NOW, topK: 12 });
  const ids = picked.map((item) => item.id);

  assert.ok(ids.includes('b'), '重合的卡片应入选');
  assert.ok(ids.includes('c'), 'importance=5 的卡片不受零重合限制');
  assert.equal(ids.includes('a'), false, '零重合且 important<5 不能入选');
  assert.equal(ids.includes('d'), false);

  // 查询为空时只留 importance=5
  const empty = retrieve(cards, '', { now: NOW });
  assert.deepEqual(empty.map((item) => item.id), ['c']);
});

// ---------- 4. 同主题合并 ----------

test('mergeCards 同主题两次合并（Spec 原文）：只剩 1 条、hits=2、updatedAt 更新、importance 取大', () => {
  const existing = [card('用户下周三要交一份季度方案', { id: 'm-1', importance: 2, hits: 0, createdAt: daysAgo(2) })];
  const first = mergeCards(existing, [card('用户下周三要交一份季度方案，还没定结构', { importance: 4, tags: ['工作'] })], {
    now: new Date('2026-10-26T22:00:00+08:00'),
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].id, 'm-1');
  assert.equal(first[0].text, '用户下周三要交一份季度方案，还没定结构');
  assert.equal(first[0].hits, 1);
  assert.equal(first[0].importance, 4);
  assert.equal(new Date(first[0].updatedAt).getTime(), new Date('2026-10-26T22:00:00+08:00').getTime());

  const second = mergeCards(first, [card('用户下周三要交一份季度方案，结构还没定', { importance: 3 })], {
    now: new Date('2026-10-27T09:00:00+08:00'),
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].hits, 2, '第二次合并后 hits 累加到 2');
  assert.equal(second[0].importance, 4, 'importance 取较大值');
  assert.equal(second[0].text, '用户下周三要交一份季度方案，结构还没定');
  assert.equal(new Date(second[0].updatedAt).getTime(), new Date('2026-10-27T09:00:00+08:00').getTime());
  assert.ok(second[0].tags.includes('工作'));
  assert.equal(second[0].variants.length, 3);
  // 原数组不被改动
  assert.equal(existing[0].hits, 0);
  assert.equal(isSameTopic('用户下周三要交一份季度方案', '用户下周三要交一份季度方案，还没定结构'), true);
});

test('mergeCards 对不相似的两条保持两条', () => {
  const existing = [card('用户喜欢手冲咖啡', { id: 'm-1' })];
  const merged = mergeCards(existing, [{ kind: 'event', text: '用户下周三要交季度方案' }], { now: NOW });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'm-1');
  assert.equal(merged[1].text, '用户下周三要交季度方案');
  assert.match(merged[1].id, /^m-\d+-\d+$/);
  assert.equal(merged[1].hits, 1);
  assert.equal(merged[1].kind, 'event');
});

test('mergeCards 拒绝空文本与非卡片；补充漏洞字段（kind/importance）', () => {
  const merged = mergeCards([], [
    { kind: 'event', text: '   ' },
    null,
    {},
    { kind: '随便', text: '用户今天很累', importance: 9 },
  ], { now: NOW });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'fact');
  assert.equal(merged[0].importance, 5);
  assert.deepEqual(merged[0].variants, ['用户今天很累']);
});

test('mergeCards 不会把「喜欢猫 / 喜欢狗」「喜欢 / 不喜欢」并成一条', () => {
  const animals = mergeCards([card('用户喜欢猫', { id: 'cat' })], [{ kind: 'preference', text: '用户喜欢狗' }], { now: NOW });
  assert.equal(animals.length, 2, '猫和狗不能互相覆盖');

  const negated = mergeCards([card('用户喜欢手冲咖啡', { id: 'like' })], [{ kind: 'preference', text: '用户不喜欢手冲咖啡' }], { now: NOW });
  assert.equal(negated.length, 2, '否定句不能并进肯定句');
});

test('isSameTopic 反例：加字变义（猫粮 / 咖啡色 / 咖啡因 / 咖啡味蛋糕）不合并', () => {
  const pairs = [
    ['用户喜欢猫', '用户喜欢猫粮'],
    ['用户喜欢咖啡', '用户喜欢咖啡色'],
    ['用户喜欢咖啡', '用户喜欢咖啡因'],
    ['用户喜欢咖啡', '用户喜欢咖啡味蛋糕'],
  ];
  for (const [short, long] of pairs) {
    assert.equal(isSameTopic(short, long), false, `${short} / ${long} 不能判为同主题`);
    const merged = mergeCards([card(short, { id: 'm-1' })], [card(long)], { now: NOW });
    assert.equal(merged.length, 2, `${short} / ${long} 不能合并`);
    assert.equal(merged[0].text, short, '原卡片文本不能被覆盖');
  }
});

test('isSameTopic 反例：偏好 + 日记（多事实）不合并', () => {
  const pref = '用户喜欢咖啡';
  const diary = '用户喜欢咖啡。今天去了书店';
  assert.equal(isSameTopic(pref, diary), false);
  const merged = mergeCards([card(pref, { id: 'm-1' })], [card(diary)], { now: NOW });
  assert.equal(merged.length, 2);
});

test('isSameTopic 正例：连接补充 / 粒度后缀 / 前置修饰', () => {
  // Spec 原文
  assert.equal(isSameTopic('用户下周三要交一份季度方案', '用户下周三要交一份季度方案，还没定结构'), true);
  // 连接补充
  assert.equal(isSameTopic('用户喜欢咖啡', '用户喜欢咖啡和戚风蛋糕'), true);
  // 粒度后缀
  assert.equal(isSameTopic('用户住在徐汇', '用户住在徐汇区'), true);
  // 前置修饰
  assert.equal(isSameTopic('用户喜欢咖啡', '今天用户喜欢咖啡'), true);

  const merged = mergeCards([card('用户喜欢咖啡', { id: 'm-1' })], [card('用户喜欢咖啡和戚风蛋糕')], { now: NOW });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, '用户喜欢咖啡和戚风蛋糕');
});

test('「养了一只猫」与「养了一只狗和一只猫」不合并（一卡一事）', () => {
  assert.equal(isSameTopic('用户养了一只猫', '用户养了一只狗和一只猫'), false);
  const merged = mergeCards(
    [card('用户养了一只猫', { id: 'm-1' })],
    [card('用户养了一只狗和一只猫')],
    { now: NOW },
  );
  assert.equal(merged.length, 2);
});

test('mergeCards 多条命中时选最相似的那条（Jaccard 优先）', () => {
  const cards = [
    card('用户喜欢咖啡', { id: 'c1', hits: 1 }),
    card('用户喜欢咖啡和戚风蛋糕', { id: 'c2', hits: 1 }),
  ];
  const merged = mergeCards(cards, [card('用户喜欢咖啡和戚风蛋糕')], { now: NOW });
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.id === 'c1').hits, 1, '较不相似的卡不被改动');
  assert.equal(merged.find((item) => item.id === 'c2').hits, 2, '合并到最相似的卡');
});

test('mergeCards 用 variants 兜住传递性：靠历史表述命中，避免 A≈B、B≈C、A!≈C 时拆成两条', () => {
  const a = '用户喜欢咖啡';
  const b = '今天用户喜欢咖啡';
  const c = '最近用户喜欢咖啡';
  assert.equal(isSameTopic(a, b), true, '前置修饰「今天」允许');
  assert.equal(isSameTopic(a, c), true, '前置修饰「最近」允许');
  assert.equal(isSameTopic(b, c), false, 'B/C 互不为子串，Jaccard 也低于阈值');

  const first = mergeCards([card(a, { id: 'm-1', hits: 0 })], [{ kind: 'preference', text: b }], { now: NOW });
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].variants, [a, b]);

  // 没有 variants 时会新开一条（对照）
  const withoutVariants = mergeCards([card(b, { id: 'm-2' })], [{ kind: 'preference', text: c }], { now: NOW });
  assert.equal(withoutVariants.length, 2);

  const second = mergeCards(first, [{ kind: 'preference', text: c }], { now: NOW });
  assert.equal(second.length, 1, 'C 命中历史变体 A，应并进同一条');
  assert.equal(second[0].text, c);
  assert.deepEqual(second[0].variants, [a, b, c]);
  assert.equal(second[0].hits, 2);
});

test('variants 最多保留 5 条历史表述', () => {
  const many = card('用户喜欢手冲咖啡', {
    variants: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'],
  });
  const out = mergeCards([many], [], { now: NOW });
  assert.equal(out[0].variants.length, 5);
  assert.equal(out[0].variants[out[0].variants.length - 1], '用户喜欢手冲咖啡');
});

// ---------- 5. prune ----------

test('prune 淘汰「低重要度 + 最久未命中」', () => {
  const cards = [
    card('用户喜欢手冲咖啡', { id: 'high-new', importance: 5, updatedAt: daysAgo(1) }),
    card('用户下周三要交季度方案', { id: 'high-old', importance: 5, updatedAt: daysAgo(30) }),
    card('用户养了一只猫', { id: 'mid', importance: 3, updatedAt: daysAgo(2) }),
    card('用户讨厌应酬', { id: 'low-new', importance: 1, updatedAt: daysAgo(1) }),
    card('用户提过一句天气', { id: 'low-old', importance: 1, updatedAt: daysAgo(60) }),
  ];

  const kept = prune(cards, 3);
  assert.deepEqual(kept.map((item) => item.id), ['high-new', 'high-old', 'mid']);
  assert.equal(cards.length, 5, 'prune 不改动入参');

  // 默认上限 2000
  const many = [];
  for (let i = 0; i < 2005; i += 1) {
    many.push(card(`记忆${i}`, {
      id: `c-${i}`,
      importance: i < 5 ? 1 : 4,
      updatedAt: daysAgo(i),
    }));
  }
  const trimmed = prune(many);
  assert.equal(trimmed.length, 2000);
  assert.equal(trimmed.some((item) => item.id.startsWith('c-') && Number(item.id.slice(2)) < 5), false, '最重要的保留，最低重要度先淘汰');
  assert.equal(prune([], 0).length, 0);
  assert.equal(prune(null).length, 0);
});

// ---------- 6. 时间词补卡 ----------

test('查询含时间词时，把最近 3 天的 event 卡无条件补进来（去重、按 createdAt 升序）', () => {
  const cards = [
    card('用户去看了画展', { id: 'event-1', kind: 'event', createdAt: daysAgo(1), importance: 2 }),
    card('用户那天说画展很好看', { id: 'event-2', kind: 'event', createdAt: daysAgo(2), importance: 2 }),
    card('用户上个月去了杭州', { id: 'event-old', kind: 'event', createdAt: daysAgo(10), importance: 2 }),
    card('用户昨天买了新耳机', { id: 'fact-recent', kind: 'fact', createdAt: daysAgo(1), importance: 1 }),
  ];

  const picked = retrieve(cards, '上周我说了什么', { now: NOW, topK: 1 });
  const ids = picked.map((item) => item.id);

  assert.ok(ids.includes('event-1'), '最近 3 天的 event 卡必须无条件纳入（即使零重合）');
  assert.ok(ids.includes('event-2'));
  assert.equal(ids.includes('event-old'), false, '超过 3 天的 event 不补');
  assert.equal(ids.includes('fact-recent'), false, '只补 event 类型');
  assert.equal(new Set(ids).size, ids.length, '不允许重复卡片');

  const stamps = picked.map((item) => new Date(item.createdAt).getTime());
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), '输出按 createdAt 升序');

  // 无时间词时不补零重合卡
  const plain = retrieve(cards, '画展', { now: NOW, topK: 12 }).map((item) => item.id);
  assert.equal(plain.includes('event-1'), true);
  assert.equal(plain.includes('fact-recent'), false);
});

// ---------- 7. topK 截断与排序 ----------

test('retrieve 的 topK 小于候选数量时按分数截断，输出仍按 createdAt 升序', () => {
  const cards = [];
  for (let i = 0; i < 6; i += 1) {
    cards.push(card(`用户下周要交季度方案第${i}版`, {
      id: `c-${i}`,
      importance: 2,
      createdAt: new Date(NOW.getTime() - i * DAY).toISOString(),
      hits: 10 - i,
    }));
  }

  const picked = retrieve(cards, '季度方案', { now: NOW, topK: 3 });
  assert.equal(picked.length, 3);
  assert.ok(picked.every((item) => typeof item.score === 'number' && item.score > 0));
  const stamps = picked.map((item) => new Date(item.createdAt).getTime());
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b));

  // 分数更高者优先入选：hits 大、更新的 c-0 必在其中
  assert.ok(picked.some((item) => item.id === 'c-0'));
  // topK=0 时不出结果
  assert.deepEqual(retrieve(cards, '季度方案', { now: NOW, topK: 0 }), []);
});

test('retrieve 同一 id 传入两次只输出一条（含时间词补卡）', () => {
  const one = card('用户喜欢手冲咖啡', { id: 'dup' });
  assert.equal(retrieve([one, { ...one }, one], '咖啡', { now: NOW }).length, 1);

  const event = card('用户昨天去了画展', { id: 'ev', kind: 'event', createdAt: daysAgo(1) });
  const picked = retrieve([event, { ...event }], '上周做了什么', { now: NOW });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, 'ev');
});

// ---------- 8. 向量余弦参与打分 ----------

test('scoreCard 的向量项：余弦越高分数越高，维度不符/缺向量不抛错', () => {
  const base = { id: 'v1', kind: 'fact', text: '用户喜欢手冲咖啡', importance: 3, createdAt: NOW.toISOString(), hits: 1 };
  const vectorQuery = [1, 0];

  const none = scoreCard(base, '咖啡', { now: NOW });
  const same = scoreCard({ ...base, embedding: [1, 0] }, '咖啡', { now: NOW, vectorQuery });
  const half = scoreCard({ ...base, embedding: [0, 1] }, '咖啡', { now: NOW, vectorQuery });
  const broken = scoreCard({ ...base, embedding: [1, 0, 3] }, '咖啡', { now: NOW, vectorQuery });

  assert.ok(same > none);
  assert.equal(half, none, '余弦为 0 时与无向量同分');
  assert.equal(broken, none, '维度不符按 0 处理');

  // 零重合但向量相近 → 仍可被检索到
  const cards = [card('用户对花生过敏', { id: 'v', importance: 2, embedding: [1, 0] })];
  const picked = retrieve(cards, '周末想吃什么', { now: NOW, vectorQuery: [1, 0] });
  assert.deepEqual(picked.map((item) => item.id), ['v']);
});

// ---------- 9. importance 归一化 ----------

test('importance 非 1..5（0/6/"3"/null）时归一化不抛错', () => {
  assert.equal(normalizeImportance(0), 1);
  assert.equal(normalizeImportance(6), 5);
  assert.equal(normalizeImportance('3'), 3);
  assert.equal(normalizeImportance(null), 3);
  assert.equal(normalizeImportance(undefined), 3);
  assert.equal(normalizeImportance('高'), 3);
  assert.equal(normalizeImportance(3.4), 3);
  assert.equal(normalizeImportance(NaN), 3);

  for (const value of [0, 6, '3', null, undefined, '高', NaN]) {
    const one = card('用户下周要交季度方案', { importance: value });
    const score = scoreCard(one, '季度方案', { now: NOW });
    assert.ok(Number.isFinite(score), `importance=${String(value)} 时应返回有限分数`);
    assert.doesNotThrow(() => retrieve([one], '季度方案', { now: NOW }));
    const merged = mergeCards([], [one], { now: NOW });
    assert.ok(merged[0].importance >= 1 && merged[0].importance <= 5);
  }
});

// ---------- 10. 空文本过滤 ----------

test('卡片 text 为空串/纯空白时在 retrieve、mergeCards、prune 里都被过滤', () => {
  const cards = [
    { id: 'blank', kind: 'event', text: '', importance: 5, createdAt: NOW.toISOString() },
    { id: 'spaces', kind: 'event', text: '   \n\t', importance: 5, createdAt: NOW.toISOString() },
    card('用户喜欢手冲咖啡', { id: 'ok' }),
  ];

  assert.deepEqual(retrieve(cards, '咖啡', { now: NOW }).map((item) => item.id), ['ok']);
  assert.deepEqual(prune(cards, 10).map((item) => item.id), ['ok']);
  const merged = mergeCards(cards, [{ id: 'x', kind: 'fact', text: '  ' }], { now: NOW });
  assert.deepEqual(merged.map((item) => item.id), ['ok']);
});

// ---------- 11. suppress ----------

test('suppress 移除该卡并登记 30 天；同主题文本不会被合并写入', () => {
  const cards = [
    card('用户下周三要交季度方案', { id: 'm-1' }),
    card('用户喜欢手冲咖啡', { id: 'm-2' }),
  ];
  const suppressed = suppress(cards, '用户 下周三要交《季度方案》！', NOW);
  assert.deepEqual(suppressed.map((item) => item.id), ['m-2']);
  assert.equal(cards.length, 2, 'suppress 不改动入参');
  const list = suppressedOf(suppressed);
  assert.equal(list.length, 1);
  assert.equal(list[0].norm, '用户下周三要交季度方案');
  assert.equal(list[0].until, new Date(NOW.getTime() + 30 * DAY).toISOString());

  const within = mergeCards(suppressed, [card('用户下周三要交季度方案，进度慢了')], { now: new Date(NOW.getTime() + 29 * DAY) });
  assert.equal(within.length, 1, '30 天内同主题（逗号连接补充）文本直接丢弃');

  // 三种存放位置都能读到：数组属性、memory.suppressed、memory.cards.suppressed
  assert.equal(suppressedOf({ cards: suppressed }).length, 1);
  assert.equal(suppressedOf({ cards: attachSuppressed([], list), suppressed: [] }).length, 1);
  assert.equal(suppressedOf(null).length, 0);

  const after = mergeCards(suppressed, [card('用户下周三要交季度方案，进度有点慢')], { now: new Date(NOW.getTime() + 31 * DAY) });
  assert.equal(after.length, 2, '过期后可以重新写入');
});

test('suppress 后「用户喜欢猫粮」不落入「用户喜欢猫」的抑制期', () => {
  const suppressed = suppress([card('用户喜欢猫', { id: 'cat' })], '用户喜欢猫', NOW);
  const merged = mergeCards(suppressed, [card('用户喜欢猫粮')], { now: new Date(NOW.getTime() + DAY) });
  assert.equal(merged.length, 1, '「猫粮」是新事实，应能写入');
  assert.equal(merged[0].text, '用户喜欢猫粮');
});

test('suppress 不会误伤仅相似的相邻事实：删「喜欢猫」不影响「喜欢狗」', () => {
  const cards = [card('用户喜欢猫', { id: 'cat' }), card('用户喜欢狗', { id: 'dog' })];
  const left = suppress(cards, '用户喜欢猫', NOW);
  assert.deepEqual(left.map((item) => item.id), ['dog'], '只删归一化后完全相同的那条');

  const registry = suppressedOf(left);
  const blocked = mergeCards(attachSuppressed([], registry), [card('用户喜欢猫')], { now: new Date(NOW.getTime() + DAY) });
  assert.equal(blocked.length, 0, '「用户喜欢猫」在抑制期内不能回流');

  const allowed = mergeCards(attachSuppressed([], registry), [card('用户喜欢狗')], { now: new Date(NOW.getTime() + DAY) });
  assert.equal(allowed.length, 1, '「用户喜欢狗」不在抑制范围内，应能写入');
  assert.equal(allowed[0].text, '用户喜欢狗');
});

test('suppress 用 Spec 原文：同主题改写 30 天内不回流，过期后放行', () => {
  const original = '用户下周三要交一份季度方案';
  const rewrite = '用户下周三要交一份季度方案，还没定结构';
  const cards = [card(original, { id: 'm-1' }), card('用户喜欢手冲咖啡', { id: 'm-2' })];
  const left = suppress(cards, original, NOW);
  assert.deepEqual(left.map((item) => item.id), ['m-2']);

  assert.equal(polarity(rewrite), 1, '「还没」是例外词，不算否定');
  assert.equal(isSameTopic(original, rewrite), true);

  const blocked = mergeCards(left, [card(rewrite)], { now: new Date(NOW.getTime() + 29 * DAY) });
  assert.equal(blocked.length, 1, '同主题改写不能回流');

  const allowed = mergeCards(left, [card(rewrite)], { now: new Date(NOW.getTime() + 31 * DAY) });
  assert.equal(allowed.length, 2, '过期后可以重新写入');
});

test('抑制登记表落盘往返：store 读写后仍能挡住同主题文本，过期后放行', () => {
  const dir = tempDir();
  const id = 'char-1700000000000';

  const cards = [card('用户下周三要交季度方案', { id: 'm-1' }), card('用户喜欢手冲咖啡', { id: 'm-2' })];
  const remaining = suppress(cards, '用户下周三要交季度方案', NOW);
  const suppressed = suppressedOf(remaining);

  // memory.json = { cards, suppressed, lastExtractedMessageId }
  store.writeMemory(dir, id, {
    cards: [...remaining],
    suppressed,
    lastExtractedMessageId: 'msg-9',
  });

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'characters', id, 'memory.json'), 'utf8'));
  assert.equal(raw.cards.length, 1);
  assert.equal(raw.suppressed.length, 1, '登记表必须真的写进 memory.json');
  assert.equal(raw.suppressed[0].norm, '用户下周三要交季度方案');
  assert.equal(raw.lastExtractedMessageId, 'msg-9');

  const memory = store.readMemory(dir, id);
  assert.equal(memory.suppressed.length, 1);
  const restored = attachSuppressed(memory.cards, memory.suppressed);
  assert.deepEqual(suppressedOf(memory), suppressedOf(restored), 'attachSuppressed 能把登记表挂回来');

  const blocked = mergeCards(restored, [card('用户下周三要交季度方案')], { now: new Date(NOW.getTime() + 29 * DAY) });
  assert.equal(blocked.length, 1, '重启后同主题文本不能回流');

  // 显式传 { suppressed } 也生效（优先于数组属性）
  const viaOption = mergeCards(memory.cards, [card('用户下周三要交季度方案')], {
    now: new Date(NOW.getTime() + 29 * DAY),
    suppressed: [{ norm: '用户下周三要交季度方案', until: new Date(NOW.getTime() + 30 * DAY).toISOString() }],
  });
  assert.equal(viaOption.length, 1);

  // 过期后放行
  const expired = mergeCards(memory, [card('用户下周三要交季度方案')], { now: new Date(NOW.getTime() + 31 * DAY) });
  assert.equal(expired.length, 2);

  // suppress 直接接收 memory 对象 → 返回同形状对象，可直接落盘（保留 lastExtractedMessageId）
  const nextMemory = suppress(store.readMemory(dir, id), '用户喜欢手冲咖啡', new Date(NOW.getTime() + 2 * DAY));
  assert.equal(Array.isArray(nextMemory), false);
  assert.equal(nextMemory.cards.length, 0);
  assert.equal(nextMemory.suppressed.length, 2, '既有登记保留并追加新条目');
  assert.equal(nextMemory.lastExtractedMessageId, 'msg-9');
  store.writeMemory(dir, id, nextMemory);
  const reread = store.readMemory(dir, id);
  assert.equal(reread.suppressed.length, 2);
  assert.equal(reread.cards.length, 0);
});

test('store.writeMemory 自动把 cards 数组上的 suppressed 提升到顶层（调用方只传 {cards} 也不丢）', () => {
  const dir = tempDir();
  const id = 'char-1700000000001';
  const cards = suppress(
    [card('用户喜欢猫', { id: 'cat' }), card('用户喜欢狗', { id: 'dog' })],
    '用户喜欢猫',
    NOW,
  );
  assert.equal(suppressedOf(cards).length, 1);

  // 调用方只传 { cards }：登记表挂在 cards 的不可枚举属性上
  store.writeMemory(dir, id, { cards, lastExtractedMessageId: 'msg-1' });
  const file = path.join(dir, 'characters', id, 'memory.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.cards.length, 1);
  assert.equal(raw.suppressed.length, 1, 'cards 上的登记表被提升到顶层');
  assert.equal(raw.suppressed[0].norm, '用户喜欢猫');

  const memory = store.readMemory(dir, id);
  const restored = attachSuppressed(memory.cards, memory.suppressed);
  const blocked = mergeCards(restored, [card('用户喜欢猫')], { now: new Date(NOW.getTime() + DAY) });
  assert.equal(blocked.length, 1, '重启后「用户喜欢猫」被挡住');
  const allowed = mergeCards(restored, [card('用户喜欢狗')], { now: new Date(NOW.getTime() + DAY) });
  assert.equal(allowed.length, 1, '「用户喜欢狗」已存在，合并到同一张卡');

  // 顶层已有 suppressed 时不重复追加
  store.writeMemory(dir, id, { cards, suppressed: raw.suppressed });
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(again.suppressed.length, 1);
});

test('store.writeMemory 抑制表按 norm 归并、保留最大 until、统一 ISO 并清掉重复', () => {
  const dir = tempDir();
  const id = 'char-1700000000002';
  const file = path.join(dir, 'characters', id, 'memory.json');
  const early = new Date(NOW.getTime() + 5 * DAY).toISOString();
  const later = new Date(NOW.getTime() + 40 * DAY).toISOString();

  const cards = attachSuppressed([card('用户喜欢咖啡', { id: 'm-1' })], [
    { norm: '用户喜欢咖啡', until: later },
  ]);
  store.writeMemory(dir, id, {
    cards,
    suppressed: [
      { norm: '用户喜欢咖啡', until: early },
      { norm: '用户喜欢咖啡', until: early }, // 顶层重复项
      { norm: '用户下周三要交季度方案', until: new Date(NOW.getTime() + 3 * DAY) }, // Date → ISO
    ],
    lastExtractedMessageId: null,
  });

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.suppressed.length, 2, '按 norm 归并（咖啡由 2 条并成 1 条）');
  const coffee = raw.suppressed.find((entry) => entry.norm === '用户喜欢咖啡');
  assert.equal(coffee.until, later, '保留较大的 until');
  const quarter = raw.suppressed.find((entry) => entry.norm === '用户下周三要交季度方案');
  assert.equal(quarter.until, new Date(NOW.getTime() + 3 * DAY).toISOString(), 'Date 统一转 ISO 字符串');
  assert.equal(typeof quarter.until, 'string');
});

test('store.writeMemory 收到数组时自动包装为 { cards, suppressed }，不再写成空 memory', () => {
  const dir = tempDir();
  const id = 'char-1700000000003';
  const file = path.join(dir, 'characters', id, 'memory.json');

  const remaining = suppress([card('用户喜欢猫', { id: 'cat' })], '用户喜欢猫', NOW);
  store.writeMemory(dir, id, remaining);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.cards, []);
  assert.equal(raw.suppressed.length, 1);
  assert.equal(raw.suppressed[0].norm, '用户喜欢猫');
  assert.equal(raw.lastExtractedMessageId, null);

  // 普通数组：卡片要能写进去，且磁盘上已有的抑制表不能被清空
  store.writeMemory(dir, id, [card('用户喜欢狗', { id: 'dog' })]);
  const back = store.readMemory(dir, id);
  assert.equal(back.cards.length, 1);
  assert.equal(back.cards[0].text, '用户喜欢狗');
  assert.equal(back.suppressed.length, 1, '数组输入不应清空已有抑制表');
  assert.equal(back.suppressed[0].norm, '用户喜欢猫');
});

// ---------- 12. extractFromChat：围栏解析 ----------

test('extractFromChat 能剥 ```json 围栏与前后说明文字，并带角色设定给 system', async (t) => {
  const calls = [];
  mockLlm(t, {
    chat: async (options) => {
      calls.push(options);
      return {
        text: '好的，下面是结果：\n```json\n[{"kind":"event","text":"用户下周三要交季度方案","importance":4},{"kind":"preference","text":"用户喜欢手冲咖啡","importance":2}]\n```\n以上。',
        usage: { promptTokens: 10, completionTokens: 20, estimated: false },
        model: 'm',
      };
    },
  });

  const character = {
    name: '她',
    persona: {
      traits: ['温柔', '有点懒'],
      speechStyle: '短句口语',
      background: '住在上海徐汇，自由插画师',
      relationship: '认识很久的朋友',
      boundaries: ['不编造没发生过的事'],
    },
  };

  const cards = await extractFromChat({
    character,
    messages: [{ id: 'msg-1', role: 'user', text: '下周要交季度方案，结构还没定' }],
    existing: [],
    profile,
  });

  assert.equal(cards.length, 2);
  assert.equal(cards[0].kind, 'event');
  assert.equal(cards[0].text, '用户下周三要交季度方案');
  assert.equal(cards[0].importance, 4);
  assert.match(cards[0].id, /^m-\d+-\d+$/);
  assert.equal(cards[0].hits, 1);
  assert.equal(cards[0].sourceMessageId, 'msg-1');
  assert.equal(cards[0].embedding, null);
  assert.ok(!Number.isNaN(new Date(cards[0].createdAt).getTime()));

  assert.equal(calls.length, 1);
  const sent = calls[0].messages;
  assert.equal(sent[0].role, 'system');
  assert.match(sent[0].content, /角色设定/);
  assert.match(sent[0].content, /自由插画师/);
  assert.match(sent[0].content, /只输出 JSON 数组/);
  assert.match(sent.map((item) => item.content).join('\n'), /下周要交季度方案/);
});

test('extractFromChat 解析失败重试 1 次；第二次成功则返回结果，一直失败返回 []', async (t) => {
  let attempt = 0;
  mockLlm(t, {
    chat: async () => {
      attempt += 1;
      if (attempt === 1) return { text: '我先想想……', usage: null, model: 'm' };
      return { text: '[{"kind":"fact","text":"用户养了一只猫","importance":3}]', usage: null, model: 'm' };
    },
  });

  const cards = await extractFromChat({
    messages: [{ role: 'user', text: '我家猫今天不吃饭' }],
    profile,
  });
  assert.equal(attempt, 2);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].text, '用户养了一只猫');

  let calls = 0;
  mockLlm(t, {
    chat: async () => {
      calls += 1;
      return { text: '抱歉，我不能输出那个', usage: null, model: 'm' };
    },
  });
  const empty = await extractFromChat({ messages: [{ role: 'user', text: '算了' }], profile });
  assert.deepEqual(empty, []);
  assert.equal(calls, 2, '只重试一次');
});

test('extractFromChat 无 profile 时抛可辨识错误；空对话不发请求', async (t) => {
  await assert.rejects(
    () => extractFromChat({ messages: [{ role: 'user', text: '在吗' }] }),
    (error) => error.code === 'NO_PROFILE' && /profile/.test(error.message),
  );
  await assert.rejects(
    () => extractFromChat({ messages: [{ role: 'user', text: '在吗' }], profile: null }),
    (error) => error.code === 'NO_PROFILE',
  );

  let calls = 0;
  mockLlm(t, { chat: async () => { calls += 1; return { text: '[]' }; } });
  const cards = await extractFromChat({ messages: [], profile });
  assert.deepEqual(cards, []);
  assert.equal(calls, 0);
});

// ---------- 13. extractFromChat：embedding 与 suppressed ----------

test('extractFromChat 传 embeddingProfile 时逐条写向量，单条失败不影响其他条', async (t) => {
  mockLlm(t, {
    chat: async () => ({
      text: '[{"kind":"fact","text":"用户喜欢手冲咖啡","importance":3},{"kind":"event","text":"用户下周三要交季度方案","importance":4}]',
      usage: null,
      model: 'm',
    }),
    embeddings: async ({ input }) => {
      if (input.includes('季度')) throw new Error('这条失败了');
      return [0.1, 0.2, 0.3];
    },
  });

  const cards = await extractFromChat({
    messages: [{ role: 'user', text: '我喜欢手冲咖啡，下周要交季度方案' }],
    profile,
    embeddingProfile,
  });

  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0].embedding, [0.1, 0.2, 0.3]);
  assert.equal(cards[1].embedding, null, '单条失败则该条无向量');
});

test('extractFromChat 丢弃被 suppress 的文本与空文本，重复文本保留 importance 较大的那条', async (t) => {
  // suppress 的有效期按「真实现在」判断（extractFromChat 内部不接收 now），
  // 所以这里的登记时间必须跟着真实时间走，否则跨过 30 天后这条测试会自己失效。
  const suppressedCards = suppress([], '用户下周三要交季度方案', new Date());
  mockLlm(t, {
    chat: async () => ({
      text: JSON.stringify([
        { kind: 'event', text: '用户下周三要交《季度方案》！', importance: 4 },
        { kind: 'fact', text: '用户喜欢手冲咖啡', importance: 0 },
        { kind: 'fact', text: '   ', importance: 3 },
        { kind: 'preference', text: '用户喜欢手冲咖啡！', importance: '3' },
        { kind: 'fact', text: '用户养了一只猫', importance: 6 },
        { kind: 'fact', text: '用户对花生过敏', importance: null },
      ]),
      usage: null,
      model: 'm',
    }),
  });

  const cards = await extractFromChat({
    messages: [{ role: 'user', text: '一堆信息' }],
    existing: suppressedCards,
    profile,
  });

  assert.deepEqual(cards.map((item) => item.text), ['用户喜欢手冲咖啡', '用户养了一只猫', '用户对花生过敏']);
  assert.equal(cards[0].importance, 3, '重复项保留 importance 较大的那条（0 与 3 取 3）');
  assert.equal(cards[1].importance, 5);
  assert.equal(cards[2].importance, 3);
  assert.deepEqual(cards[0].variants, ['用户喜欢手冲咖啡']);

  // suppressed 过期后同一文本可以重新抽出
  const expired = suppress([], '用户下周三要交季度方案', new Date(Date.now() - 31 * DAY));
  const again = await extractFromChat({
    messages: [{ role: 'user', text: '下周要交季度方案' }],
    existing: expired,
    profile,
  });
  assert.equal(again.length, 4, '过期后 4 条都能写入（重复项已合并成一条）');
});

// ---------- 14. extractFromChat：裸数组 / 对象包装 / 详细字段 ----------

test('extractFromChat 兼容前后夹说明的裸数组与 {cards:[...]} 包装', async (t) => {
  mockLlm(t, {
    chat: async () => ({ text: '结果如下\n[{"kind":"relation","text":"用户和妈妈关系很好","importance":5}]\n希望有用', usage: null, model: 'm' }),
  });
  const bare = await extractFromChat({ messages: [{ role: 'user', text: '我妈今天来' }], profile });
  assert.equal(bare.length, 1);
  assert.equal(bare[0].kind, 'relation');

  mockLlm(t, {
    chat: async () => ({ text: JSON.stringify({ cards: [{ kind: 'fact', text: '用户住在徐汇', importance: 2 }] }), usage: null, model: 'm' }),
  });
  const wrapped = await extractFromChat({ messages: [{ role: 'user', text: '我住徐汇' }], profile });
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].text, '用户住在徐汇');
});

test('extractFromChat：超 300 字素截断为「头 200 + 标记 + 尾 60」，尾部事实不被砍掉', async (t) => {
  const body = '这是一段很长的背景描述'.repeat(30); // 300 字
  const middle = '中间填充内容'.repeat(40); // 240 字
  const fact = '用户对花生严重过敏';
  const long = `${body}${middle}${fact}`;
  assert.ok(Array.from(long).length > MAX_CARD_CHARS);

  mockLlm(t, {
    chat: async () => ({
      text: `参考[1]：以下是整理结果\n[{"kind":"fact","text":"${long}","importance":5}]\n（完）`,
      usage: null,
      model: 'm',
    }),
  });

  const cards = await extractFromChat({ messages: [{ role: 'user', text: '说了很长一段' }], profile });
  assert.equal(cards.length, 1, '不能被说明文字里的 [1] 干扰');

  const text = cards[0].text;
  const clusters = Array.from(long);
  assert.ok(text.includes(TRUNCATE_MARKER));
  assert.ok(text.startsWith(clusters.slice(0, CARD_HEAD_CHARS).join('')), '保留头部 200 字');
  assert.ok(text.endsWith(clusters.slice(-CARD_TAIL_CHARS).join('')), '保留尾部 60 字');
  assert.ok(text.endsWith(fact), '尾部关键事实仍在');

  // 标记不参与相似度/抑制归一化
  assert.equal(normalizeText(text).includes('内容过长已截断'), false);
  assert.equal(
    normalizeText(text),
    normalizeText(long).slice(0, CARD_HEAD_CHARS) + normalizeText(long).slice(-CARD_TAIL_CHARS),
  );
});

test('extractFromChat：字素级截断不会把 emoji 劈成半个', async (t) => {
  const long = `👨‍👩‍👧‍👦${'内容'.repeat(200)}`;
  mockLlm(t, {
    chat: async () => ({
      text: `[{"kind":"fact","text":"${long}","importance":3}]`,
      usage: null,
      model: 'm',
    }),
  });
  const cards = await extractFromChat({ messages: [{ role: 'user', text: 'x' }], profile });
  const text = cards[0].text;
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false);
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), false);
  // ZWJ 家族 emoji 不能被切开
  assert.equal(text.includes('\u200d\u2026'), false);
});

// ---------- 14b. parseCards：硬上限与候选挑选 ----------

test('parseCards：20000 个未闭合 [ 在 50ms 内返回 null（单次栈扫描）', () => {
  const start = process.hrtime.bigint();
  const result = parseCards('['.repeat(20000));
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(result, null);
  assert.ok(elapsedMs < 50, `耗时 ${elapsedMs.toFixed(1)}ms，超过 50ms`);
});

test('parseCards：深层嵌套 / 超长输入 / 候选超限都快速返回 null', () => {
  const started = process.hrtime.bigint();
  assert.equal(parseCards(`${'['.repeat(3000)}${']'.repeat(3000)}`), null);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 50, `嵌套 3000 层耗时 ${elapsedMs.toFixed(1)}ms`);

  assert.equal(parseCards('x'.repeat(MAX_PARSE_BYTES + 1)), null);
  const tooMany = Array.from({ length: MAX_PARSE_CANDIDATES + 1 }, () => '[1]').join(' ');
  assert.equal(parseCards(tooMany), null);
});

test('parseCards：对象包装优先取 cards、示例数组在前会跳过、深层嵌套能取到', () => {
  const cards = [{ kind: 'fact', text: '用户喜欢手冲咖啡', importance: 3 }];
  const json = JSON.stringify(cards);

  assert.deepEqual(
    parseCards(`说明：{"notes":[{"kind":"note"}],"cards":${json}}`),
    cards,
    '{"notes":[...],"cards":[...]} 取 cards',
  );
  assert.deepEqual(
    parseCards(`示例：[{"kind":"note"}]\n结果：${json}`),
    cards,
    '没有 text 字段的示例数组要跳过',
  );
  assert.deepEqual(parseCards(`[[[${json}]]]`), cards, '深层嵌套数组能取到内层卡片');
  assert.deepEqual(parseCards(`\`\`\`json\n${json}\n\`\`\``), cards);
  assert.deepEqual(parseCards('[]'), [], '明确的空数组是合法结果');
});

test('parseCards：带 kind 的候选优先于只有 text 的示例', () => {
  const example = [{ text: '这是说明文字' }];
  const real = [{ kind: 'fact', text: '用户喜欢咖啡', importance: 3 }];

  assert.deepEqual(parseCards(`${JSON.stringify(example)}\n${JSON.stringify(real)}`), real, '示例在前也要选带 kind 的');
  assert.deepEqual(parseCards(JSON.stringify(example)), example, '找不到带 kind 的才退回带 text 的');
  assert.deepEqual(
    parseCards(`{"cards":${JSON.stringify(real)}}`),
    real,
  );
});

// ---------- 15. 参数容错 ----------

test('retrieve / scoreCard / mergeCards 对非法入参不抛错', () => {
  assert.deepEqual(retrieve(null, '咖啡'), []);
  assert.deepEqual(retrieve([null, undefined, {}], '咖啡'), []);
  assert.equal(scoreCard(null, '咖啡'), 0);
  assert.equal(scoreCard({ text: '用户喜欢咖啡' }, null, { now: '不是日期' }) > 0, true);
  assert.deepEqual(mergeCards(null, null), []);
  assert.equal(prune([{ text: 'x' }], -1).length, 1);
  assert.doesNotThrow(() => suppress(null, null));
});

// ---------- 16. 同主题判定真值表（与 Spec 7.2 / 7.4 对齐） ----------

test('isSameTopic 真值表：应合并的正例', () => {
  const cases = [
    ['用户下周三要交一份季度方案', '用户下周三要交一份季度方案，还没定结构'],
    ['用户下周三要交一份季度方案', '用户下周三要交一份季度方案，还没定结构。'],
    ['用户住在徐汇', '用户住在徐汇区'],
    ['用户住在徐汇', '用户住在徐汇区。'],
    ['用户喜欢咖啡', '用户喜欢咖啡和戚风蛋糕'],
    ['用户喜欢咖啡', '用户喜欢咖啡和戚风蛋糕。'],
    ['用户喜欢咖啡', '用户喜欢咖啡，味道很好。'],
    ['用户喜欢手冲咖啡', '用户喜欢手冲咖啡啊'],
    ['用户喜欢手冲咖啡', '用户喜欢手冲咖啡呢'],
    ['用户喜欢手冲咖啡', '用户喜欢手冲咖啡了'],
    ['今天用户喜欢咖啡。', '用户喜欢咖啡'],
    ['用户喜欢在周末喝手冲咖啡', '用户喜欢周末喝手冲咖啡'],
  ];
  for (const [a, b] of cases) {
    assert.equal(isSameTopic(a, b), true, `应合并却判成不同主题：${a} / ${b}`);
  }
});

test('例外词只影响否定判定，不代表必须合并', () => {
  const cases = [
    ['用户喜欢无糖咖啡', '用户喜欢咖啡'],
    ['用户拍照不错', '用户拍照很好'],
    ['用户特别喜欢咖啡', '用户喜欢咖啡'],
    ['用户未来想去杭州', '用户想去杭州'],
  ];
  for (const [a, b] of cases) {
    assert.equal(polarity(a), 1, `被误判成否定：${a}`);
    assert.equal(polarity(b), 1, `被误判成否定：${b}`);
  }
});

test('isSameTopic 真值表：不应合并的反例', () => {
  const cases = [
    ['用户喜欢猫', '用户喜欢猫粮'],
    ['用户喜欢咖啡', '用户喜欢咖啡色'],
    ['用户喜欢咖啡', '用户喜欢咖啡因'],
    ['用户喜欢咖啡', '用户喜欢咖啡味蛋糕'],
    ['用户喜欢咖啡', '用户喜欢咖啡店'],
    ['用户喜欢咖啡', '用户喜欢咖啡馆'],
    ['用户喜欢咖啡', '用户喜欢咖啡。今天去了书店'],
    ['用户养了一只猫', '用户养了一只狗和一只猫'],
    ['用户喜欢猫', '用户喜欢狗'],
    ['用户不喜欢咖啡', '用户喜欢咖啡'],
    ['用户喜欢咖啡', '用户喜欢咖啡，用户住在徐汇'],
    ['用户喜欢咖啡', '用户喜欢咖啡，今天去了书店'],
    ['用户喜欢咖啡', '用户喜欢咖啡，用户是程序员'],
    ['用户喜欢咖啡', '用户喜欢咖啡，咖啡店在楼下'],
    ['用户喜欢咖啡', '用户喜欢咖啡，还没等我说完，用户就走了'],
    ['用户喜欢咖啡', '用户喜欢咖啡，结果用户去了书店'],
    ['用户喜欢咖啡', '用户喜欢咖啡，感觉他觉得咖啡太苦'],
    ['用户喜欢咖啡', '用户喜欢咖啡，但是用户住在徐汇'],
    ['用户喜欢咖啡', '用户喜欢咖啡，所以用户是程序员'],
    ['用户喜欢咖啡', '用户喜欢咖啡，然后用户去了杭州'],
    ['用户喜欢咖啡', '用户喜欢咖啡，因为用户住在徐汇'],
    ['用户喜欢咖啡', '用户喜欢咖啡，其实用户养了狗'],
    ['用户喜欢咖啡', '用户喜欢咖啡，以后用户想去杭州'],
    ['用户喜欢咖啡', '用户喜欢咖啡，结果下雨了'],
    ['用户喜欢咖啡', '用户喜欢咖啡，感觉今天很累'],
  ];
  for (const [a, b] of cases) {
    assert.equal(isSameTopic(a, b), false, `不该合并却判成同主题：${a} / ${b}`);
  }
});

test('带句号/语气词的改写不会在 suppress 后回流', () => {
  const day = (n) => new Date(NOW.getTime() + n * DAY);
  const memory = { cards: [card('用户下周三要交一份季度方案', { id: 'q1' })], lastExtractedMessageId: 'msg-1' };
  const suppressed = suppress(memory, '用户下周三要交一份季度方案', NOW);
  const after29 = mergeCards(suppressed, [{ kind: 'event', text: '用户下周三要交一份季度方案，还没定结构。', importance: 4 }], { now: day(29) });
  assert.equal(after29.filter((c) => /还没定结构/.test(c.text)).length, 0, '29 天内带句号的改写仍回流了');
  const after31 = mergeCards(suppressed, [{ kind: 'event', text: '用户下周三要交一份季度方案，还没定结构。', importance: 4 }], { now: day(31) });
  assert.equal(after31.filter((c) => /还没定结构/.test(c.text)).length, 1, '31 天后应当放行');
});

test('suppress「喜欢猫」不会拦下「喜欢猫粮」', () => {  const memory = { cards: [card('用户喜欢猫', { id: 'cat' })], lastExtractedMessageId: 'msg-2' };
  const suppressed = suppress(memory, '用户喜欢猫', NOW);
  const merged = mergeCards(suppressed, [{ kind: 'preference', text: '用户喜欢猫粮', importance: 3 }], { now: NOW });
  assert.equal(merged.filter((c) => c.text === '用户喜欢猫粮').length, 1);
  assert.equal(merged.filter((c) => c.text === '用户喜欢猫').length, 0);
});
