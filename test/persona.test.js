'use strict';

// persona.js（P1：生日 + 五维性格 + 内在设定）测试。
// 纯函数部分不依赖磁盘；IPC 部分用临时目录 + 内存 llm stub。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const persona = require('../src/main/persona');
const ipc = require('../src/main/ipc');
const store = require('../src/main/store');
const config = require('../src/main/config');
const usage = require('../src/main/usage');

const NOW = new Date(2026, 9, 27, 10, 0, 0); // 本地时间 2026-10-27 10:00

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-persona-'));
}

const FORBIDDEN = ['星座', '星盘', '生肖', '运势', '白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'];

function assertNoZodiacWords(lines) {
  for (const line of lines) {
    for (const word of FORBIDDEN) {
      assert.equal(line.includes(word), false, `不应出现「${word}」：${line}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. 星座边界
// ---------------------------------------------------------------------------

test('zodiacOf：1/19 与 1/20 分属摩羯 / 水瓶', () => {
  assert.equal(persona.zodiacOf(1, 19), '摩羯座');
  assert.equal(persona.zodiacOf(1, 20), '水瓶座');
});

test('zodiacOf：2/18 与 2/19 分属水瓶 / 双鱼', () => {
  assert.equal(persona.zodiacOf(2, 18), '水瓶座');
  assert.equal(persona.zodiacOf(2, 19), '双鱼座');
});

test('zodiacOf：12/21 与 12/22 分属射手 / 摩羯（跨年边界正确）', () => {
  assert.equal(persona.zodiacOf(12, 21), '射手座');
  assert.equal(persona.zodiacOf(12, 22), '摩羯座');
  assert.equal(persona.zodiacOf(1, 1), '摩羯座');
  assert.equal(persona.zodiacOf(12, 31), '摩羯座');
});

test('zodiacOf：非法月日返回空串，不抛错', () => {
  assert.equal(persona.zodiacOf(0, 10), '');
  assert.equal(persona.zodiacOf(13, 10), '');
  assert.equal(persona.zodiacOf(2, 30), '');
  assert.equal(persona.zodiacOf('', ''), '');
  assert.equal(persona.zodiacOf(6, '15'), '双子座');
});

// ---------------------------------------------------------------------------
// 2. 12 星座基准
// ---------------------------------------------------------------------------

test('12 星座都有五维基准，彼此不同且都在 0–100', () => {
  const dates = [
    [1, 25], [2, 25], [3, 25], [4, 25], [5, 25], [6, 25],
    [7, 25], [8, 25], [9, 25], [10, 25], [11, 25], [12, 25],
  ];
  const seen = new Set();
  for (const [month, day] of dates) {
    const sign = persona.zodiacOf(month, day);
    const profile = persona.ZODIAC_TABLE[sign];
    assert.ok(profile, `缺少 ${sign} 的基准值`);
    assert.equal(persona.PROFILE_KEYS.length, 5);
    for (const key of persona.PROFILE_KEYS) {
      assert.equal(typeof profile[key], 'number');
      assert.ok(profile[key] >= 0 && profile[key] <= 100, `${sign}.${key} 越界`);
    }
    const tuple = persona.PROFILE_KEYS.map((key) => profile[key]).join(',');
    assert.equal(seen.has(tuple), false, `${sign} 的五维和别的星座重复`);
    seen.add(tuple);
  }
  assert.equal(seen.size, 12);
  assert.deepEqual(persona.PROFILE_KEYS, ['social', 'structure', 'openness', 'pace', 'expressiveness']);
});

// ---------------------------------------------------------------------------
// 3. 职业 / 宠物修正
// ---------------------------------------------------------------------------

test('autoProfile：自由职业 structure −10，结果仍在 0–100', () => {
  const birthday = { month: 5, day: 25 }; // 双子座 structure 35
  const base = persona.autoProfile({ birthday, life: {} });
  const free = persona.autoProfile({ birthday, life: { occupation: '自由职业' } });
  assert.equal(free.structure, Math.max(0, base.structure - 10));
  assert.equal(free.openness, base.openness);

  const floored = persona.autoProfile({
    birthday: { month: 2, day: 19 },
    life: { occupation: '自由撰稿人' }, // 双鱼 structure 30 → 20
  });
  assert.ok(floored.structure >= 0);
});

test('autoProfile：创意职业 openness +10，自由创意职业两项都生效', () => {
  const birthday = { month: 5, day: 25 }; // 双子座 openness 75
  const creative = persona.autoProfile({ birthday, life: { occupation: '插画师' } });
  assert.equal(creative.openness, 85);

  const both = persona.autoProfile({ birthday, life: { occupation: '自由插画师' } });
  assert.equal(both.openness, 85);
  assert.equal(both.structure, 25);
});

test('autoProfile：有宠物 social +5（不超 100）', () => {
  const birthday = { month: 8, day: 1 }; // 狮子座 social 75
  const withCat = persona.autoProfile({ birthday, life: { pets: ['猫'] } });
  assert.equal(withCat.social, 80);

  const capped = persona.autoProfile({
    birthday: { month: 8, day: 1 },
    life: { hasPet: true, occupation: '自由插画师' },
  });
  assert.ok(capped.social <= 100);
  assert.equal(capped.social, 80);
});

test('autoProfile：没生日 / 非法生日时给中值，不抛错', () => {
  const empty = persona.autoProfile({});
  assert.deepEqual(empty, {
    social: 50, structure: 50, openness: 50, pace: 50, expressiveness: 50,
  });
  const weird = persona.autoProfile({ birthday: '1999-06-15', life: null });
  assert.equal(weird.social, 50);
});

// ---------------------------------------------------------------------------
// 4. autoTraits
// ---------------------------------------------------------------------------

test('autoTraits：5–8 条具体行为，不含星座 / 生肖类词，且不重复', () => {
  const birthday = { month: 11, day: 25 };
  const profile = persona.autoProfile({ birthday, life: { occupation: '自由插画师' } });
  const traits = persona.autoTraits({
    zodiac: persona.zodiacOf(11, 25),
    profile,
    life: { occupation: '自由插画师' },
  });

  assert.ok(traits.length >= 5 && traits.length <= 8, `实际 ${traits.length} 条`);
  assert.equal(new Set(traits).size, traits.length);
  assertNoZodiacWords(traits);
  for (const line of traits) {
    assert.ok(line.trim().length >= 4, `句子太短：${line}`);
    assert.ok(!line.includes('她'), '行为描述用无主语句式，不要出现「她」');
  }
});

test('autoTraits：高社交 / 低社交挑到不同句子', () => {
  const low = persona.autoTraits({
    zodiac: '双鱼座',
    profile: { social: 10, structure: 50, openness: 50, pace: 50, expressiveness: 50 },
  });
  const high = persona.autoTraits({
    zodiac: '双鱼座',
    profile: { social: 95, structure: 50, openness: 50, pace: 50, expressiveness: 50 },
  });
  assert.notDeepEqual(low, high);
  assert.match(low.join('|'), /人多|一个人|安静/);
  assert.match(high.join('|'), /约人|人多|认识新朋友/);
});

// ---------------------------------------------------------------------------
// 5. sanitizeInner
// ---------------------------------------------------------------------------

test('sanitizeInner：null / 字符串 / 数组 / 越界值都不抛，回落默认', () => {
  const fromNull = persona.sanitizeInner(null);
  assert.equal(fromNull.zodiac, '');
  assert.deepEqual(fromNull.profile, {
    social: 50, structure: 50, openness: 50, pace: 50, expressiveness: 50,
  });
  assert.deepEqual(fromNull.traits, []);
  assert.deepEqual(fromNull.boundaries, []);
  assert.equal(fromNull.generatedAt, null);
  assert.equal(fromNull.source, 'auto');

  const fromString = persona.sanitizeInner('不是对象');
  assert.deepEqual(fromString.profile, fromNull.profile);

  const fromArray = persona.sanitizeInner([1, 2, 3]);
  assert.deepEqual(fromArray.traits, []);

  const outOfRange = persona.sanitizeInner({
    zodiac: '不存在的座',
    profile: { social: 999, structure: -20, openness: 'abc', pace: 66.7, expressiveness: null },
    traits: ['不喜欢人多的地方', '  ', 42, null],
    boundaries: '不主动提自己的生日',
    generatedAt: '  ',
    source: 'weird',
  });
  assert.equal(outOfRange.zodiac, '');
  assert.equal(outOfRange.profile.social, 100);
  assert.equal(outOfRange.profile.structure, 0);
  assert.equal(outOfRange.profile.openness, 50);
  assert.equal(outOfRange.profile.pace, 67);
  assert.equal(outOfRange.profile.expressiveness, 50);
  assert.deepEqual(outOfRange.traits, ['不喜欢人多的地方']);
  assert.deepEqual(outOfRange.boundaries, ['不主动提自己的生日']);
  assert.equal(outOfRange.generatedAt, null);
  assert.equal(outOfRange.source, 'auto');
});

test('sanitizeInner：剔除含星座 / 生肖词的 traits 与 boundaries，source 只认 manual', () => {
  const inner = persona.sanitizeInner({
    zodiac: '狮子座',
    traits: ['喜欢一个人待着', '双子座都这样', '相信运势'],
    boundaries: ['不主动提自己的星座', '不编造没发生过的事'],
    source: 'manual',
  });
  assert.equal(inner.zodiac, '狮子座');
  assert.deepEqual(inner.traits, ['喜欢一个人待着']);
  assert.deepEqual(inner.boundaries, ['不编造没发生过的事']);
  assert.equal(inner.source, 'manual');
});

// ---------------------------------------------------------------------------
// 6. 生日校验与「今天是不是生日」
// ---------------------------------------------------------------------------

test('birthdayValid：年可空，月日按当月天数校验，2/29 允许', () => {
  assert.equal(persona.birthdayValid({ month: 6, day: 15 }), true);
  assert.equal(persona.birthdayValid({ year: '', month: 6, day: 15 }), true);
  assert.equal(persona.birthdayValid({ year: 1999, month: 2, day: 29 }), true);
  assert.equal(persona.birthdayValid({ year: 1999, month: 2, day: 30 }), false);
  assert.equal(persona.birthdayValid({ year: 1800, month: 6, day: 15 }), false);
  assert.equal(persona.birthdayValid({ year: 2026, month: 13, day: 1 }), false);
  assert.equal(persona.birthdayValid({ month: 4, day: 31 }), false);
  assert.equal(persona.birthdayValid(null), false);
});

test('isBirthdayToday：同月同日为真，跨年前后不误判', () => {
  const birthday = { month: 12, day: 31 };
  assert.equal(persona.isBirthdayToday(birthday, new Date(2026, 11, 31, 9, 0)), true);
  assert.equal(persona.isBirthdayToday(birthday, new Date(2027, 0, 1, 0, 30)), false);

  const newYear = { month: 1, day: 1 };
  assert.equal(persona.isBirthdayToday(newYear, new Date(2026, 11, 31, 23, 59)), false);
  assert.equal(persona.isBirthdayToday(newYear, new Date(2027, 0, 1, 0, 0)), true);
  assert.equal(persona.isBirthdayToday(null, new Date(2027, 0, 1)), false);
});

test('isBirthdayToday：2/29 在闰年当天、平年按 2/28', () => {
  const birthday = { month: 2, day: 29 };
  assert.equal(persona.isBirthdayToday(birthday, new Date(2028, 1, 29, 12, 0)), true);
  assert.equal(persona.isBirthdayToday(birthday, new Date(2026, 1, 28, 12, 0)), true);
  assert.equal(persona.isBirthdayToday(birthday, new Date(2026, 2, 1, 12, 0)), false);
});

test('profileSummary：五维摘要格式固定，越界值先夹取', () => {
  assert.equal(
    persona.profileSummary({ social: 38, structure: 62, openness: 71, pace: 45, expressiveness: 55 }),
    '社交38/规律62/开放71/节奏45/表达55',
  );
  assert.equal(
    persona.profileSummary({ social: 200, structure: -5 }),
    '社交100/规律0/开放50/节奏50/表达50',
  );
});

// ---------------------------------------------------------------------------
// 7. IPC：生成 / 保存内在设定
// ---------------------------------------------------------------------------

function setup(options = {}) {
  const dir = tempDir();
  const character = store.createCharacter(dir, { name: '她' });
  const withBirthday = options.noBirthday
    ? character
    : store.saveCharacter(dir, {
      ...character,
      persona: {
        ...character.persona,
        ...(options.persona || {}),
        birthday: options.noBirthday ? undefined : { calendar: 'solar', year: 1999, month: 6, day: 15 },
      },
    });

  config.saveSettings(dir, {
    api: {
      profiles: [{
        id: 'p1',
        name: 'mock',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'm',
        capabilities: ['chat'],
      }],
      chat: 'p1',
      background: 'p1',
    },
    life: { maxBackgroundCallsPerDay: options.maxBackground === undefined ? 24 : options.maxBackground },
  });

  const calls = [];
  const llm = {
    chat: async (args) => {
      calls.push(args);
      if (options.chat) return options.chat(args);
      throw new Error('不应调用模型');
    },
    testProfile: async () => ({ ok: true, latencyMs: 1, model: 'm', error: null }),
  };

  const handlers = ipc.createHandlers({ dir, now: () => NOW, llm, store, config, usage });
  return { dir, character: withBirthday, handlers, calls };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    /* 清理失败忽略 */
  }
}

const MODEL_INNER = JSON.stringify({
  traits: ['不喜欢人多的地方', '答应的事会记很久', '下雨天会提前关窗', '习惯把杯子放在左手边', '晚上写东西时才说话'],
  boundaries: ['不主动提自己的生日', '不编造没发生过的事'],
});

test('characters:generateInner：没填生日直接报错「先填生日」', async () => {
  const ctx = setup({ noBirthday: true });
  try {
    await assert.rejects(
      () => ctx.handlers['characters:generateInner']({}, { characterId: ctx.character.id }),
      /先填生日/,
    );
    assert.equal(ctx.calls.length, 0);
  } finally {
    cleanup(ctx.dir);
  }
});

test('characters:generateInner：有模型时用模型结果，写回 inner 并记 background 用量', async () => {
  const ctx = setup({ chat: async () => ({ text: MODEL_INNER, usage: { promptTokens: 100, completionTokens: 20 } }) });
  try {
    const result = await ctx.handlers['characters:generateInner']({}, { characterId: ctx.character.id });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'model');
    assert.deepEqual(result.inner.traits, JSON.parse(MODEL_INNER).traits);
    assert.equal(result.inner.zodiac, '双子座');
    assert.equal(result.inner.profile.social, persona.autoProfile({
      birthday: { month: 6, day: 15 },
      life: ctx.character.life,
    }).social);

    const saved = store.listCharacters(ctx.dir).find((item) => item.id === ctx.character.id);
    assert.deepEqual(saved.persona.inner, result.inner);
    assert.equal(saved.persona.birthday.month, 6);
    assert.equal(saved.persona.birthday.day, 15);

    const today = usage.today(ctx.dir, NOW);
    assert.equal(today.background, 1);
    assert.equal(ctx.calls.length, 1);
  } finally {
    cleanup(ctx.dir);
  }
});

test('characters:generateInner：预算不足时用内置规则兜底，不报错、不调模型', async () => {
  const ctx = setup({ maxBackground: 0 });
  try {
    const result = await ctx.handlers['characters:generateInner']({}, { characterId: ctx.character.id });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'auto');
    assert.ok(result.inner.traits.length >= 5 && result.inner.traits.length <= 8);
    assertNoZodiacWords(result.inner.traits);
    assert.equal(ctx.calls.length, 0);

    const saved = store.listCharacters(ctx.dir).find((item) => item.id === ctx.character.id);
    assert.equal(saved.persona.inner.source, 'auto');
    assert.equal(saved.persona.birthday.year, 1999);
  } finally {
    cleanup(ctx.dir);
  }
});

test('characters:generateInner：模型输出不可解析时回落内置规则', async () => {
  const ctx = setup({ chat: async () => ({ text: '我先想想。', usage: { promptTokens: 5, completionTokens: 2 } }) });
  try {
    const result = await ctx.handlers['characters:generateInner']({}, { characterId: ctx.character.id });
    assert.equal(result.source, 'auto');
    assert.ok(result.inner.traits.length >= 5);
    assert.equal(ctx.calls.length, 1);
  } finally {
    cleanup(ctx.dir);
  }
});

test('characters:generateInner：保留用户手改过的 profile，不被自动值覆盖', async () => {
  const manualProfile = { social: 12, structure: 88, openness: 24, pace: 31, expressiveness: 77 };
  const ctx = setup({
    persona: {
      inner: {
        zodiac: '双子座',
        profile: manualProfile,
        traits: ['不喜欢人多的地方'],
        boundaries: ['不主动提自己的生日'],
        generatedAt: '2026-10-01T10:00:00+08:00',
        source: 'manual',
      },
    },
    chat: async () => ({ text: MODEL_INNER, usage: { promptTokens: 10, completionTokens: 2 } }),
  });
  try {
    const result = await ctx.handlers['characters:generateInner']({}, { characterId: ctx.character.id });
    assert.deepEqual(result.inner.profile, manualProfile);
  } finally {
    cleanup(ctx.dir);
  }
});

test('characters:saveInner：traits / boundaries / profile 手改后标记 manual，生日不动', async () => {
  const ctx = setup({ maxBackground: 0 });
  try {
    await ctx.handlers['characters:generateInner']({}, { characterId: ctx.character.id });
    const result = await ctx.handlers['characters:saveInner']({}, {
      characterId: ctx.character.id,
      inner: {
        profile: { social: 33, structure: 44, openness: 55, pace: 66, expressiveness: 77 },
        traits: ['不喜欢人多的地方', '答应的事会记很久', '下雨天会提前关窗', '习惯把杯子放在左手边', '晚上写东西时才说话'],
        boundaries: ['不主动提自己的生日'],
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.inner.source, 'manual');
    assert.equal(result.inner.profile.social, 33);
    assert.equal(result.inner.traits.length, 5);

    const saved = store.listCharacters(ctx.dir).find((item) => item.id === ctx.character.id);
    assert.equal(saved.persona.inner.source, 'manual');
    assert.deepEqual(saved.persona.inner.profile, result.inner.profile);
    assert.deepEqual(saved.persona.birthday, { calendar: 'solar', year: 1999, month: 6, day: 15 });
  } finally {
    cleanup(ctx.dir);
  }
});
