'use strict';

// 状态系统（P3）：心情 / 体力 / 专注的归一化、跨天结算、事件与聊天微调、行为影响。
// 纯函数为主；读写用临时目录，不碰真实数据。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const state = require('../src/main/state');
const activity = require('../src/main/activity');
const life = require('../src/main/life');
const prompt = require('../src/main/prompt');
const paths = require('../src/main/paths');

const DAY1 = new Date(2026, 9, 27, 10, 0, 0); // 本地 2026-10-27 10:00
const DAY2 = new Date(2026, 9, 28, 10, 0, 0);
const DAY3 = new Date(2026, 9, 29, 10, 0, 0);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-state-'));
}

function baseState(overrides = {}) {
  return {
    mood: 50,
    energy: 50,
    focus: 50,
    day: '2026-10-27',
    updatedAt: '2026-10-27T10:00:00+08:00',
    ...overrides,
  };
}

function settings(overrides = {}) {
  return {
    life: {
      enabled: true,
      quietFrom: '23:30',
      quietTo: '08:00',
      proactivePerDay: 2,
      maxBackgroundCallsPerDay: 24,
      ...overrides,
    },
  };
}

function character(overrides = {}) {
  return {
    id: 'char-state',
    name: '她',
    persona: { traits: ['温柔'], speechStyle: '短句' },
    life: { city: '上海', occupation: '自由插画师' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 默认值与夹取
// ---------------------------------------------------------------------------

test('readState：没有文件时返回默认值（mood 62 / energy 60 / focus 55）', () => {
  const dir = tmpDir();
  const value = state.readState(dir, 'char-state', DAY1);
  assert.equal(value.mood, state.DEFAULT_STATE.mood);
  assert.equal(value.energy, state.DEFAULT_STATE.energy);
  assert.equal(value.focus, state.DEFAULT_STATE.focus);
  assert.equal(value.day, '2026-10-27');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeState：负数 / 超过 100 / NaN 都夹到 0–100，缺字段用默认值', () => {
  const value = state.normalizeState(
    { mood: -20, energy: 130, focus: Number.NaN, day: '2026-10-27' },
    DAY1,
  );
  assert.equal(value.mood, 0);
  assert.equal(value.energy, 100);
  assert.equal(value.focus, 55);
  assert.equal(value.day, '2026-10-27');

  // 数值字符串也接受；小数四舍五入
  const numeric = state.normalizeState({ mood: '70', energy: 60.6 }, DAY1);
  assert.equal(numeric.mood, 70);
  assert.equal(numeric.energy, 61);
});

test('normalizeState：非法 day 用本地日期，weather 原样保留', () => {
  const value = state.normalizeState(
    { day: '2026/10/27', weather: { code: 0, tempC: 21, isRain: false, isClear: true, source: 'seasonal' } },
    DAY1,
  );
  assert.equal(value.day, '2026-10-27');
  assert.equal(value.weather.source, 'seasonal');
});

// ---------------------------------------------------------------------------
// 2. 跨天结算
// ---------------------------------------------------------------------------

test('settleDay：同一天重复调用没有副作用（数值与 updatedAt 都不变）', () => {
  const input = baseState({ mood: 40, energy: 20, focus: 30 });
  const first = state.settleDay(input, DAY1);
  assert.equal(first.mood, 40);
  assert.equal(first.energy, 20);
  assert.equal(first.focus, 30);
  assert.equal(first.updatedAt, input.updatedAt);

  const second = state.settleDay(first, DAY1);
  assert.deepEqual(second, first);
  // 不改入参
  assert.equal(input.mood, 40);
});

test('settleDay：跨一天时体力 +35、心情向 60 回归 1/3、专注向 55 回归 1/3', () => {
  const value = state.settleDay(baseState({ mood: 30, energy: 20, focus: 10 }), DAY2);
  assert.equal(value.energy, 55);
  assert.equal(value.mood, 40); // 30 + (60-30)/3
  assert.equal(value.focus, 25); // 10 + (55-10)/3
  assert.equal(value.day, '2026-10-28');
  assert.ok(value.updatedAt);
});

test('settleDay：跨两天按两天累计（体力封顶 100）', () => {
  const value = state.settleDay(baseState({ mood: 30, energy: 20, focus: 10 }), DAY3);
  assert.equal(value.energy, 90);
  assert.equal(value.mood, 47); // 40 → 40 + 20/3 ≈ 47
  assert.equal(value.focus, 35); // 25 → 25 + 30/3 = 35
  assert.equal(value.day, '2026-10-29');

  const full = state.settleDay(baseState({ mood: 60, energy: 80, focus: 60 }), DAY3);
  assert.equal(full.energy, 100);
});

test('settleDay：首次使用（day 缺失）只写入当天，不改变数值', () => {
  const value = state.settleDay({ mood: 35, energy: 12, focus: 22 }, DAY1);
  assert.equal(value.day, '2026-10-27');
  assert.equal(value.mood, 35);
  assert.equal(value.energy, 12);
  assert.equal(value.focus, 22);
});

// ---------------------------------------------------------------------------
// 3. 事件与聊天
// ---------------------------------------------------------------------------

test('applyEvent：按类别扣减 / 恢复，并更新 updatedAt', () => {
  const cost = state.applyEvent(baseState(), { energyCost: 20, moodDelta: -10, focusDelta: 5, now: DAY1 });
  assert.equal(cost.energy, 30);
  assert.equal(cost.mood, 40);
  assert.equal(cost.focus, 55);
  assert.ok(cost.updatedAt);

  // 负数 energyCost 表示恢复（居家事件）
  const rest = state.applyEvent(baseState({ energy: 40 }), { energyCost: -5, now: DAY1 });
  assert.equal(rest.energy, 45);
});

test('applyEvent：不会越界（0 / 100）', () => {
  const low = state.applyEvent(baseState({ mood: 1, energy: 5, focus: 2 }), {
    energyCost: 50, moodDelta: -10, focusDelta: -10, now: DAY1,
  });
  assert.equal(low.energy, 0);
  assert.equal(low.mood, 0);
  assert.equal(low.focus, 0);

  const high = state.applyEvent(baseState({ mood: 99, energy: 99, focus: 99 }), {
    energyCost: -10, moodDelta: 10, focusDelta: 10, now: DAY1,
  });
  assert.equal(high.energy, 100);
  assert.equal(high.mood, 100);
  assert.equal(high.focus, 100);
});

test('applyChat：正面 +2 心情、-1 体力；负面 -2 心情且不扣体力', () => {
  const plus = state.applyChat(baseState(), { positive: true, now: DAY1 });
  assert.equal(plus.mood, 52);
  assert.equal(plus.energy, 49);

  const minus = state.applyChat(baseState(), { positive: false, now: DAY1 });
  assert.equal(minus.mood, 48);
  assert.equal(minus.energy, 50);
});

test('isPositiveChat：明显负面的话判为负面，普通寒暄判为正面', () => {
  assert.equal(state.isPositiveChat('今天好累，有点想哭'), false);
  assert.equal(state.isPositiveChat('在吗'), true);
});

// ---------------------------------------------------------------------------
// 4. 描述与出门门槛
// ---------------------------------------------------------------------------

test('describeState：不同数值给出不同句子，且不含数字', () => {
  const tired = state.describeState({ mood: 50, energy: 20, focus: 55 });
  const low = state.describeState({ mood: 20, energy: 70, focus: 55 });
  const good = state.describeState({ mood: 80, energy: 80, focus: 80 });
  const distracted = state.describeState({ mood: 50, energy: 50, focus: 20 });

  assert.equal(tired, '有点累，心情还行');
  assert.match(low, /心情不太好/);
  assert.match(good, /精神很好/);
  assert.match(good, /挺专注的/);
  assert.match(distracted, /有点走神/);
  assert.equal(/\d/.test([tired, low, good, distracted].join('')), false);
});

test('canGoOut：体力 29 不行、30 可以', () => {
  assert.equal(state.canGoOut({ energy: 29 }), false);
  assert.equal(state.canGoOut({ energy: 30 }), true);
  assert.equal(state.canGoOut({ energy: 100 }), true);
});

// ---------------------------------------------------------------------------
// 5. 读写往返
// ---------------------------------------------------------------------------

test('writeState / readState 往返（临时目录，原子写落盘）', () => {
  const dir = tmpDir();
  const written = state.writeState(dir, 'char-state', baseState({ mood: 77, energy: 44, focus: 88 }), DAY1);
  assert.ok(fs.existsSync(paths.stateFile(dir, 'char-state')));
  assert.equal(written.mood, 77);

  const read = state.readState(dir, 'char-state', DAY1);
  assert.equal(read.mood, 77);
  assert.equal(read.energy, 44);
  assert.equal(read.focus, 88);
  assert.equal(read.day, '2026-10-27');

  // 文件损坏时按默认值处理，不抛
  fs.writeFileSync(paths.stateFile(dir, 'char-state'), '{oops', 'utf8');
  const broken = state.readState(dir, 'char-state', DAY1);
  assert.equal(broken.mood, state.DEFAULT_STATE.mood);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6. 行为接入（集成）
// ---------------------------------------------------------------------------

test('低体力（20）时 allowedCategories 不含 social / crowd / solo_out', () => {
  const profile = { social: 80, structure: 60, openness: 75, pace: 50, expressiveness: 55 };
  const low = activity.allowedCategories({ profile, state: { energy: 20, mood: 60, focus: 60 } });
  for (const category of ['social', 'crowd', 'solo_out']) {
    assert.equal(low.includes(category), false, `体力 20 不该允许 ${category}`);
  }
  assert.ok(low.includes('home'));

  const normal = activity.allowedCategories({ profile, state: { energy: 80, mood: 60, focus: 60 } });
  assert.ok(normal.includes('social'));
  assert.ok(normal.includes('solo_out'));
});

test('低心情（20）时 pickProactive 每日上限降到 1', () => {
  const day = {
    schedule: [],
    events: [],
    proactive: { boot: true, event: false, idle: false },
  };
  const common = {
    day,
    now: new Date(2026, 9, 27, 15, 0, 0),
    settings: settings(),
    lastUserAt: new Date(2026, 9, 27, 6, 0, 0),
    startedAt: new Date(2026, 9, 27, 14, 0, 0),
  };

  // 正常状态：上限 2，boot 已用还能发 idle
  assert.deepEqual(life.pickProactive({ ...common, state: { mood: 60, energy: 60 } }), { trigger: 'idle' });
  // 心情低：上限 1，已用满 → 不发
  assert.equal(life.pickProactive({ ...common, state: { mood: 20, energy: 60 } }), null);
  // 体力 < 25：完全不打扰
  assert.equal(life.pickProactive({ ...common, state: { mood: 60, energy: 20 } }), null);
});

test('聊天提示词：低状态注入「她现在」与更安静的规则，正常状态不注入规则', () => {
  const common = {
    character: character(),
    memories: [],
    today: null,
    history: [],
    userText: '在吗',
    now: DAY1,
  };
  const low = prompt.buildChatMessages({ ...common, state: { mood: 25, energy: 40, focus: 60 } });
  const lowText = low.map((message) => message.content).join('\n');
  assert.match(lowText, /她现在：/);
  assert.match(lowText, /不要强行热情/);
  assert.equal(/AI/.test(lowText), false);

  const normal = prompt.buildChatMessages({ ...common, state: { mood: 70, energy: 70, focus: 70 } });
  const normalText = normal.map((message) => message.content).join('\n');
  assert.match(normalText, /她现在：/);
  assert.equal(normalText.includes('不要强行热情'), false);
});
