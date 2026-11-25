'use strict';

// 过日子引擎测试（Spec 8 / 计划 Task 7）。
// 不依赖真实等待：所有模型调用都用本地 stub 替换 llm.chat。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const life = require('../src/main/life');
const llm = require('../src/main/llm');
const store = require('../src/main/store');
const usage = require('../src/main/usage');
const stateEngine = require('../src/main/state');

const NOW = new Date(2026, 9, 26, 9, 0, 0, 0); // 本地时间 2026-10-26 09:00
const DATE = usage.dayKey(NOW);

const PROFILE = {
  id: 'p1',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'm',
  capabilities: ['chat'],
};

const MODEL_SCHEDULE = JSON.stringify([
  { time: '08:30', activity: '做早饭，煎蛋和吐司' },
  { time: '11:00', activity: '在窗边画稿' },
  { time: '15:00', activity: '下楼买点东西' },
  { time: '21:00', activity: '看一会儿书' },
]);

// P2：模型现在只生成「活动池」（每周一次），日常由本地抽样，不再直接生成日程。
const MODEL_POOL = JSON.stringify([
  { category: 'home', text: '煮了一锅汤，慢慢等它咕嘟' },
  { category: 'chore', text: '把地拖了一遍，水桶换了两次' },
  { category: 'selfcare', text: '洗了头发，吹到半干' },
  { category: 'discovery', text: '发现楼下换了新的招牌' },
  { category: 'solo_out', text: '去街角书店翻半小时画册' },
  { category: 'create', text: '改了两页稿子，越改越顺' },
  { category: 'home', text: '把常看的那本书翻到折角那页' },
  { category: 'discovery', text: '听到一首没听过的歌，单曲循环了很久' },
]);

function settings(overrides = {}) {
  return {
    life: {
      enabled: true,
      quietFrom: '23:30',
      quietTo: '08:00',
      proactivePerDay: 2,
      maxBackgroundCallsPerDay: 24,
      useWeather: false, // 单测不联网；天气改用季节概率
      scheduleReview: false, // 已有用例只断言「池子一次调用」，自检单独测
      ...overrides,
    },
  };
}

function character(overrides = {}) {
  return {
    id: 'char-test',
    name: '她',
    persona: {
      traits: ['温柔', '有点懒'],
      speechStyle: '短句、口语',
      catchphrases: ['嗯…'],
      background: '',
      relationship: '认识很久的朋友',
      boundaries: [],
      likes: ['旧书店'],
      dislikes: [],
    },
    life: {
      city: '上海',
      home: '徐汇的小房子',
      occupation: '自由插画师',
      hobbies: ['手冲咖啡', '逛书店'],
      tone: '松弛',
    },
    ...overrides,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-life-'));
}

/** 临时替换 llm.chat，测试结束自动还原（每个测试文件独立进程） */
function mockLlm(t, chat) {
  const original = llm.chat;
  llm.chat = async (args) => {
    // 细节调用由桩自动应答，避免每个用例都要处理；也不占各用例的 calls / 后台用量
    if (isDetailCall(args)) return autoDetailReply(args);
    return chat(args);
  };
  t.after(() => {
    llm.chat = original;
  });
}

/** 「每条日程一句细节」的请求判定（prompt.buildDetailMessages 的 system 首句） */
function isDetailCall(args) {
  const messages = args && Array.isArray(args.messages) ? args.messages : [];
  return messages.some(
    (message) => typeof (message && message.content) === 'string'
      && (message.content.includes('具体动作细节') || message.content.includes('她做了什么')),
  );
}

const DETAIL_LINES = [
  '同一段反复了三遍，手指热起来才停。',
  '把窗子推开一条缝，风进来了。',
  '杯子放在手边，凉了才想起来喝。',
  '停下来揉了揉手腕，又接着弄。',
  '灯调暗了一档，屋里安静下来。',
];

function autoDetailReply(args) {
  const user = (args.messages || []).map((message) => String(message && message.content)).join('\n');
  const match = /请输出\s*(\d+)\s*条细节/.exec(user);
  const count = match ? Number(match[1]) : 3;
  const lines = Array.from({ length: count }, (_, index) => DETAIL_LINES[index % DETAIL_LINES.length]);
  return { text: JSON.stringify(lines), usage: null, model: 'm' };
}

function makeDay(overrides = {}) {
  return {
    schedule: [],
    events: [],
    proactive: { boot: false, event: false, idle: false },
    ...overrides,
  };
}

/** 只改五维里的表达维度，其余固定在中间档（避免生日 / 职业自动值干扰） */
function expressive(value) {
  const base = character();
  return {
    ...base,
    persona: {
      ...base.persona,
      inner: {
        profile: {
          social: 50, structure: 50, openness: 60, pace: 50, expressiveness: value,
        },
      },
    },
  };
}

function isAscending(schedule) {
  for (let index = 1; index < schedule.length; index += 1) {
    if (schedule[index - 1].time > schedule[index].time) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. 默认日程与校验
// ---------------------------------------------------------------------------

test('defaultSchedule 从职业/爱好取素材，≥3 条且时间升序', () => {
  const schedule = life.defaultSchedule(character());
  assert.ok(schedule.length >= 3);
  assert.ok(isAscending(schedule));

  const text = schedule.map((item) => item.activity).join('|');
  assert.ok(text.includes('自由插画师'), '应带上职业素材');
  assert.ok(text.includes('手冲咖啡') || text.includes('逛书店'), '应带上爱好素材');

  for (const item of schedule) {
    assert.match(item.time, /^([01]\d|2[0-3]):[0-5]\d$/);
    assert.ok(item.activity.length > 0);
  }

  // 缺字段时用通用模板，不抛
  const generic = life.defaultSchedule({});
  assert.ok(generic.length >= 3);
  assert.ok(generic.every((item) => !item.activity.includes('undefined')));
});

test('validateSchedule：非法时间 / 空 / 非升序都回落内置模板', () => {
  const badTime = life.validateSchedule([
    { time: '25:00', activity: '做早饭' },
    { time: '14:00', activity: '画稿' },
    { time: '18:00', activity: '做饭' },
  ]);
  assert.equal(badTime.ok, false);
  assert.ok(badTime.warnings.length > 0);
  assert.ok(badTime.schedule.length >= 3);
  assert.ok(isAscending(badTime.schedule));
  assert.ok(badTime.schedule.every((item) => /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)));

  const empty = life.validateSchedule([]);
  assert.equal(empty.ok, false);
  assert.ok(empty.schedule.length >= 3);

  const descending = life.validateSchedule([
    { time: '14:00', activity: '画稿' },
    { time: '08:00', activity: '做早饭' },
    { time: '20:00', activity: '散步' },
  ]);
  assert.equal(descending.ok, false);
  assert.ok(descending.schedule.length >= 3);
});

test('validateSchedule：合法日程通过；同一时间点重复不判失败', () => {
  const valid = life.validateSchedule([
    { time: '08:00', activity: '做早饭' },
    { time: '09:00', activity: '收拾屋子' },
    { time: '10:00', activity: '画稿' },
  ]);
  assert.equal(valid.ok, true);
  assert.equal(valid.schedule.length, 3);

  const duplicate = life.validateSchedule([
    { time: '08:00', activity: '做早饭' },
    { time: '08:00', activity: '顺手洗杯子' },
    { time: '09:00', activity: '画稿' },
  ]);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.schedule.length, 3);

  const fenced = life.validateSchedule('```json\n' + MODEL_SCHEDULE + '\n```');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.schedule.length, 4);
});

// ---------------------------------------------------------------------------
// 2. ensureSchedule
// ---------------------------------------------------------------------------

test('ensureSchedule：首次生成活动池并抽样，第二次幂等且不再调模型', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return {
      text: MODEL_POOL,
      usage: { promptTokens: 12, completionTokens: 6 },
      model: 'm',
    };
  });

  const c = character();
  store.saveCharacter(dir, c);
  const first = await life.ensureSchedule({
    dir,
    character: c,
    date: DATE,
    profile: PROFILE,
    settings: settings(),
    now: NOW,
  });
  assert.equal(first.generated, true);
  assert.equal(calls, 1, '首次只调一次模型生成活动池');
  const day = first.timeline.days[DATE];
  assert.ok(day.schedule.length >= 3 && day.schedule.length <= 5);
  assert.ok(isAscending(day.schedule));
  assert.equal(day.scheduleSource, 'model');
  assert.equal(usage.today(dir, NOW).background, 2, '后台调用：活动池 1 次 + 日程细节 1 次');

  // 池子写回 character.json
  const storedChar = store.listCharacters(dir)[0];
  assert.ok(storedChar.life.activityPool);
  assert.ok(storedChar.life.activityPool.items.length >= 6);
  assert.match(storedChar.life.activityPool.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const stored = store.readTimeline(dir, 'char-test');
  assert.equal(stored.days[DATE].schedule.length, day.schedule.length);

  const second = await life.ensureSchedule({
    dir,
    character: store.listCharacters(dir)[0],
    date: DATE,
    profile: PROFILE,
    settings: settings(),
    now: NOW,
  });
  assert.equal(second.generated, false);
  assert.equal(calls, 1, '当天已有日程时不应再调模型');
  assert.deepEqual(second.timeline.days[DATE].schedule, first.timeline.days[DATE].schedule);
});

test('ensureSchedule：模型失败回落本地兜底池，不抛且当天日程可用', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    throw new Error('network down');
  });

  const result = await life.ensureSchedule({
    dir,
    character: character(),
    date: DATE,
    profile: PROFILE,
    settings: settings(),
    now: NOW,
  });
  assert.equal(calls, 1);
  assert.equal(result.generated, false);
  const day = result.timeline.days[DATE];
  assert.ok(day.schedule.length >= 3 && day.schedule.length <= 5);
  assert.ok(isAscending(day.schedule));
  assert.equal(day.scheduleSource, 'template');
  assert.ok(day.scheduleWarnings.some((w) => /活动池/.test(w)));
  assert.equal(usage.today(dir, NOW).background, 1, '失败的活动池调用不记后台次数（只记成功的细节调用）');
});

test('ensureSchedule：模型输出不合格的活动池时回落本地兜底池', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return {
      // 只有 2 条合格条目 → parsePool 返回 null
      text: JSON.stringify([
        { category: 'home', text: '做早饭' },
        { category: 'chore', text: '拖地' },
      ]),
      usage: { promptTokens: 5, completionTokens: 5 },
      model: 'm',
    };
  });

  const c = character();
  store.saveCharacter(dir, c);
  const result = await life.ensureSchedule({
    dir,
    character: c,
    date: DATE,
    profile: PROFILE,
    settings: settings(),
    now: NOW,
  });
  assert.equal(calls, 1);
  assert.equal(result.generated, false);
  const day = result.timeline.days[DATE];
  assert.ok(day.schedule.length >= 3 && day.schedule.length <= 5);
  assert.ok(isAscending(day.schedule));
  assert.equal(day.scheduleSource, 'template');
  assert.equal(store.listCharacters(dir)[0].life.activityPool, undefined, '不合格池子不落盘');
});

test('ensureSchedule：后台预算不足走本地兜底池且 0 次模型调用', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: MODEL_POOL, usage: null, model: 'm' };
  });

  const result = await life.ensureSchedule({
    dir,
    character: character(),
    date: DATE,
    profile: PROFILE,
    settings: settings({ maxBackgroundCallsPerDay: 0 }),
    now: NOW,
  });
  assert.equal(calls, 0, '预算不足不应调模型');
  assert.equal(result.generated, false);
  const day = result.timeline.days[DATE];
  assert.ok(day.schedule.length >= 3 && day.schedule.length <= 5);
  assert.equal(day.scheduleSource, 'template');
  assert.equal(usage.today(dir, NOW).background, 0);

  // 兜底池同样遵守硬约束：自由职业不该出现通勤/开会
  const text = day.schedule.map((item) => item.activity).join('|');
  assert.doesNotMatch(text, /通勤|开会|打卡|公司/);
});

test('ensureSchedule：profile 缺失时走本地兜底池且不抛', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: MODEL_POOL, usage: null, model: 'm' };
  });

  const c = character();
  store.saveCharacter(dir, c);
  const result = await life.ensureSchedule({
    dir,
    character: c,
    date: DATE,
    profile: null,
    settings: settings(),
    now: NOW,
  });
  assert.equal(calls, 0);
  assert.equal(result.generated, false);
  const day = result.timeline.days[DATE];
  assert.ok(day.schedule.length >= 3 && day.schedule.length <= 5);
  assert.equal(day.scheduleSource, 'template');
  assert.equal(store.listCharacters(dir)[0].life.activityPool, undefined);
});

test('ensureSchedule：日程细节由模型逐条生成并写回 schedule[].detail', async (t) => {
  const dir = tempDir();
  mockLlm(t, async () => ({ text: MODEL_POOL, usage: null, model: 'm' }));

  const c = character();
  store.saveCharacter(dir, c);
  const result = await life.ensureSchedule({
    dir, character: c, date: DATE, profile: PROFILE, settings: settings(), now: NOW,
  });
  const day = result.timeline.days[DATE];
  assert.ok(day.schedule.every((row) => typeof row.detail === 'string' && row.detail.length > 0));
  assert.deepEqual(
    day.schedule.map((row) => row.detail),
    DETAIL_LINES.slice(0, day.schedule.length),
  );
  // 同一天第二次不再生成（detailsAt 闸门）
  const stored = store.readTimeline(dir, 'char-test');
  assert.ok(stored.days[DATE].detailsAt);
  assert.deepEqual(
    store.readTimeline(dir, 'char-test').days[DATE].schedule.map((row) => row.detail),
    day.schedule.map((row) => row.detail),
  );
});

test('ensureSchedule：细节输出不合格时留空，事件退回本地文案池', async (t) => {
  const dir = tempDir();
  const original = llm.chat;
  llm.chat = async (args) => (isDetailCall(args)
    ? { text: '这不是 JSON', usage: null, model: 'm' }
    : { text: MODEL_POOL, usage: null, model: 'm' });
  t.after(() => { llm.chat = original; });

  const c = character();
  store.saveCharacter(dir, c);
  const result = await life.ensureSchedule({
    dir, character: c, date: DATE, profile: PROFILE, settings: settings(), now: NOW,
  });
  const day = result.timeline.days[DATE];
  assert.ok(day.schedule.every((row) => !row.detail));
  // 没有模型细节、也没有同类细节时，只显示活动本身，不塞通用句子
  const row = day.schedule[0];
  assert.equal(life.eventTextFor(row, 1), `${row.activity}。`);
});

test('ensureSchedule：已有日程缺细节时补一次模型调用', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: MODEL_POOL, usage: null, model: 'm' };
  });
  const c = character();
  store.saveCharacter(dir, c);
  store.writeTimeline(dir, 'char-test', {
    days: {
      [DATE]: {
        schedule: [{ time: '09:30', activity: '在窗边练一会儿琴' }],
        events: [],
        proactive: { boot: false, event: false, idle: false },
      },
    },
  });
  const result = await life.ensureSchedule({
    dir, character: c, date: DATE, profile: PROFILE, settings: settings(), now: NOW,
  });
  assert.equal(calls, 0, '日程已存在，不重新生成活动池');
  const row = result.timeline.days[DATE].schedule[0];
  assert.equal(row.time, '09:30');
  assert.equal(row.detail, DETAIL_LINES[0]);
});

test('parseDetailLines：JSON / 围栏 / 编号行都能解析，重复项与缺项留空', () => {
  assert.deepEqual(
    life.parseDetailLines('```json\n["第一句细节。","第二句细节。"]\n```', 2),
    ['第一句细节。', '第二句细节。'],
  );
  assert.deepEqual(
    life.parseDetailLines('1. 第一句细节。\n2. 第二句细节。', 2),
    ['第一句细节。', '第二句细节。'],
  );
  assert.deepEqual(
    life.parseDetailLines('["同一句细节。","同一句细节。"]', 2),
    ['同一句细节。', ''],
  );
  assert.deepEqual(life.parseDetailLines('["只有这一句细节。"]', 3), ['只有这一句细节。', '', '']);
  assert.deepEqual(life.parseDetailLines('', 2), ['', '']);
});

test('recentDetails：只取目标日期之前的细节，供模型避重复', () => {
  const timeline = {
    days: {
      '2026-10-24': { schedule: [{ time: '09:00', activity: 'a', detail: '前两天用过的细节。' }] },
      '2026-10-25': { schedule: [{ time: '09:00', activity: 'b', detail: '昨天用过的细节。' }] },
      [DATE]: { schedule: [{ time: '09:00', activity: 'c', detail: '今天的细节。' }] },
    },
  };
  const list = life.recentDetails(timeline, DATE, 14);
  assert.deepEqual(list, ['昨天用过的细节。', '前两天用过的细节。']);
});

// ---------------------------------------------------------------------------
// 3. 事件推进
// ---------------------------------------------------------------------------

test('advanceEvents：到点触发一次，重复调用不再触发', () => {
  const timeline = {
    days: {
      [DATE]: makeDay({
        schedule: [
          { time: '08:30', activity: '做早饭' },
          { time: '14:00', activity: '画稿' },
        ],
      }),
    },
  };
  const now = new Date(2026, 9, 26, 8, 30, 0);

  const first = life.advanceEvents({ timeline, now, character: character() });
  assert.equal(first.fired.length, 1);
  assert.equal(first.fired[0].scheduleTime, '08:30');
  assert.equal(first.fired[0].time, '08:30');
  assert.equal(first.fired[0].fired, true);
  assert.ok(first.fired[0].text.length > 0);
  assert.equal(first.timeline.days[DATE].events.length, 1);

  const second = life.advanceEvents({ timeline: first.timeline, now, character: character() });
  assert.equal(second.fired.length, 0);
  assert.equal(second.timeline.days[DATE].events.length, 1);

  // 还没到点的日程不触发
  const earlier = life.advanceEvents({
    timeline: { days: {} },
    now: new Date(2026, 9, 26, 7, 0, 0),
    character: character(),
  });
  assert.equal(earlier.fired.length, 0);
});

test('advanceEvents：应用关很久后补触发，事件时间用日程时间而不是补记时间', () => {
  const timeline = {
    days: {
      [DATE]: makeDay({
        schedule: [
          { time: '08:30', activity: '做早饭' },
          { time: '11:30', activity: '去菜场买菜' },
        ],
      }),
    },
  };
  const now = new Date(2026, 9, 26, 15, 20, 0);
  const result = life.advanceEvents({ timeline, now, character: character() });
  assert.equal(result.fired.length, 2);
  assert.deepEqual(result.fired.map((item) => item.time), ['08:30', '11:30']);
  assert.equal(result.fired[0].firedAt, '15:20');
});

test('advanceEvents：同一时间点两条日程只触发一次', () => {
  const now = new Date(2026, 9, 26, 8, 0, 0);
  const timeline = {
    days: {
      [DATE]: makeDay({
        schedule: [
          { time: '08:00', activity: '做早饭' },
          { time: '08:00', activity: '顺手洗杯子' },
        ],
      }),
    },
  };
  const result = life.advanceEvents({ timeline, now, character: character() });
  assert.equal(result.fired.length, 1);
  assert.equal(result.timeline.days[DATE].events.length, 1);
  assert.equal(result.fired[0].scheduleTime, '08:00');
});

test('跨天：昨天的事件不会在今天重复触发；00:01 空 day 不抛', () => {
  const yesterday = new Date(2026, 9, 25, 23, 0, 0);
  const yesterdayKey = usage.dayKey(yesterday);
  const timeline = {
    days: {
      [yesterdayKey]: makeDay({
        schedule: [{ time: '23:00', activity: '睡前看书' }],
        events: [
          { time: '23:00', scheduleTime: '23:00', text: '昨天的事件', mood: '安静', fired: true },
        ],
        proactive: { boot: true, event: true, idle: true },
      }),
    },
  };

  const result = life.advanceEvents({
    timeline,
    now: new Date(2026, 9, 26, 0, 1, 0),
    character: character(),
  });
  assert.deepEqual(result.fired, []);
  assert.equal(result.timeline.days[DATE].events.length, 0);
  assert.equal(result.timeline.days[yesterdayKey].events.length, 1);

  // 00:01 时 day 对象为空：pickProactive 不抛
  const picked = life.pickProactive({
    day: undefined,
    now: new Date(2026, 9, 26, 0, 1, 0),
    settings: settings(),
    lastUserAt: null,
    startedAt: null,
  });
  assert.equal(picked, null);
});

// ---------------------------------------------------------------------------
// 4. 主动消息决策
// ---------------------------------------------------------------------------

test('pickProactive：静默时段（23:45 / 07:59）返回 null', () => {
  const day = makeDay({
    events: [{ time: '23:44', text: '刚收拾完', fired: true }],
  });
  const base = {
    day,
    settings: settings(),
    lastUserAt: new Date(2026, 9, 26, 10, 0, 0),
    startedAt: new Date(2026, 9, 26, 22, 0, 0),
  };
  assert.equal(life.pickProactive({ ...base, now: new Date(2026, 9, 26, 23, 45, 0) }), null);
  assert.equal(life.pickProactive({ ...base, now: new Date(2026, 9, 27, 7, 59, 0) }), null);
});

test('pickProactive：三个触发源各自每日一次', () => {
  const now = new Date(2026, 9, 26, 10, 30, 0);
  const recentUser = new Date(2026, 9, 26, 10, 20, 0);
  const freshEvent = { time: '10:28', text: '刚收拾完桌子', fired: true };
  const notBootYet = new Date(2026, 9, 26, 10, 25, 0); // 只启动 5 分钟

  // 开机问候已用：不再 boot（事件不新鲜、久未联系不成立）
  assert.equal(life.pickProactive({
    day: makeDay({ proactive: { boot: true, event: false, idle: false } }),
    now,
    settings: settings(),
    lastUserAt: recentUser,
    startedAt: notBootYet,
  }), null);

  // 事件分享已用：不再 event
  assert.equal(life.pickProactive({
    day: makeDay({ events: [freshEvent], proactive: { boot: false, event: true, idle: false } }),
    now,
    settings: settings(),
    lastUserAt: recentUser,
    startedAt: notBootYet,
  }), null);

  // 久未联系已用：不再 idle
  assert.equal(life.pickProactive({
    day: makeDay({ proactive: { boot: false, event: false, idle: true } }),
    now,
    settings: settings(),
    lastUserAt: new Date(2026, 9, 26, 1, 0, 0),
    startedAt: notBootYet,
  }), null);
});

test('pickProactive：全局上限 proactivePerDay 生效', () => {
  const now = new Date(2026, 9, 26, 10, 30, 0);
  const day = makeDay({
    events: [{ time: '10:28', text: '刚收拾完桌子', fired: true }],
  });
  const args = {
    day,
    now,
    settings: settings(),
    lastUserAt: new Date(2026, 9, 26, 1, 0, 0), // 久未联系也满足
    startedAt: new Date(2026, 9, 26, 10, 0, 0), // 开机问候也满足
  };

  const first = life.pickProactive(args);
  assert.equal(first.trigger, 'boot');
  day.proactive.boot = true;

  const second = life.pickProactive(args);
  assert.equal(second.trigger, 'event');
  assert.equal(second.event.time, '10:28');
  day.proactive.event = true;

  // 已用 2 条 = 全局上限
  assert.equal(life.pickProactive(args), null);

  // 记满
  day.proactive.idle = true;
  assert.equal(life.pickProactive(args), null);
});

test('diaryCopiesEvents：日记照抄事件原句时能识别出来', () => {
  const events = [{ text: '翻开书看两页，把书签塞进页缝里，书合上时指腹被夹了一下。' }];
  // 连续 11 字照抄（书合上时指腹被夹了一下）应被识别
  assert.equal(life.diaryCopiesEvents('今天没干什么，书合上时指腹被夹了一下，疼了一会儿。', events), true);
  assert.equal(life.diaryCopiesEvents('今天什么都不想干，坐着发了很久的呆。', events), false);
});

test('weatherRealtimeConflict：只有明确知道此刻没下雨才拦实时说法', () => {
  assert.equal(life.weatherRealtimeConflict('这会儿还在下雨，你那边呢', { rainNow: false }), true);
  assert.equal(life.weatherRealtimeConflict('外面正在下雨', { rainNow: false }), true);
  assert.equal(life.weatherRealtimeConflict('今天下雨了，窗户上全是水', { rainNow: false }), false);
  assert.equal(life.weatherRealtimeConflict('这会儿还在下雨', { rainNow: true }), false);
  assert.equal(life.weatherRealtimeConflict('这会儿还在下雨', { rainNow: null }), false);
  assert.equal(life.weatherRealtimeConflict('这会儿还在下雨', {}), false);
});

test('pickProactive：冷启动 startedAt 为 null 时 boot 要等满 10 分钟', () => {
  const now = new Date(2026, 9, 26, 10, 0, 0);
  const base = {
    day: makeDay(),
    now,
    settings: settings(),
    lastUserAt: new Date(2026, 9, 26, 9, 55, 0), // 5 分钟前刚聊过，排除 idle
  };

  assert.equal(life.pickProactive({ ...base, startedAt: null }), null);
  assert.equal(life.pickProactive({
    ...base,
    startedAt: new Date(2026, 9, 26, 9, 51, 0), // 9 分钟
  }), null);

  const boot = life.pickProactive({
    ...base,
    startedAt: new Date(2026, 9, 26, 9, 50, 0), // 正好 10 分钟
  });
  assert.equal(boot.trigger, 'boot');
});

test('pickProactive：事件只在此后 3 分钟内分享', () => {
  const base = {
    settings: settings(),
    lastUserAt: new Date(2026, 9, 26, 10, 20, 0),
    startedAt: new Date(2026, 9, 26, 10, 25, 0),
  };

  const tooLate = life.pickProactive({
    ...base,
    now: new Date(2026, 9, 26, 10, 30, 0),
    day: makeDay({ events: [{ time: '10:26', text: '刚忙完', fired: true }] }),
  });
  assert.equal(tooLate, null);

  const inWindow = life.pickProactive({
    ...base,
    now: new Date(2026, 9, 26, 10, 30, 0),
    day: makeDay({ events: [{ time: '10:27', text: '刚忙完', fired: true }] }),
  });
  assert.equal(inWindow.trigger, 'event');
});

test('pickProactive：久未联系需距最后一条用户消息 ≥6 小时', () => {
  const base = {
    day: makeDay(),
    now: new Date(2026, 9, 26, 10, 30, 0),
    settings: settings(),
    startedAt: new Date(2026, 9, 26, 10, 25, 0), // 排除 boot
  };

  assert.equal(life.pickProactive({
    ...base,
    lastUserAt: new Date(2026, 9, 26, 4, 31, 0), // 5 小时 59 分
  }), null);

  const idle = life.pickProactive({
    ...base,
    lastUserAt: new Date(2026, 9, 26, 4, 30, 0), // 正好 6 小时
  });
  assert.equal(idle.trigger, 'idle');
});

test('pickProactive：生活关闭时返回 null', () => {
  const picked = life.pickProactive({
    day: makeDay(),
    now: new Date(2026, 9, 26, 10, 30, 0),
    settings: settings({ enabled: false }),
    lastUserAt: new Date(2026, 9, 26, 1, 0, 0),
    startedAt: new Date(2026, 9, 26, 9, 0, 0),
  });
  assert.equal(picked, null);
});

// ---------------------------------------------------------------------------
// 5. runProactive
// ---------------------------------------------------------------------------

test('runProactive：模型失败时返回模板兜底消息（不为 null）', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    throw new Error('boom');
  });

  const day = makeDay();
  const message = await life.runProactive({
    character: character(),
    now: NOW,
    day,
    trigger: 'idle',
    memories: [],
    profile: PROFILE,
    settings: settings(),
    dir,
  });

  assert.equal(calls, 1);
  assert.ok(message, '失败也必须返回兜底消息');
  assert.equal(message.role, 'assistant');
  assert.equal(message.proactive, true);
  assert.equal(message.unread, true);
  assert.equal(message.trigger, 'idle');
  assert.match(message.id, /^msg-/);
  assert.ok(Number.isFinite(new Date(message.ts).getTime()));
  assert.ok(Array.from(message.text).length <= 40);
  assert.ok(message.text.length > 0);
  assert.equal(day.proactive.idle, true, '触发后应记录当天已用');

  const stored = store.readMessages(dir, 'char-test');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].proactive, true);
});

test('runProactive：静默时段防御性返回 null，且不调模型', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: '不该出现', usage: null, model: 'm' };
  });

  const day = makeDay();
  const message = await life.runProactive({
    character: character(),
    now: new Date(2026, 9, 26, 23, 45, 0),
    day,
    trigger: 'idle',
    memories: [],
    profile: PROFILE,
    settings: settings(),
    dir,
  });

  assert.equal(message, null);
  assert.equal(calls, 0);
  assert.equal(day.proactive.idle, false);
  assert.equal(store.readMessages(dir, 'char-test').length, 0);
});

test('runProactive：后台预算不足时仍用模板兜底', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: '模型不该被调用', usage: null, model: 'm' };
  });

  const message = await life.runProactive({
    character: character(),
    now: NOW,
    day: makeDay(),
    trigger: 'boot',
    memories: [],
    profile: PROFILE,
    settings: settings({ maxBackgroundCallsPerDay: 0 }),
    dir,
  });

  assert.equal(calls, 0);
  assert.ok(message);
  assert.equal(message.trigger, 'boot');
  assert.ok(Array.from(message.text).length <= 40);
});

test('runProactive：成功时用模型文案、按中间档截到 34 字内并记录用量', async (t) => {
  const dir = tempDir();
  const long = '刚把稿子改完，眼睛有点酸，窗外的天已经暗下来了，桌上的杯子也空了，忽然想问问你今天过得怎么样，吃饭了没有。';
  mockLlm(t, async () => ({
    text: long,
    usage: { promptTokens: 20, completionTokens: 10 },
    model: 'm',
  }));

  const day = makeDay();
  const message = await life.runProactive({
    character: character(),
    now: NOW,
    day,
    trigger: 'idle',
    memories: [{ kind: 'event', text: '用户下周要交方案', importance: 4 }],
    profile: PROFILE,
    settings: settings(),
    dir,
  });

  assert.ok(message);
  // 没有五维时按中间档（表达 50）→ 34 字
  assert.ok(Array.from(message.text).length <= 34, `实际 ${Array.from(message.text).length} 字`);
  assert.ok(message.text.endsWith('…'));
  assert.equal(usage.today(dir, NOW).background, 1);
  assert.equal(day.proactive.idle, true);
});

test('runProactive：表达 ≤30 时截到 28 字、每日上限降为 1、提示词写 28 字', async (t) => {
  const dir = tempDir();
  const long = '刚把稿子改完，眼睛有点酸，窗外的天已经暗下来了，桌上的杯子也空了，忽然想问问你今天过得怎么样，吃饭了没有。';
  const seen = [];
  mockLlm(t, async ({ messages }) => {
    seen.push(messages);
    return { text: long, usage: null, model: 'm' };
  });

  const day = makeDay();
  const message = await life.runProactive({
    character: expressive(20),
    now: NOW,
    day,
    trigger: 'idle',
    memories: [],
    profile: PROFILE,
    settings: settings(),
    dir,
  });

  assert.ok(message);
  assert.equal(Array.from(message.text).length, 28, '低表达卡在 28 字');
  assert.ok(message.text.endsWith('…'));
  assert.match(seen[0][0].content, /≤28 字/);

  // proactivePerDay = 2，但低表达只有 1 条：已经发过一条就不再发
  const blocked = await life.runProactive({
    character: expressive(20),
    now: NOW,
    day: makeDay({ proactive: { boot: true } }),
    trigger: 'event',
    memories: [],
    profile: PROFILE,
    settings: settings(),
    dir,
  });
  assert.equal(blocked, null);

  // 中间档仍然按 2 条走：发过 1 条还能再发
  const normal = await life.runProactive({
    character: character(),
    now: NOW,
    day: makeDay({ proactive: { boot: true } }),
    trigger: 'event',
    memories: [],
    profile: PROFILE,
    settings: settings(),
    dir,
  });
  assert.ok(normal);
});

test('runProactive：表达 ≥70 维持 40 字与原上限', async (t) => {
  const dir = tempDir();
  const long = '刚把稿子改完，眼睛有点酸，窗外的天已经暗下来了，桌上的杯子也空了，忽然想问问你今天过得怎么样，吃饭了没有。';
  mockLlm(t, async () => ({ text: long, usage: null, model: 'm' }));

  const message = await life.runProactive({
    character: expressive(90),
    now: NOW,
    day: makeDay(),
    trigger: 'idle',
    memories: [],
    profile: PROFILE,
    settings: settings(),
    dir,
  });

  assert.ok(message);
  assert.equal(Array.from(message.text).length, 40, '高表达保持 40 字');
  assert.equal(life.proactiveDailyLimit(settings(), expressive(90)), 2);

  // 发过 1 条后仍可再发一条（上限不变）
  const again = await life.runProactive({
    character: expressive(90),
    now: NOW,
    day: makeDay({ proactive: { boot: true } }),
    trigger: 'event',
    memories: [],
    profile: PROFILE,
    settings: settings(),
    dir,
  });
  assert.ok(again);
});

test('runProactive：该触发源已用 / 全局上限已满时返回 null', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: '不该出现', usage: null, model: 'm' };
  });

  const used = await life.runProactive({
    character: character(),
    now: NOW,
    day: makeDay({ proactive: { boot: false, event: false, idle: true } }),
    trigger: 'idle',
    memories: [],
    profile: PROFILE,
    settings: settings(),
    dir,
  });
  assert.equal(used, null);

  const capped = await life.runProactive({
    character: character(),
    now: NOW,
    day: makeDay({ proactive: { boot: true, event: true, idle: false } }),
    trigger: 'idle',
    memories: [],
    profile: PROFILE,
    settings: settings(),
    dir,
  });
  assert.equal(capped, null);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// 6. 事件模板
// ---------------------------------------------------------------------------

test('eventTemplate：同 seed 稳定输出', () => {
  assert.equal(life.eventTemplate('平静', 7), life.eventTemplate('平静', 7));
  assert.equal(life.eventTemplate('专注', 42), life.eventTemplate('专注', 42));
  assert.notEqual(life.eventTemplate('平静', 7), life.eventTemplate('专注', 7));
});

test('eventTemplate：至少 20 条、两段式且不含未替换占位符', () => {
  const seen = new Set();
  const moods = ['平静', '专注', '有点懒', '开心', '安静', '疲惫', '未知'];
  for (let seed = 0; seed < 60; seed += 1) {
    for (const mood of moods) {
      const text = life.eventTemplate(mood, seed);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      assert.ok(!/\{[^}]*\}/.test(text), `模板不应含占位符：${text}`);
      assert.ok(!text.includes('undefined'));
      seen.add(text);
    }
  }
  assert.ok(seen.size >= 20, `模板应至少 20 条，实际 ${seen.size}`);

  for (const text of life.EVENT_TEMPLATES) {
    assert.ok(text.includes('，'), `应为「动作 + 环境」两段式：${text}`);
    assert.ok(text.endsWith('。'), `应以句号收尾：${text}`);
  }
});

test('advanceEvents 生成的事件文案跟随日程，且 mood 有值', () => {
  const result = life.advanceEvents({
    timeline: {
      days: { [DATE]: makeDay({ schedule: [{ time: '08:30', activity: '做早饭' }] }) },
    },
    now: new Date(2026, 9, 26, 8, 30, 0),
    character: character(),
  });
  assert.equal(result.fired.length, 1);
  const event = result.fired[0];
  assert.ok(event.text.startsWith('做早饭。'));
  assert.ok(event.mood.length > 0);
  assert.ok(!/\{[^}]*\}/.test(event.text));
});

// ---------------------------------------------------------------------------
// 7. 日记
// ---------------------------------------------------------------------------

test('writeDiary：生成 100–180 字日记并幂等', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return {
      text: '今天'.repeat(150), // 300 字，应被截到 180 以内
      usage: { promptTokens: 30, completionTokens: 60 },
      model: 'm',
    };
  });

  const timeline = {
    days: {
      [DATE]: makeDay({
        schedule: life.defaultSchedule(character()),
        events: [{ time: '08:30', scheduleTime: '08:30', text: '她做了早饭。', mood: '平静', fired: true }],
      }),
    },
  };

  const first = await life.writeDiary({
    dir,
    character: character(),
    date: DATE,
    timeline,
    profile: PROFILE,
    settings: settings(),
    recentChat: [],
    now: NOW,
  });
  assert.ok(first.diary);
  const length = Array.from(first.diary).length;
  assert.ok(length >= 100 && length <= 180, `日记应 100–180 字，实际 ${length}`);
  assert.equal(calls, 1);

  const stored = store.readTimeline(dir, 'char-test');
  assert.equal(stored.days[DATE].diary, first.diary);

  const second = await life.writeDiary({
    dir,
    character: character(),
    date: DATE,
    timeline: first.timeline,
    profile: PROFILE,
    settings: settings(),
    recentChat: [],
    now: NOW,
  });
  assert.equal(second.diary, first.diary);
  assert.equal(calls, 1, '已有日记不再调模型');
});

test('writeDiary：不足 100 字按失败留空，但允许重试', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: '今天很平常。', usage: { promptTokens: 1, completionTokens: 1 }, model: 'm' };
  });

  const first = await life.writeDiary({
    dir,
    character: character(),
    date: DATE,
    timeline: { days: { [DATE]: makeDay() } },
    profile: PROFILE,
    settings: settings(),
    recentChat: [],
    now: NOW,
  });
  assert.equal(first.diary, null);
  assert.equal(calls, 1);

  const second = await life.writeDiary({
    dir,
    character: character(),
    date: DATE,
    timeline: first.timeline,
    profile: PROFILE,
    settings: settings(),
    recentChat: [],
    now: NOW,
  });
  assert.equal(second.diary, null);
  assert.equal(calls, 2, '失败后允许再试一次');
});

test('writeDiary：模型失败留空，但最多重试 3 次', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    throw new Error('boom');
  });

  const timeline = { days: { [DATE]: makeDay() } };
  const first = await life.writeDiary({
    dir,
    character: character(),
    date: DATE,
    timeline,
    profile: PROFILE,
    settings: settings(),
    recentChat: [],
    now: NOW,
  });
  assert.equal(first.diary, null);
  assert.equal(calls, 1);

  const stored = store.readTimeline(dir, 'char-test');
  assert.equal(stored.days[DATE].diaryAttempted, true);
  assert.equal(stored.days[DATE].diaryTries, 1);

  const second = await life.writeDiary({
    dir,
    character: character(),
    date: DATE,
    timeline: first.timeline,
    profile: PROFILE,
    settings: settings(),
    recentChat: [],
    now: NOW,
  });
  assert.equal(second.diary, null);
  assert.equal(calls, 2, '失败后允许再试一次');

  // 第 3 次之后不再重试
  const third = await life.writeDiary({
    dir,
    character: character(),
    date: DATE,
    timeline: second.timeline,
    profile: PROFILE,
    settings: settings(),
    recentChat: [],
    now: NOW,
  });
  assert.equal(third.diary, null);
  const fourth = await life.writeDiary({
    dir,
    character: character(),
    date: DATE,
    timeline: third.timeline,
    profile: PROFILE,
    settings: settings(),
    recentChat: [],
    now: NOW,
  });
  assert.equal(fourth.diary, null);
  assert.equal(calls, 3, '一天最多试 3 次');
});

// ---------------------------------------------------------------------------
// 9. 时段一致性（主动消息不能把下午说成「今晚」）
// ---------------------------------------------------------------------------

test('timeConflict：下午出现夜间用语算冲突，晚上/早上各自正确', () => {
  const afternoon = new Date(2026, 9, 26, 13, 51, 0);
  const evening = new Date(2026, 9, 26, 21, 10, 0);
  const morning = new Date(2026, 9, 26, 8, 30, 0);

  assert.equal(life.timeConflict('你今晚就踏实歇着吧', afternoon), true);
  assert.equal(life.timeConflict('晚安，早点睡', afternoon), true);
  assert.equal(life.timeConflict('下午好，我在窗边画画', afternoon), false);
  assert.equal(life.timeConflict('你今晚要早点休息', evening), false);
  assert.equal(life.timeConflict('早安，今天起得挺早', morning), false);
  assert.equal(life.timeConflict('早安', afternoon), true);
  assert.equal(life.timeConflict('', afternoon), false);
  const night = new Date(2026, 9, 26, 22, 50, 0);
  assert.equal(life.timeConflict('刚开机，正闲着发呆', night), true);
  assert.equal(life.timeConflict('早，我刚起来', night), true);
  assert.equal(life.timeConflict('刚打开电脑，随便说一句', night), false);
  assert.equal(life.timeConflict('下午去超市转了转', night), true);
  assert.equal(life.timeConflict('明天下午去超市', night), false);
  assert.equal(life.timeConflict('刚醒，下午好', afternoon), true);
});

test('runProactive：下午生成了「今晚」会重写一次，改用合时段的那句', async (t) => {
  const dir = tempDir();
  const prompts = [];
  let calls = 0;
  mockLlm(t, async ({ messages }) => {
    calls += 1;
    prompts.push(messages);
    const text = calls === 1 ? '我刚泡了杯热茶，你今晚就踏实歇着吧。' : '刚泡了杯热茶，下午的阳光正好。';
    return { text, usage: { promptTokens: 10, completionTokens: 5, estimated: false }, model: 'mock' };
  });

  const now = new Date(2026, 9, 26, 13, 51, 0);
  const message = await life.runProactive({
    character: character(), now, day: makeDay(), trigger: 'idle', memories: [],
    profile: PROFILE, settings: settings(), dir,
  });

  assert.equal(calls, 2, '冲突时应重写一次');
  assert.match(message.text, /下午/);
  assert.doesNotMatch(message.text, /今晚|晚安|早点睡/);
  // 重写请求里带了时段纠正指令
  const lastPrompt = prompts[prompts.length - 1].map((m) => m.content).join('\n');
  assert.match(lastPrompt, /不符合时段的说法|下午/);
});

test('runProactive：重写后仍然冲突时退回模板，不把夜间用语发出去', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: '晚安，早点睡吧。', usage: { promptTokens: 8, completionTokens: 4, estimated: false }, model: 'mock' };
  });

  const now = new Date(2026, 9, 26, 13, 51, 0);
  const message = await life.runProactive({
    character: character(), now, day: makeDay(), trigger: 'idle', memories: [],
    profile: PROFILE, settings: settings(), dir,
  });

  assert.equal(calls, 2);
  assert.doesNotMatch(message.text, /今晚|晚安|早点睡|该睡了/);
});

// ---------------------------------------------------------------------------
// 10. 每日日程要有变化（不能天天照抄爱好）
// ---------------------------------------------------------------------------

test('scheduleOverlap：能数出和最近几天重复了几条', () => {
  const recent = [
    { date: '2026-10-29', schedule: [{ time: '14:00', activity: '在窗边画稿' }, { time: '20:00', activity: '手冲咖啡' }] },
  ];
  assert.equal(life.scheduleOverlap([{ time: '14:00', activity: '在窗边画稿。' }], recent), 1);
  assert.equal(life.scheduleOverlap([{ time: '09:00', activity: '去菜市场' }], recent), 0);
  assert.equal(life.scheduleOverlap([], recent), 0);
});

test('buildScheduleMessages：带上星期与最近几天，并要求换点不一样的', () => {
  const prompt = require('../src/main/prompt');
  const messages = prompt.buildScheduleMessages({
    character: character(),
    date: '2026-10-31',
    recent: [{ date: '2026-10-30', schedule: [{ time: '08:30', activity: '做早饭' }] }],
  });
  const all = messages.map((m) => m.content).join('\n');
  assert.match(all, /星期六/);
  assert.match(all, /周末/);
  assert.match(all, /2026-10-30/);
  assert.match(all, /避开|换点不一样的/);
  assert.match(messages[0].content, /工作日和周末/);
});

test('ensureSchedule：活动池提示词带角色设定与禁止类型', async (t) => {
  const dir = tempDir();
  const c = character();
  const seen = [];
  mockLlm(t, async ({ messages }) => {
    seen.push(messages);
    return {
      text: MODEL_POOL,
      usage: { promptTokens: 10, completionTokens: 10, estimated: false },
      model: 'mock',
    };
  });

  const result = await life.ensureSchedule({
    dir, character: c, date: '2026-10-27', profile: PROFILE, settings: settings(), now: new Date(2026, 9, 27, 6, 0, 0),
  });
  assert.equal(result.generated, true);
  assert.equal(seen.length, 1, '生成池子只调用一次');
  const all = seen[0].map((m) => m.content).join('\n');
  assert.match(all, /自由插画师/);
  assert.match(all, /禁止出现的类型/);
  assert.match(all, /通勤|开会|坐班/, '自由职业要明确禁止工作类活动');
  assert.match(all, /聚会|饭局/, '低社交角色要明确禁止聚会');
  assert.match(all, /允许的类型/);
  assert.match(all, /20–24 条/);
});

test('ensureSchedule：池子按周复用，第二天 0 次模型调用', async (t) => {
  const dir = tempDir();
  const c = character();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return {
      text: MODEL_POOL,
      usage: { promptTokens: 10, completionTokens: 10, estimated: false },
      model: 'mock',
    };
  });

  await life.ensureSchedule({
    dir, character: c, date: '2026-10-27', profile: PROFILE, settings: settings(), now: new Date(2026, 9, 27, 6, 0, 0),
  });
  assert.equal(calls, 1);

  const storedChar = store.listCharacters(dir)[0];
  const second = await life.ensureSchedule({
    dir,
    character: storedChar,
    date: '2026-10-28',
    profile: PROFILE,
    settings: settings(),
    now: new Date(2026, 9, 28, 6, 0, 0),
  });
  assert.equal(calls, 1, '同一周的第二天不应再调模型');
  assert.equal(second.generated, false);
  assert.equal(second.timeline.days['2026-10-28'].scheduleSource, 'pool');
  assert.ok(second.timeline.days['2026-10-28'].schedule.length >= 3);
});

// ---------------------------------------------------------------------------
// 生日当天的日程（P1）
// ---------------------------------------------------------------------------

function withBirthday(month, day) {
  const base = character();
  return {
    ...base,
    persona: {
      ...base.persona,
      birthday: { calendar: 'solar', year: 1999, month, day },
    },
  };
}

test('ensureSchedule：生日当天多一条 19:30 的生日活动（模板兜底同样生效）', async () => {
  const dir = tempDir();
  const c = withBirthday(10, 27);

  const result = await life.ensureSchedule({
    dir, character: c, date: '2026-10-27', settings: settings(), now: new Date(2026, 9, 27, 6, 0, 0),
  });
  const schedule = result.timeline.days['2026-10-27'].schedule;

  assert.equal(result.generated, false);
  assert.ok(schedule.length >= 4 && schedule.length <= 6, '抽样 3–5 条 + 生日 1 条');
  const birthdayItem = schedule.find((item) => item.time === '19:30');
  assert.ok(birthdayItem, '应补 19:30 的生日条目');
  assert.match(birthdayItem.activity, /生日/);
  assert.ok(isAscending(schedule), '补完后仍按时间升序');
});

test('ensureSchedule：非生日当天不会多出这条', async () => {
  const dir = tempDir();
  const c = withBirthday(10, 28);

  const result = await life.ensureSchedule({
    dir, character: c, date: '2026-10-27', settings: settings(), now: new Date(2026, 9, 27, 6, 0, 0),
  });
  const schedule = result.timeline.days['2026-10-27'].schedule;

  assert.equal(schedule.some((item) => item.time === '19:30'), false);
  assert.ok(schedule.length >= 3 && schedule.length <= 5);
});

test('ensureSchedule：生日当天从池子抽样后也会补一条，且最多 6 条', async (t) => {
  const dir = tempDir();
  const c = withBirthday(10, 27);
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: MODEL_POOL, usage: { promptTokens: 10, completionTokens: 10, estimated: false }, model: 'mock' };
  });

  const first = await life.ensureSchedule({
    dir, character: c, date: '2026-10-27', profile: PROFILE, settings: settings(), now: new Date(2026, 9, 27, 6, 0, 0),
  });
  const firstSchedule = first.timeline.days['2026-10-27'].schedule;
  assert.equal(first.generated, true);
  assert.ok(firstSchedule.length <= 6, '生日当天最多 6 条');
  assert.equal(firstSchedule.filter((item) => item.time === '19:30').length, 1);
  assert.match(firstSchedule.find((item) => item.time === '19:30').activity, /生日/);
  assert.ok(isAscending(firstSchedule));

  const second = await life.ensureSchedule({
    dir,
    character: store.listCharacters(dir)[0],
    date: '2026-10-28',
    profile: PROFILE,
    settings: settings(),
    now: new Date(2026, 9, 28, 6, 0, 0),
  });
  const secondSchedule = second.timeline.days['2026-10-28'].schedule;
  assert.equal(calls, 1, '第二天复用同一周的池子');
  assert.equal(second.timeline.days['2026-10-28'].scheduleSource, 'pool');
  assert.equal(secondSchedule.some((item) => item.time === '19:30'), false, '非生日不加生日条目');
  assert.ok(isAscending(secondSchedule));
});

// ---------------------------------------------------------------------------
// P4：节日 / 节气 / 天气接入
// ---------------------------------------------------------------------------

test('ensureSchedule：节日当天插入节日活动，天气缓存到 state（不联网时按季节估算）', async () => {
  const dir = tempDir();
  const c = character();

  const result = await life.ensureSchedule({
    dir,
    character: c,
    date: '2026-02-17',
    settings: settings(),
    now: new Date(2026, 1, 17, 6, 0, 0),
  });
  const day = result.timeline.days['2026-02-17'];
  assert.ok(day.schedule.length >= 3 && day.schedule.length <= 6, `实际 ${day.schedule.length} 条`);
  assert.ok(isAscending(day.schedule));
  assert.ok(
    day.schedule.some((item) => /春节|饺子/.test(item.activity)),
    '春节当天应有一条节日活动',
  );

  const stored = stateEngine.readState(dir, 'char-test', new Date(2026, 1, 17, 9, 0, 0));
  assert.equal(stored.weather.source, 'seasonal');
  assert.equal(stored.weather.day, '2026-02-17');
});

test('ensureSchedule：useWeather=true 时取 Open-Meteo 结果并在当天复用', async (t) => {
  const dir = tempDir();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('api.open-meteo.com'));
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ current: { temperature_2m: 22.6, weather_code: 0 } }),
    };
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const now = new Date(2026, 9, 27, 6, 0, 0);
  const first = await life.ensureSchedule({
    dir,
    character: character(),
    date: '2026-10-27',
    settings: settings({ useWeather: true }),
    now,
  });
  assert.ok(first.timeline.days['2026-10-27'].schedule.length >= 3);
  assert.equal(calls, 1);
  const stored = stateEngine.readState(dir, 'char-test', now);
  assert.equal(stored.weather.source, 'open-meteo');
  assert.equal(stored.weather.code, 'clear');
  assert.equal(stored.weather.tempC, 22.6);

  await life.ensureSchedule({
    dir,
    character: character(),
    date: '2026-10-27',
    settings: settings({ useWeather: true }),
    now,
  });
  assert.equal(calls, 1, '当天已有真实天气缓存时不应重复请求');
});


// ---------------------------------------------------------------------------
// 11. 日程模型自检（P9）
// ---------------------------------------------------------------------------

function timesFromReviewPrompt(messages) {
  const text = (messages || []).map((m) => m.content).join('\n');
  const found = text.match(/\b\d{2}:\d{2}\b/g) || [];
  return Array.from(new Set(found));
}

test('ensureSchedule：开启自检时多调一次，并采纳修正后的文案', async (t) => {
  const dir = tempDir();
  const c = character();
  let calls = 0;
  mockLlm(t, async ({ messages }) => {
    calls += 1;
    if (calls === 1) {
      return { text: MODEL_POOL, usage: { promptTokens: 10, completionTokens: 10, estimated: false }, model: 'mock' };
    }
    const times = timesFromReviewPrompt(messages);
    const reviewed = times.map((time) => ({ time, activity: '自检修正后的安排', category: 'home' }));
    return { text: JSON.stringify(reviewed), usage: { promptTokens: 5, completionTokens: 5, estimated: false }, model: 'mock' };
  });

  const result = await life.ensureSchedule({
    dir, character: c, date: '2026-10-29', profile: PROFILE,
    settings: settings({ scheduleReview: true }), now: new Date(2026, 9, 29, 6, 0, 0),
  });

  assert.equal(calls, 2, '开启自检应多一次调用');
  assert.match(result.timeline.days['2026-10-29'].scheduleSource, /review/);
  assert.ok(result.timeline.days['2026-10-29'].schedule.every((row) => row.activity === '自检修正后的安排'));
});

test('ensureSchedule：自检返回条数不一致时整体放弃，沿用原日程', async (t) => {
  const dir = tempDir();
  const c = character();
  let calls = 0;
  let firstSchedule = null;
  mockLlm(t, async () => {
    calls += 1;
    if (calls === 1) return { text: MODEL_POOL, usage: { promptTokens: 10, completionTokens: 10, estimated: false }, model: 'mock' };
    // 只返回一条，条数对不上
    return { text: JSON.stringify([{ time: '08:00', activity: '只有一条', category: 'home' }]), usage: {}, model: 'mock' };
  });

  const result = await life.ensureSchedule({
    dir, character: c, date: '2026-10-30', profile: PROFILE,
    settings: settings({ scheduleReview: true }), now: new Date(2026, 9, 30, 6, 0, 0),
  });
  const day = result.timeline.days['2026-10-30'];
  firstSchedule = day.schedule;
  assert.equal(calls, 2);
  assert.ok(!firstSchedule.some((row) => row.activity === '只有一条'), '不合格结果不应被采纳');
  assert.doesNotMatch(day.scheduleSource, /review/);
});

test('ensureSchedule：自检给出违约类别（自由职业出现工作）时整体放弃', async (t) => {
  const dir = tempDir();
  const c = character();
  let calls = 0;
  mockLlm(t, async ({ messages }) => {
    calls += 1;
    if (calls === 1) return { text: MODEL_POOL, usage: { promptTokens: 10, completionTokens: 10, estimated: false }, model: 'mock' };
    const times = timesFromReviewPrompt(messages);
    return {
      text: JSON.stringify(times.map((time) => ({ time, activity: '去公司开会', category: 'work' }))),
      usage: {},
      model: 'mock',
    };
  });

  const result = await life.ensureSchedule({
    dir, character: c, date: '2026-10-31', profile: PROFILE,
    settings: settings({ scheduleReview: true }), now: new Date(2026, 9, 31, 6, 0, 0),
  });
  const day = result.timeline.days['2026-10-31'];
  assert.ok(!day.schedule.some((row) => /开会/.test(row.activity)), '违约内容不应写入');
  assert.doesNotMatch(day.scheduleSource, /review/);
});

test('ensureSchedule：关闭自检时仍然只调一次模型', async (t) => {
  const dir = tempDir();
  const c = character();
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: MODEL_POOL, usage: { promptTokens: 10, completionTokens: 10, estimated: false }, model: 'mock' };
  });
  await life.ensureSchedule({
    dir, character: c, date: '2026-11-01', profile: PROFILE,
    settings: settings({ scheduleReview: false }), now: new Date(2026, 10, 1, 6, 0, 0),
  });
  assert.equal(calls, 1);
});

test('withWorkAnchor：补入固定活动并挤掉同时段', () => {
  const c = { life: { workAnchor: { time: '20:00', activity: '开播' } } };
  const out = life.withWorkAnchor([
    { time: '19:30', activity: '浇花' },
    { time: '21:30', activity: '看剧' },
  ], c).schedule;
  assert.deepEqual(out.map((row) => row.time), ['20:00', '21:30']);
  assert.equal(out[0].activity, '开播');
});

test('withRoutineAnchors：补入练琴并挤掉同时段，已有同名则跳过', () => {
  const c = { life: { routineAnchors: [{ time: '14:30', activity: '练琴' }] } };
  const out = life.withRoutineAnchors([
    { time: '14:00', activity: '浇花' },
    { time: '20:00', activity: '看剧' },
  ], c).schedule;
  assert.deepEqual(out.map((row) => row.time), ['14:30', '20:00']);
  assert.equal(out[0].activity, '练琴');

  const again = life.withRoutineAnchors(out, c).schedule;
  assert.equal(again.filter((row) => row.activity === '练琴').length, 1);
});

test('proactiveGapOk：单条至少间隔 180 分钟，同一天多条缩到 30 分钟', () => {
  const day = { lastProactiveAt: '2026-10-31T08:00:00+08:00' };
  assert.equal(life.proactiveGapOk(day, '2026-10-31T08:30:00+08:00'), false);
  assert.equal(life.proactiveGapOk(day, '2026-10-31T10:59:00+08:00'), false);
  assert.equal(life.proactiveGapOk(day, '2026-10-31T11:00:00+08:00'), true);

  const multi = {
    lastProactiveAt: '2026-10-31T08:00:00+08:00',
    proactivePlan: { slots: [{ time: '08:00' }, { time: '08:30' }] },
  };
  assert.equal(life.proactiveGapOk(multi, '2026-10-31T08:20:00+08:00'), false);
  assert.equal(life.proactiveGapOk(multi, '2026-10-31T08:30:00+08:00'), true);
  assert.equal(life.proactiveGapOk({}, new Date()), true);
});

const WEEK_DATES = [
  '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29',
  '2026-10-30', '2026-10-31', '2026-11-01',
];

test('ensureProactivePlan：周末次数固定，按日期分配到她的空闲时段', () => {
  const settings = { life: { quietFrom: '23:30', quietTo: '08:00', proactiveWeekMin: 5, proactiveWeekMax: 5 } };
  const character = { id: 'c', persona: { inner: { profile: { expressiveness: 50 } } } };
  const timeline = { days: {} };
  let slotCount = 0;
  for (let index = 0; index < WEEK_DATES.length; index += 1) {
    const date = WEEK_DATES[index];
    const day = {
      schedule: [
        { time: '08:00', activity: '早饭' },
        { time: '18:00', activity: '晚饭' },
      ],
    };
    const plan = life.ensureProactivePlan(
      day, character, settings, date, new Date(2026, 9, 26 + index, 6), timeline,
    );
    assert.equal(plan.version, 5);
    assert.equal(plan.weekCount, 5);
    if (!plan.selected) {
      assert.equal(plan.slots.length, 0);
      continue;
    }
    slotCount += plan.slots.length;
    for (const slot of plan.slots) {
      assert.ok(slot.time >= '09:00' && slot.time <= '23:30', `应落在空闲时段，实际 ${slot.time}`);
    }
    // 模拟这一天已经发过，后续日期据此扣减本周条数
    timeline.days[date] = { proactive: { idle: true } };
  }
  assert.equal(slotCount, 5, '整周排到的条数应等于本周目标');
});

test('proactiveSlotMinutesList：全天空闲的角色也能在白天排到主动消息', () => {
  const day = { schedule: [] };
  const settings = { life: { quietFrom: '23:30', quietTo: '08:00' } };
  const slots = life.proactiveSlotMinutesList(day, settings, 6);
  assert.equal(slots.length, 6);
  const times = slots.map((minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  assert.ok(times.some((time) => time < '19:00'), `应出现白天的时段，实际 ${times.join(' ')}`);
  for (let index = 1; index < slots.length; index += 1) {
    assert.ok(slots[index] - slots[index - 1] >= 30, `间隔应 ≥30 分钟：${times.join(' ')}`);
  }
});

test('ensureProactivePlan：今天已经发过，不再把今天算进剩余名额', () => {
  const date = '2026-10-26';
  const character = { id: 'already-sent', persona: { inner: { profile: { expressiveness: 50 } } } };
  const timeline = { days: { [date]: { proactive: { idle: true } } } };
  const day = { schedule: [{ time: '18:00', activity: '晚饭' }] };
  const plan = life.ensureProactivePlan(
    day,
    character,
    { life: { quietFrom: '23:30', quietTo: '08:00', proactiveWeekMin: 5, proactiveWeekMax: 5 } },
    date,
    new Date(2026, 9, 26, 22),
    timeline,
  );
  assert.equal(plan.selected, false);
  assert.equal(plan.weekSent, 1);
  assert.equal(plan.weekPlanned, plan.weekCount - 1);
});

test('ensureProactivePlan：范围 0–0 关闭，0–10 随机在范围内，10 次会出现一天多条', () => {
  const character = { id: 'weekly-count', persona: { inner: { profile: { expressiveness: 50 } } } };
  const countFor = (min, max) => {
    const timeline = { days: {} };
    let count = 0;
    let maxPerDay = 0;
    for (let index = 0; index < WEEK_DATES.length; index += 1) {
      const date = WEEK_DATES[index];
      const day = { schedule: [{ time: '18:00', activity: '晚饭' }] };
      const plan = life.ensureProactivePlan(
        day, character,
        { life: { quietFrom: '23:30', quietTo: '08:00', proactiveWeekMin: min, proactiveWeekMax: max } },
        date, new Date(2026, 9, 26 + index, 6), timeline,
      );
      count += plan.dayCount;
      maxPerDay = Math.max(maxPerDay, plan.slots.length);
      if (plan.selected) timeline.days[date] = { proactive: { idle: true } };
    }
    return { count, maxPerDay };
  };

  const off = countFor(0, 0);
  assert.equal(off.count, 0);
  assert.equal(off.maxPerDay, 0);

  const ranged = countFor(0, 10);
  assert.ok(ranged.count >= 0 && ranged.count <= 10, `实际 ${ranged.count}`);

  const many = countFor(10, 10);
  assert.equal(many.count, 10);
  assert.ok(many.maxPerDay >= 2, '超过 7 次时应出现某天多条');
});

/** 跑完一整周，读回已存的周计划（days: { 'YYYY-MM-DD': 条数 }） */
function weekPlanStats(characterId, min, max) {
  const timeline = { days: {} };
  const character = { id: characterId, persona: { inner: { profile: { expressiveness: 50 } } } };
  const settings = {
    life: { quietFrom: '23:30', quietTo: '08:00', proactiveWeekMin: min, proactiveWeekMax: max },
  };
  for (let index = 0; index < WEEK_DATES.length; index += 1) {
    const date = WEEK_DATES[index];
    const day = { schedule: [{ time: '18:00', activity: '晚饭' }] };
    const plan = life.ensureProactivePlan(
      day, character, settings, date, new Date(2026, 9, 26 + index, 6), timeline,
    );
    if (plan.selected) timeline.days[date] = { proactive: { idle: true } };
  }
  const weekKey = Object.keys(timeline.proactiveWeeks)[0];
  const days = timeline.proactiveWeeks[weekKey].days;
  const values = Object.values(days);
  return {
    days,
    total: values.reduce((sum, times) => sum + times, 0),
    maxPerDay: Math.max(0, ...values),
    activeDays: values.length,
  };
}

test('每周次数随机分到若干天：5 条会出现「少几天、某天多条」，不按天平均', () => {
  const results = ['cluster-a', 'cluster-b', 'cluster-c', 'cluster-d', 'cluster-e']
    .map((id) => weekPlanStats(id, 5, 5));
  for (const item of results) {
    assert.equal(item.total, 5);
    assert.ok(item.activeDays >= 2 && item.activeDays <= 5, `占用天数 ${item.activeDays}`);
    assert.ok(item.maxPerDay <= 3, `单日 ${item.maxPerDay} 条`);
  }
  assert.ok(
    results.some((item) => item.activeDays < 5 && item.maxPerDay >= 2),
    `5 条应能集中到少于 5 天并出现某天多条：${JSON.stringify(results.map((i) => i.days))}`,
  );
});

test('每周次数上限：30 条时单日最多 5 条，63 条时铺满 7 天且单日最多 9 条', () => {
  const mid = weekPlanStats('cap-30', 30, 30);
  assert.equal(mid.total, 30);
  assert.ok(mid.maxPerDay <= 5, `30 条时单日 ${mid.maxPerDay} 条`);
  assert.ok(mid.activeDays >= 6, `30 条应占用至少 6 天，实际 ${mid.activeDays}`);

  const full = weekPlanStats('cap-63', 63, 63);
  assert.equal(full.total, 63);
  assert.equal(full.activeDays, 7);
  assert.equal(full.maxPerDay, 9);
});

test('ensureProactivePlan：周日才启动也不会把整周次数全塞进一天', () => {
  const character = { id: 'late-week', persona: { inner: { profile: { expressiveness: 50 } } } };
  const timeline = { days: {} };
  const day = { schedule: [{ time: '18:00', activity: '晚饭' }] };
  const plan = life.ensureProactivePlan(
    day, character,
    { life: { quietFrom: '23:30', quietTo: '08:00', proactiveWeekMin: 10, proactiveWeekMax: 10 } },
    '2026-11-01', new Date(2026, 10, 1, 6), timeline,
  );
  assert.equal(plan.weekCount, 10);
  assert.equal(plan.dayCount, 3, '10 条时单日上限为 3 条');
  assert.equal(plan.slots.length, 3);
});

test('proactiveAffinity：表达低 / 关系冷淡低于表达高 / 关系亲近', () => {
  const low = {
    persona: {
      relationship: '刚认识，不太联系',
      inner: { profile: { social: 10, pace: 20, expressiveness: 10 } },
    },
  };
  const high = {
    persona: {
      relationship: '认识很久，很亲密，日常互相照应',
      inner: { profile: { social: 90, pace: 80, expressiveness: 90 } },
    },
  };
  const lowScore = life.proactiveAffinity(low, null, { mood: 30, energy: 30 }, new Date(2026, 9, 26));
  const highScore = life.proactiveAffinity(high, null, { mood: 90, energy: 90 }, new Date(2026, 9, 26));
  assert.ok(highScore > lowScore + 0.25, `高 ${highScore} 应明显高于低 ${lowScore}`);
});

test('proactiveDayLimit：当天多条按 slot 放开，表达低仍压到 1 条', () => {
  const settings = { life: { proactivePerDay: 1 } };
  const day = { proactivePlan: { slots: [{ time: '22:00' }, { time: '22:30' }] } };
  const normal = { persona: { inner: { profile: { expressiveness: 50 } } } };
  const low = { persona: { inner: { profile: { expressiveness: 20 } } } };
  assert.equal(life.proactiveDayLimit(day, settings, normal), 2);
  assert.equal(life.proactiveDayLimit(day, settings, low), 1);
  assert.equal(life.proactiveDayLimit({}, settings, normal), 1);
});

test('proactiveSlotOpen：只在落点后 30 分钟内有效', () => {
  const day = { proactivePlan: { slots: [{ time: '10:00', sent: false }] } };
  assert.equal(life.proactiveSlotOpen(day, '2026-10-31T09:59:00+08:00'), false);
  assert.equal(life.proactiveSlotOpen(day, '2026-10-31T10:00:00+08:00'), true);
  assert.equal(life.proactiveSlotOpen(day, '2026-10-31T10:30:00+08:00'), true);
  assert.equal(life.proactiveSlotOpen(day, '2026-10-31T10:31:00+08:00'), false);
});

test('proactiveSlotOpen：非主动日 / 已发送的时段不再打开', () => {
  const skipped = { proactivePlan: { selected: false, slots: [{ time: '22:00', sent: false }] } };
  const sent = { proactivePlan: { selected: true, slots: [{ time: '22:00', sent: true }] } };
  assert.equal(life.proactiveSlotOpen(skipped, '2026-10-31T22:00:00+08:00'), false);
  assert.equal(life.proactiveSlotOpen(sent, '2026-10-31T22:00:00+08:00'), false);
});

test('advanceEvents：练琴事件不会串成改稿/铅笔屑', () => {
  const result = life.advanceEvents({
    timeline: {
      days: { [DATE]: makeDay({ schedule: [{ time: '14:30', activity: '练琴，练一会儿就停' }] }) },
    },
    now: new Date(2026, 9, 26, 14, 30, 0),
    character: character(),
  });
  assert.equal(result.fired.length, 1);
  // 事件只显示细节本身，不再前置日程原句；但细节必须仍是练琴相关
  assert.ok(!result.fired[0].text.includes('练琴，练一会儿就停。'));
  assert.ok(/(琴|键|段|手指)/.test(result.fired[0].text), result.fired[0].text);
  assert.ok(!/(改稿|铅笔|改两笔)/.test(result.fired[0].text));
});


test('eventTextFor：打电话类活动补的是通话细节，不会接成“走神”', () => {
  const text = life.eventTextFor({ activity: '给妈妈回个电话，说吃了，说睡得好', category: 'home' }, 0);
  // 不再复述日程原句，只留细节句
  assert.ok(!text.includes('给妈妈回个电话'), text);
  assert.ok(!text.includes('走神'), text);
  assert.ok(/(接话|挂了电话|手机|家常)/.test(text), text);
});
