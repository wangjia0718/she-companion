'use strict';

// prompt.js 测试：覆盖计划 Task 4 的 6 个必要点，外加：
// - character 缺字段 / 空 memories / 空 history 不抛异常
// - memories 为空时没有空的「记忆」标题
// - 历史里连续两条 user 按原样保留、不串位
// - 预算小于人格块时的明确行为（返回截断结果 + budgetOverflow 标记，不抛错）
// - 中文标点、换行、emoji 不影响字符预算计算，也不会把 emoji 劈成半个

const { test } = require('node:test');
const assert = require('node:assert');

const {
  estimateChars,
  buildChatMessages,
  buildExtractMessages,
  buildScheduleMessages,
  buildDiscoveryMessages,
  buildDiaryMessages,
  buildProactiveMessages,
  trimToBudget,
  TRUNCATE_MARKER,
} = require('../src/main/prompt');

// 2026-10-26 是星期一，本地时间 21:03
const NOW = new Date(2026, 9, 26, 21, 3);

function baseCharacter(extra = {}) {
  return {
    name: '她',
    persona: {
      traits: ['温柔', '有点懒', '观察细'],
      speechStyle: '短句、口语、不用书面词',
      catchphrases: ['嗯…', '刚回来'],
      background: '住在上海徐汇，自由插画师，养一只猫',
      relationship: '认识很久的朋友，说话不用客套',
      boundaries: ['不编造没发生过的事', '不假装记得用户没说过的事'],
      likes: ['手冲咖啡', '旧书店'],
      dislikes: ['被催', '应酬'],
    },
    life: {
      city: '上海',
      home: '徐汇的小房子',
      occupation: '自由插画师',
      hobbies: ['逛书店', '手冲咖啡'],
      tone: '松弛',
    },
    ...extra,
  };
}

function baseToday() {
  return {
    schedule: [
      { time: '08:30', activity: '做早饭，煎蛋和吐司' },
      { time: '14:00', activity: '在窗边画稿' },
      { time: '20:00', activity: '下楼走走' },
    ],
    events: [
      { time: '08:31', text: '她把煎蛋盛到盘子里，顺手开了窗。', mood: '平静' },
    ],
  };
}

function memoryCards(count, { withScore = true } = {}) {
  const cards = [];
  for (let i = 1; i <= count; i += 1) {
    cards.push({
      id: `m-${i}`,
      kind: 'event',
      text: `用户提到第 ${i} 件事，细节是${'补充说明'.repeat(16)}`,
      importance: Math.min(5, Math.ceil(i / 6)),
      ...(withScore ? { score: i } : {}),
      createdAt: new Date(2026, 9, 1, 9, 0, i).toISOString(),
    });
  }
  return cards;
}

function historyRounds(count) {
  const history = [];
  for (let i = 0; i < count; i += 1) {
    history.push({ role: 'user', text: `第${i}轮用户的话` });
    history.push({ role: 'assistant', text: `第${i}轮她的回答` });
  }
  return history;
}

const kindOf = (message) => message.kind || '';
const contentsOf = (messages) => messages.map((message) => message.content).join('\n');
const memoryLines = (messages) => messages
  .filter((message) => kindOf(message) === 'memory')
  .flatMap((message) => message.content.split('\n').filter((line) => line.startsWith('- ')));

// ---------- 1. 人格块与输出约束永不裁剪 ----------

test('人格块与输出约束在任何裁剪下都保留，且 pinned 标记可用', () => {
  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: memoryCards(30),
    today: baseToday(),
    history: historyRounds(40),
    userText: '今天有点累',
    now: NOW,
    budgetChars: 900,
  });

  assert.ok(estimateChars(messages) <= 900);
  const first = messages[0];
  const last = messages[messages.length - 1];

  assert.equal(first.role, 'system');
  assert.equal(first.pinned, true);
  assert.match(first.content, /她/);
  assert.match(first.content, /不编造没发生过的事/);
  assert.match(first.content, /【边界】/);

  assert.equal(last.role, 'system');
  assert.equal(last.pinned, true);
  assert.match(last.content, /1–3 句/);
  assert.match(last.content, /口语/);
  assert.match(last.content, /不用列表和标题/);
  assert.match(last.content, /不编造用户经历/);
  assert.match(last.content, /不确定就反问/);
  assert.match(last.content, /不复述设定/);

  // 记账字段不可枚举：JSON.stringify 之后不会把 pinned/kind/meta 发给模型
  assert.deepEqual(Object.keys(first).sort(), ['content', 'role']);
  assert.equal(JSON.stringify(first).includes('pinned'), false);
});

// ---------- 2. 30 条记忆 + 40 轮历史不超预算 ----------

test('30 条记忆卡 + 40 轮历史时输出不超预算', () => {
  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: memoryCards(30),
    today: baseToday(),
    history: historyRounds(40),
    userText: '在吗',
    now: NOW,
    budgetChars: 1500,
  });

  assert.ok(estimateChars(messages) <= 1500, `实际 ${estimateChars(messages)}`);
  assert.ok(messages.length >= 4, '人格/此刻/用户/约束至少要在');
  assert.equal(messages[0].pinned, true);
  assert.equal(messages[messages.length - 1].pinned, true);
});

// ---------- 3. 裁剪顺序：低分记忆 → 更早的对话轮 ----------

test('裁剪顺序：先丢低分记忆，再丢更早的对话轮', () => {
  const cards = [];
  for (let i = 1; i <= 5; i += 1) {
    cards.push({
      id: `c-${i}`,
      kind: 'event',
      text: `记忆卡片${i}：${'很长的细节描述'.repeat(12)}`,
      score: i,
      importance: i,
      createdAt: new Date(2026, 9, i, 9, 0, 0).toISOString(),
    });
  }

  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: cards,
    today: baseToday(),
    history: historyRounds(20),
    userText: '嗯',
    now: NOW,
    budgetChars: 700,
  });

  assert.ok(estimateChars(messages) <= 700, `实际 ${estimateChars(messages)}`);

  const lines = memoryLines(messages);
  assert.ok(lines.length >= 1, '至少保留一张记忆卡');
  assert.ok(lines.some((line) => line.includes('记忆卡片5')), '分数最高的卡必须留下');
  assert.ok(lines.every((line) => !line.includes('记忆卡片1')), '分数最低的卡先被丢掉');
  assert.ok(lines.every((line) => !line.includes('记忆卡片2')));

  // 历史：早期轮次被丢，最后一轮保留
  const text = contentsOf(messages);
  assert.equal(text.includes('第0轮用户的话'), false);
  assert.match(text, /第19轮用户的话/);
});

// ---------- 4. 超长 userText 中间截断 ----------

test('20000 字 userText 被截断到预算内且带标记', () => {
  const longText = '这是一段很长的输入，包含中文标点、换行和 emoji 😀。\n'.repeat(800);
  assert.ok(longText.length > 20000, `构造的输入长度 ${longText.length}`);

  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: [],
    today: baseToday(),
    history: [],
    userText: longText,
    now: NOW,
    budgetChars: 12000,
  });

  const user = messages.find((message) => kindOf(message) === 'user');
  assert.ok(user, '必须还有用户输入');
  assert.ok(user.content.includes(TRUNCATE_MARKER), '必须带截断标记');
  assert.ok(user.content.length < longText.length);
  assert.ok(estimateChars(messages) <= 12000, `实际 ${estimateChars(messages)}`);
  // 头尾都保留
  assert.ok(longText.startsWith(user.content.slice(0, 20)));
  assert.ok(longText.endsWith(user.content.slice(-20)));
});

// ---------- 5. 记忆格式 ----------

test('记忆块格式为 `- [事件] 内容`，按 createdAt 正序', () => {
  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: [
      { id: 'a', kind: 'event', text: '用户下周三要交季度方案', score: 2, createdAt: '2026-10-20T10:00:00+08:00' },
      { id: 'b', kind: 'preference', text: '用户喜欢手冲咖啡', score: 3, createdAt: '2026-10-19T10:00:00+08:00' },
    ],
    today: baseToday(),
    history: [],
    userText: '在吗',
    now: NOW,
  });

  const text = contentsOf(messages);
  assert.match(text, /- \[事件\] 用户下周三要交季度方案/);
  assert.match(text, /- \[偏好\] 用户喜欢手冲咖啡/);
  assert.match(text, /【记忆】/);
  // 正序：更早的偏好卡在前
  assert.ok(text.indexOf('[偏好]') < text.indexOf('[事件]'));
});

// ---------- 6. 抽取提示词 ----------

test('buildExtractMessages 要求只输出 JSON 数组并带上已有卡片摘要', () => {
  const messages = buildExtractMessages({
    character: baseCharacter(),
    messages: historyRounds(2),
    existingCards: [
      { id: 'm-1', kind: 'event', text: '用户下周三要交季度方案' },
      { id: 'm-2', kind: 'preference', text: '用户喜欢手冲咖啡' },
    ],
  });

  assert.equal(messages.length, 2);
  const system = messages[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /只输出 JSON 数组/);
  assert.match(contentsOf(messages), /m-1/);
  assert.match(contentsOf(messages), /用户下周三要交季度方案/);
  assert.match(contentsOf(messages), /第1轮用户的话/);
});

// ---------- 7. 缺字段 / 空数据不抛异常 ----------

test('character 缺字段、memories/history 为空时不抛异常', () => {
  const bare = { name: '她' };
  const messages = buildChatMessages({
    character: bare,
    memories: [],
    today: undefined,
    history: [],
    userText: '在吗',
    now: NOW,
  });

  assert.ok(messages.length >= 3);
  assert.match(messages[0].content, /她/);
  assert.match(contentsOf(messages), /在吗/);

  // 连 character 都没有也不该炸
  const noCharacter = buildChatMessages({ userText: '你好', now: NOW });
  assert.match(noCharacter[0].content, /「她」/);
});

// ---------- 8. 空记忆不出现空标题 ----------

test('memories 为空时「记忆」块完全不出现', () => {
  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: [],
    today: baseToday(),
    history: [],
    userText: '在吗',
    now: NOW,
  });

  assert.equal(messages.some((message) => kindOf(message) === 'memory'), false);
  assert.equal(contentsOf(messages).includes('【记忆】'), false);

  // 卡片全是空文本 / 非法结构时同样不出现
  const blank = buildChatMessages({
    character: baseCharacter(),
    memories: [{ kind: 'event', text: '   ' }, null, {}],
    today: baseToday(),
    history: [],
    userText: '在吗',
    now: NOW,
  });
  assert.equal(blank.some((message) => kindOf(message) === 'memory'), false);
});

// ---------- 9. 角色交替错乱按原样保留 ----------

test('history 连续两条 user 时按原样保留、不串位', () => {
  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: [],
    today: baseToday(),
    history: [
      { role: 'user', text: '第一句' },
      { role: 'user', text: '第二句' },
      { role: 'assistant', text: '回一句' },
      { role: 'user', text: '第三句' },
    ],
    userText: '现在这句',
    now: NOW,
    budgetChars: 12000,
  });

  const history = messages.filter((message) => kindOf(message) === 'history');
  assert.deepEqual(history.map((message) => message.role), ['user', 'user', 'assistant', 'user']);
  assert.deepEqual(
    history.map((message) => message.content),
    ['第一句', '第二句', '回一句', '第三句'],
  );
  // 本轮输入始终在历史之后、约束之前
  const lastUser = messages[messages.length - 2];
  assert.equal(lastUser.role, 'user');
  assert.equal(lastUser.content, '现在这句');
});

// ---------- 10. 预算小于人格块 ----------

test('预算小于人格块时：人格与约束仍保留，返回截断结果并标记 budgetOverflow（不抛错）', () => {
  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: memoryCards(10),
    today: baseToday(),
    history: historyRounds(10),
    userText: '在吗',
    now: NOW,
    budgetChars: 40,
  });

  // 约定行为：不抛异常；pinned 块保留，其余尽量丢；返回数组带 budgetOverflow=true
  assert.equal(messages.budgetOverflow, true);
  assert.equal(messages[0].pinned, true);
  assert.match(messages[0].content, /不编造没发生过的事/);
  const last = messages[messages.length - 1];
  assert.equal(last.pinned, true);
  assert.match(last.content, /【输出要求】/);
  assert.equal(messages.some((message) => kindOf(message) === 'history'), false);
  assert.equal(messages.some((message) => kindOf(message) === 'memory'), false);
});

// ---------- 11. 标点 / 换行 / emoji 预算 ----------

test('中文标点、换行、emoji 的字符预算计算稳定，emoji 不会被劈开', () => {
  const sample = '中文，标点。\n😀';
  assert.equal(estimateChars([{ role: 'user', content: sample }]), 8);
  assert.equal(estimateChars([{ role: 'user', content: 'abc' }]), 3);
  assert.equal(estimateChars([]), 0);
  assert.equal(estimateChars(null), 0);

  const emojiText = '😀'.repeat(6000);
  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: [],
    today: baseToday(),
    history: [],
    userText: emojiText,
    now: NOW,
    budgetChars: 2000,
  });
  const user = messages.find((message) => kindOf(message) === 'user');

  assert.ok(user.content.includes(TRUNCATE_MARKER));
  assert.ok(estimateChars(messages) <= 2000);
  // 不能出现落单的代理项（半个 emoji）
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(user.content), false);
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(user.content), false);
});

// ---------- 12. 日程明细裁剪 ----------

test('日程明细裁剪时只留当前一条', () => {
  const base = buildChatMessages({
    character: baseCharacter(),
    memories: [],
    today: baseToday(),
    history: [],
    userText: '',
    now: NOW,
    budgetChars: 12000,
  });
  const baseline = estimateChars(base);

  const trimmed = buildChatMessages({
    character: baseCharacter(),
    memories: [],
    today: baseToday(),
    history: [],
    userText: '',
    now: NOW,
    budgetChars: baseline - 1,
  });

  const moment = trimmed.find((message) => kindOf(message) === 'moment');
  assert.ok(moment);
  const scheduleLines = moment.content.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(scheduleLines.length, 1);
  // 21:03 时当前日程是 20:00 那条
  assert.match(scheduleLines[0], /20:00 下楼走走/);
  assert.equal(moment.content.includes('08:30'), false);
});

// ---------- 13. trimToBudget 直接调用 ----------

test('trimToBudget 接受自定义 dropOrder，不改动入参，且可重复调用', () => {
  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: memoryCards(10),
    today: baseToday(),
    history: historyRounds(10),
    userText: '在吗',
    now: NOW,
    budgetChars: 12000,
  });
  const before = estimateChars(messages);

  const trimmed = trimToBudget(messages, 600, { dropOrder: ['history', 'schedule', 'memory'] });
  assert.ok(estimateChars(trimmed) <= 600);
  assert.equal(estimateChars(messages), before, '原数组不能被改动');
  assert.equal(trimmed[0].pinned, true);

  const again = trimToBudget(trimmed, 400);
  assert.ok(estimateChars(again) <= 400);
  assert.equal(again.budgetOverflow, false);

  // 非法 dropOrder 回落默认顺序，不抛错
  assert.doesNotThrow(() => trimToBudget(messages, 500, { dropOrder: ['nope'] }));
  assert.doesNotThrow(() => trimToBudget(null, 500));
  assert.deepEqual(trimToBudget(null, 500), []);
});

// ---------- 14. 其余三类提示词 ----------

test('buildScheduleMessages 要求只输出 JSON 且带上角色与日期', () => {
  const messages = buildScheduleMessages({ character: baseCharacter(), date: '2026-10-27' });
  const system = messages[0];
  assert.match(system.content, /只输出 JSON 数组/);
  assert.match(system.content, /HH:MM/);
  assert.match(system.content, /3–5 条/);
  assert.match(contentsOf(messages), /2026-10-27/);
  assert.match(contentsOf(messages), /上海/);
});

test('buildDiaryMessages 限制 100–180 字并带上事件与最近的对话', () => {
  const messages = buildDiaryMessages({
    character: baseCharacter(),
    date: '2026-10-26',
    events: [{ time: '08:31', text: '她把煎蛋盛到盘子里，顺手开了窗。' }],
    recentChat: [{ role: 'user', content: '今天有点累' }],
  });
  assert.match(messages[0].content, /100–180 字/);
  assert.match(contentsOf(messages), /她把煎蛋盛到盘子里/);
  assert.match(contentsOf(messages), /今天有点累/);
  assert.match(contentsOf(messages), /2026-10-26/);
  // 不许写成流水账、不许照抄素材
  assert.match(messages[0].content, /不要按时间顺序/);
  assert.match(messages[0].content, /不要照抄/);
  assert.match(contentsOf(messages), /素材，不是提纲/);
  // 带上人物与状态
  assert.match(contentsOf(messages), /【我是谁】/);

  // 空 events / 空 recentChat 不抛异常
  const empty = buildDiaryMessages({ character: baseCharacter(), date: '2026-10-26', events: [], recentChat: [] });
  assert.match(contentsOf(empty), /没什么特别的事/);
});

test('buildProactiveMessages 限制 40 字以内且最多带 3 条记忆', () => {
  const messages = buildProactiveMessages({
    character: baseCharacter(),
    now: NOW,
    event: { time: '21:00', text: '刚把稿子改完，眼睛有点酸。' },
    memories: memoryCards(5),
    lastUserText: '我先忙了',
  });
  assert.match(messages[0].content, /≤40 字/);
  const text = contentsOf(messages);
  assert.match(text, /刚把稿子改完/);
  assert.match(text, /我先忙了/);
  assert.match(text, /2026-10-26 21:03/);
  assert.equal(text.includes('用户提到第 4 件事'), false);

  // 无 event / 无记忆时不抛异常
  const bare = buildProactiveMessages({ character: { name: '她' }, now: NOW });
  assert.match(bare[0].content, /≤40 字/);
});

test('buildProactiveMessages 按触发源带素材：节日 / 项目 / 天气 / 昨天关键词 / 睡前', () => {
  const build = (trigger, meta, extra = {}) => buildProactiveMessages({
    character: baseCharacter(), now: NOW, trigger, meta, ...extra,
  });

  const holiday = build('holiday', { holiday: '中秋' });
  assert.match(contentsOf(holiday), /今天是中秋/);
  assert.match(holiday[0].content, /≤40 字/);

  const project = build('project', { project: '读完《夜晚的潜水艇》' });
  assert.match(contentsOf(project), /夜晚的潜水艇/);
  assert.match(contentsOf(project), /今天完成了/);

  const followup = build('followup', { keyword: '牙医' });
  assert.match(contentsOf(followup), /牙医/);
  assert.match(contentsOf(followup), /昨天/);

  const rainy = build('weather', { weather: 'rain' });
  assert.match(contentsOf(rainy), /下雨/);
  const clear = build('weather', { weather: 'clear' });
  assert.match(contentsOf(clear), /放晴/);

  // 天气只能说日级：没给「此刻还在下」时不许自己编实时
  assert.match(rainy[0].content, /没写「此刻还在下」就不要说/);
  assert.match(rainy[0].content, /不要预设对方此刻在外面/);
  assert.equal(contentsOf(rainy).includes('此刻你窗外还在下'), false);

  const rainyNow = build('weather', { weather: 'rain', rainNow: true });
  assert.match(contentsOf(rainyNow), /此刻你窗外还在下/);
  const rainyStopped = build('weather', { weather: 'rain', rainNow: false });
  assert.match(contentsOf(rainyStopped), /此刻雨已经停了/);

  const birthday = build('birthday', {});
  assert.match(contentsOf(birthday), /生日/);

  const bedtime = build('bedtime', { bedInMinutes: 12 });
  assert.match(contentsOf(bedtime), /12 分钟/);
  assert.match(contentsOf(bedtime), /睡觉/);

  // 缺素材时不抛异常，仍带 40 字约束
  const bare = build('holiday', {});
  assert.match(bare[0].content, /≤40 字/);
  assert.equal(contentsOf(bare).includes('中秋'), false);
});

test('buildProactiveMessages：带最近对话和她上一句，回访带对方原话与自己的回复', () => {
  const now = new Date(2026, 10, 1, 9, 18);
  const recentMessages = [
    { role: 'user', text: '睡了么', ts: '2026-10-31T22:37:55+08:00' },
    {
      role: 'assistant',
      text: '还没呢，在阳台蹲着看那盆绿萝，冒出两片新叶子了',
      ts: '2026-10-31T22:38:00+08:00',
    },
    { role: 'user', text: '嗯嗯~你送我的那盆也冒出两片新的~', ts: '2026-10-31T22:38:32+08:00' },
    {
      role: 'assistant',
      text: '噢噢真的啊，那就说明缓过来了。别急着多浇水，土干了再浇就好～',
      ts: '2026-10-31T22:38:35+08:00',
    },
    { role: 'user', text: '晚安良人~', ts: '2026-10-31T22:39:22+08:00' },
  ];

  const messages = buildProactiveMessages({
    character: baseCharacter(),
    now,
    trigger: 'followup',
    meta: {
      keyword: '那盆',
      sourceText: '嗯嗯~你送我的那盆也冒出两片新的~',
      replyText: '噢噢真的啊，那就说明缓过来了。别急着多浇水，土干了再浇就好～',
    },
    recentMessages,
  });
  const text = contentsOf(messages);

  assert.match(text, /【最近聊过】/);
  assert.match(text, /昨天 22:38/);
  assert.match(text, /你：还没呢，在阳台蹲着看那盆绿萝，冒出两片新叶子了/);
  assert.match(text, /对方昨天说的是：「嗯嗯~你送我的那盆也冒出两片新的~」/);
  assert.match(text, /你当时回的是：「噢噢真的啊/);
  assert.match(messages[0].content, /同一件小事不要连着两天反复说/);
  assert.match(messages[0].content, /对方说过的事属于对方的经历/);
  assert.match(messages[0].content, /不要把它安到你身上/);
});

// ---------- 15. 裸 {role, content} 兜底裁剪 ----------

test('trimToBudget 对裸 {role, content} 也能裁剪：20 万字用户输入压到预算内', () => {
  const raw = [{ role: 'user', content: '长'.repeat(200000) }];
  const trimmed = trimToBudget(raw, 12000);

  assert.ok(estimateChars(trimmed) <= 12000, `实际 ${estimateChars(trimmed)}`);
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].role, 'user');
  assert.ok(trimmed[0].content.includes(TRUNCATE_MARKER));
  assert.equal(trimmed.overflow, undefined, '没超预算时不该有可枚举 overflow');
  assert.equal(trimmed.budgetOverflow, false);
  // 入参不被改动
  assert.equal(raw[0].content.length, 200000);
});

test('trimToBudget 保留 pinned system、截断非 pinned 长消息（含裸 assistant）', () => {
  const pinnedText = '人格设定，不可裁剪';
  const trimmed = trimToBudget([
    { role: 'system', content: pinnedText, pinned: true },
    { role: 'system', content: '背景'.repeat(2500) },
    { role: 'assistant', content: '她说过的话'.repeat(600) },
  ], 200);

  assert.ok(estimateChars(trimmed) <= 200, `实际 ${estimateChars(trimmed)}`);
  assert.equal(trimmed[0].content, pinnedText);
  assert.equal(trimmed[0].pinned, true);
  assert.equal(trimmed.budgetOverflow, false);

  const rest = trimmed.slice(1).map((message) => message.content).join('\n');
  assert.ok(rest.includes(TRUNCATE_MARKER), '非 pinned 长消息必须被中间截断');
  assert.equal(rest.includes('背景'.repeat(2500)), false);
});

test('只剩 pinned 且仍超预算时设可枚举 overflow: true，pinned 内容原样保留', () => {
  const pinnedText = '人格'.repeat(100);
  const trimmed = trimToBudget([{ role: 'system', content: pinnedText, pinned: true }], 100);

  assert.ok(estimateChars(trimmed) > 100);
  assert.equal(trimmed[0].content, pinnedText);
  assert.equal(trimmed.overflow, true);
  assert.equal(Object.keys(trimmed).includes('overflow'), true);
  assert.equal(trimmed.budgetOverflow, true);
});

// ---------- 16. 字素级截断 ----------

test('字素级截断：家庭 / 肤色 / VS16 / 彩虹旗在多个预算下都不被劈开', () => {
  const samples = ['👨‍👩‍👧‍👦', '👍🏽', '❤️', '🏳️‍🌈'];
  const isBadBoundary = (codePoint) => codePoint === 0x200d
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
    || codePoint === 0xfe0f
    || codePoint === 0xfe0e;
  const codePoints = (text) => Array.from(text).map((char) => char.codePointAt(0));

  for (const sample of samples) {
    const text = `${sample}${'中文内容与标点，换行\n'.repeat(40)}${sample}`;
    for (let budget = 5; budget <= 160; budget += 1) {
      const trimmed = trimToBudget([{ role: 'user', content: text }], budget);
      const content = trimmed[0].content;
      assert.ok(estimateChars(trimmed) <= budget, `${sample} budget=${budget}`);

      const cut = content.indexOf(TRUNCATE_MARKER);
      const head = cut === -1 ? content : content.slice(0, cut);
      const tail = cut === -1 ? '' : content.slice(cut + TRUNCATE_MARKER.length);

      if (head) {
        const headPoints = codePoints(head);
        assert.equal(
          isBadBoundary(headPoints[headPoints.length - 1]),
          false,
          `${sample} budget=${budget} 头部切在组合符上`,
        );
        assert.ok(head.startsWith(sample), `${sample} budget=${budget} 头部破坏了首个 emoji`);
      }
      if (tail) {
        assert.equal(
          isBadBoundary(codePoints(tail)[0]),
          false,
          `${sample} budget=${budget} 尾部切在组合符上`,
        );
        assert.ok(tail.endsWith(sample), `${sample} budget=${budget} 尾部破坏了最后一个 emoji`);
      }
    }
  }
});

test('无 Intl.Segmenter 时回退到码点切分，仍不产生半个代理对', () => {
  // 在子进程里删掉 Intl.Segmenter 后再 require，真实走到回退分支
  const { execFileSync } = require('node:child_process');
  const modulePath = require('node:path').join(__dirname, '..', 'src', 'main', 'prompt.js');
  const script = [
    'Intl.Segmenter = undefined;',
    `const p = require(${JSON.stringify(modulePath)});`,
    "const r = p.trimToBudget([{ role: 'user', content: '\u{1F600}'.repeat(100) }], 60);",
    'console.log(JSON.stringify({ chars: p.estimateChars(r), content: r[0].content }));',
  ].join('\n');
  const output = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));

  assert.ok(output.chars <= 60);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(output.content), false);
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(output.content), false);
});

// ---------- 17. 可配置 topK / shortTermTurns ----------

test('buildChatMessages 的 topK 与 shortTermTurns 可覆盖默认值', () => {
  const memories = [];
  for (let i = 1; i <= 5; i += 1) {
    memories.push({
      id: `m-${i}`,
      kind: 'event',
      text: `记忆${i}`,
      score: i,
      createdAt: `2026-10-0${i}T10:00:00+08:00`,
    });
  }
  const history = [];
  for (let i = 0; i < 5; i += 1) {
    history.push({ role: 'user', text: `问${i}` });
    history.push({ role: 'assistant', text: `答${i}` });
  }

  const messages = buildChatMessages({
    character: baseCharacter(),
    memories,
    today: baseToday(),
    history,
    userText: '现在',
    now: NOW,
    budgetChars: 12000,
    topK: 2,
    shortTermTurns: 2,
  });

  const lines = memoryLines(messages);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((line) => line.includes('记忆5')));
  assert.ok(lines.some((line) => line.includes('记忆4')));
  assert.equal(lines.some((line) => line.includes('记忆1')), false);

  const historyMessagesInResult = messages.filter((message) => kindOf(message) === 'history');
  assert.deepEqual(
    historyMessagesInResult.map((message) => message.content),
    ['问3', '答3', '问4', '答4'],
  );

  // 不传时仍是默认 12：5 条记忆全部保留
  const defaults = buildChatMessages({
    character: baseCharacter(), memories, today: baseToday(), history, userText: '现在', now: NOW, budgetChars: 12000,
  });
  assert.equal(memoryLines(defaults).length, 5);
  assert.equal(defaults.filter((message) => kindOf(message) === 'history').length, 10);
});

// ---------- 18. 抽取提示语不再要求 mergeOf ----------

test('buildExtractMessages 不再要求模型输出 mergeOf（memory.js 不读该字段）', () => {
  const messages = buildExtractMessages({
    character: baseCharacter(),
    messages: historyRounds(1),
    existingCards: [{ id: 'm-1', kind: 'event', text: '已有内容' }],
  });
  assert.match(messages[0].content, /只输出 JSON 数组/);
  assert.equal(contentsOf(messages).includes('mergeOf'), false);
});

// ---------- 19. 摘要允许截断单条最近消息 ----------

test('summarizeHistory 在最近消息本身超长时仍产出截断摘要（不整条丢弃）', () => {
  const base = buildChatMessages({
    character: baseCharacter(),
    memories: [],
    today: baseToday(),
    history: [],
    userText: '',
    now: NOW,
    budgetChars: 12000,
  });
  const baseChars = estimateChars(base);

  const trimmed = buildChatMessages({
    character: baseCharacter(),
    memories: [],
    today: baseToday(),
    history: [
      { role: 'user', text: '问'.repeat(500) },
      { role: 'assistant', text: '答'.repeat(500) },
    ],
    userText: '',
    now: NOW,
    budgetChars: baseChars + 60,
  });

  assert.ok(estimateChars(trimmed) <= baseChars + 60, `实际 ${estimateChars(trimmed)}`);
  const summary = trimmed.find((message) => message.content.includes('【最近对话摘要】'));
  assert.ok(summary, '必须保留一条摘要，而不是把历史整条丢掉');
  assert.match(summary.content, /用户：问/);
  assert.ok(summary.content.includes(TRUNCATE_MARKER));
  assert.equal(trimmed.some((message) => kindOf(message) === 'history'), false);
});

// ---------- 20. 记账字段仍不可枚举 ----------

test('pinned / kind / meta 不可枚举，不会进入请求体', () => {
  const messages = buildChatMessages({
    character: baseCharacter(),
    memories: memoryCards(3),
    today: baseToday(),
    history: historyRounds(2),
    userText: '在吗',
    now: NOW,
    budgetChars: 12000,
  });
  for (const message of messages) {
    assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
  }
  const json = JSON.stringify(messages);
  for (const key of ['"pinned"', '"kind"', '"meta"']) {
    assert.equal(json.includes(key), false, `请求体里不应出现 ${key}`);
  }

  const trimmed = trimToBudget([{ role: 'user', content: '长'.repeat(5000) }], 500);
  assert.deepEqual(Object.keys(trimmed[0]).sort(), ['content', 'role']);
});

// ---------- 21. 内在设定注入（P1） ----------

function innerCharacter(inner) {
  const base = baseCharacter();
  return {
    ...base,
    persona: { ...base.persona, inner },
  };
}

test('persona 文本含【内在】，traits 用「、」、boundaries 用「；」，且不出现「星座」二字', () => {
  const character = innerCharacter({
    zodiac: '双子座',
    profile: { social: 38, structure: 62, openness: 71, pace: 45, expressiveness: 55 },
    traits: ['不喜欢人多的地方', '答应的事会记很久', '忽然想到什么就会去做'],
    boundaries: ['不主动提自己的生日', '不编造没发生过的事'],
    generatedAt: '2026-10-27T10:00:00+08:00',
    source: 'auto',
  });

  const messages = buildChatMessages({
    character,
    memories: [],
    today: baseToday(),
    history: [],
    userText: '在吗',
    now: NOW,
  });
  const personaText = messages[0].content;

  assert.match(personaText, /【内在】/);
  assert.match(personaText, /不喜欢人多的地方；答应的事会记很久；忽然想到什么就会去做/);
  assert.match(personaText, /不主动提自己的生日；不编造没发生过的事/);
  assert.match(personaText, /不要主动提起/);

  // 星座只做生成依据：名字与「星座」二字都不能进提示词
  assert.equal(personaText.includes('星座'), false);
  assert.equal(personaText.includes('双子'), false);
});

test('persona 文本会过滤掉含星座词的 traits / boundaries', () => {
  const character = innerCharacter({
    zodiac: '天蝎座',
    profile: { social: 30, structure: 65, openness: 55, pace: 45, expressiveness: 30 },
    traits: ['不喜欢人多的地方', '天蝎座的人都很记仇'],
    boundaries: ['不主动提自己的星座', '不编造没发生过的事'],
    generatedAt: '2026-10-27T10:00:00+08:00',
    source: 'manual',
  });

  const messages = buildChatMessages({ character, memories: [], today: null, history: [], userText: '在吗', now: NOW });
  const personaText = messages[0].content;

  assert.match(personaText, /不喜欢人多的地方/);
  assert.match(personaText, /不编造没发生过的事/);
  assert.equal(personaText.includes('记仇'), false);
  assert.equal(personaText.includes('星座'), false);
  assert.equal(personaText.includes('天蝎'), false);
});

test('buildScheduleMessages 的 characterBrief 带上五维摘要', () => {
  const character = innerCharacter({
    zodiac: '双子座',
    profile: { social: 38, structure: 62, openness: 71, pace: 45, expressiveness: 55 },
    traits: ['不喜欢人多的地方'],
    boundaries: [],
    generatedAt: '2026-10-27T10:00:00+08:00',
    source: 'auto',
  });

  const messages = buildScheduleMessages({ character, date: '2026-10-27' });
  const all = contentsOf(messages);
  assert.match(all, /五维：社交38\/规律62\/开放71\/节奏45\/表达55/);
  assert.equal(all.includes('星座'), false);
});

// ---------------------------------------------------------------------------
// 10. 地点连续性与历史时间戳
// ---------------------------------------------------------------------------

const promptModule = require('../src/main/prompt');

test('历史消息带「绝对+相对」时间，并给出当前位置锚点', () => {
  const now = new Date(2026, 9, 30, 16, 33, 0);
  const history = [
    { role: 'user', text: '我想你了', ts: new Date(2026, 9, 30, 16, 30, 0).toISOString() },
    { role: 'assistant', text: '刚在窗边站着，心里软了一下', ts: new Date(2026, 9, 30, 16, 30, 0).toISOString() },
  ];
  const messages = promptModule.buildChatMessages({
    character: { name: '她' }, history, userText: '在吗', now,
  });
  const text = messages.map((m) => m.content).join('\n');
  assert.match(text, /\[16:30，3 分钟前\]/);
  assert.match(text, /你现在在窗边/);
  assert.match(text, /保持地点和动作连续/);
});

test('placeConflict：凭空换地点算冲突，交代过渡不算', () => {
  assert.equal(promptModule.placeConflict('刚回来，楼下的叶子被风翻了个面', '窗边'), true);
  assert.equal(promptModule.placeConflict('从阳台回屋，坐在窗边', '阳台'), false);
  assert.equal(promptModule.placeConflict('还在窗边站着呢', '窗边'), false);
  assert.equal(promptModule.placeConflict('嗯嗯，我也惦记你', '窗边'), false);
});

test('persona.speechHabits 会注入人格块', () => {
  const promptModule = require('../src/main/prompt');
  const text = promptModule.buildChatMessages({
    character: {
      name: '小满',
      persona: {
        traits: ['务实'],
        speechHabits: ['多用「嗯嗯」「是的」回应', '句末常带「吧」「啦」'],
      },
    },
    history: [],
    userText: '在吗',
    now: new Date(2026, 9, 30, 17, 0, 0),
  }).map((m) => m.content).join('\n');
  assert.match(text, /【说话习惯】/);
  assert.match(text, /嗯嗯/);
  assert.match(text, /句末常带/);
});

test('persona.speechExamples 会作为【说话样例】注入', () => {
  const promptModule = require('../src/main/prompt');
  const text = promptModule.buildChatMessages({
    character: { name: '小满', persona: { traits: ['务实'], speechExamples: ['嗯嗯是的', '你也早点休息～'] } },
    history: [], userText: '在吗', now: new Date(2026, 9, 30, 20, 0, 0),
  }).map((m) => m.content).join('\n');
  assert.match(text, /【说话样例】/);
  assert.match(text, /嗯嗯是的/);
  assert.match(text, /你也早点休息～/);
});

test('生活事实字段（经历/家人/宠物/身体）会注入人格块', () => {
  const promptModule = require('../src/main/prompt');
  const text = promptModule.buildChatMessages({
    character: {
      name: '小满',
      persona: { traits: ['务实'] },
      life: {
        city: '上海',
        home: '租房独居',
        occupation: '上班族',
        career: ['中专幼师，后来考大学'],
        family: ['妹妹（也在上班）'],
        pets: ['两只猫：橘猫和蓝猫'],
        health: ['长期睡眠不足'],
      },
    },
    history: [], userText: '在吗', now: new Date(2026, 9, 30, 21, 0, 0),
  }).map((m) => m.content).join('\n');
  assert.match(text, /【经历】/);
  assert.match(text, /【家人】/);
  assert.match(text, /【宠物】/);
  assert.match(text, /【身体】/);
  assert.match(text, /两只猫/);
});

test('语言规则：英文模式给系统提示词追加英文输出要求，中文模式不追加', () => {
  const i18n = require('../src/main/i18n');
  const build = () => buildChatMessages({
    character: baseCharacter(),
    memories: [],
    today: baseToday(),
    history: [],
    userText: '在吗',
    now: NOW,
  });
  const allText = (messages) => messages.map((m) => m.content).join('\n');

  try {
    i18n.setLanguage('zh');
    assert.equal(allText(build()).includes('【语言】'), false);

    i18n.setLanguage('en');
    const english = allText(build());
    assert.match(english, /【语言】/);
    assert.match(english, /英文/);

    const extract = buildExtractMessages({
      character: baseCharacter(),
      messages: historyRounds(1),
      existingCards: [],
    });
    assert.match(extract[0].content, /一句英文/);
    assert.match(extract[0].content, /【语言】/);
  } finally {
    i18n.setLanguage('zh');
  }
});


test('buildDiscoveryMessages：把当天日程和最近小意外带进提示词', () => {
  const messages = buildDiscoveryMessages({
    character: baseCharacter(),
    schedule: [
      { time: '08:00', activity: '做早饭，煎蛋和吐司' },
      { time: '14:30', activity: '练琴，练一会儿就停' },
    ],
    context: {
      date: '2026-11-07',
      weather: { code: 'clear', label: '晴' },
      state: { mood: 60, energy: 60, focus: 60 },
    },
    recentDiscoveries: ['在抽屉最里面翻到一张旧车票'],
  });
  const text = messages.map((m) => m.content).join('\n');
  assert.match(text, /做早饭/);
  assert.match(text, /练琴/);
  assert.match(text, /旧车票/);
  assert.match(text, /小意外/);
});
