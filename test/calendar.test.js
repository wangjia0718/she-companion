'use strict';

// 节日 / 节气 / 季节 / 季节概率天气（P4）。纯逻辑，不联网。

const { test } = require('node:test');
const assert = require('node:assert');

const calendar = require('../src/main/calendar');
const activity = require('../src/main/activity');

const FIVE_DIM = {
  social: 50, structure: 50, openness: 70, pace: 50, expressiveness: 50,
};

function character(overrides = {}) {
  const profile = { ...FIVE_DIM, ...(overrides.profile || {}) };
  return {
    id: overrides.id || 'char-cal',
    name: '她',
    life: {
      city: '上海',
      occupation: '自由插画师',
      hobbies: ['逛书店'],
    },
    persona: { inner: { profile } },
  };
}

// ---------------------------------------------------------------------------
// 节日
// ---------------------------------------------------------------------------

test('holidayOf：阳历固定节日', () => {
  assert.deepEqual(calendar.holidayOf('2026-01-01'), { name: '元旦', kind: 'solar' });
  assert.deepEqual(calendar.holidayOf('2026-02-14'), { name: '情人节', kind: 'solar' });
  assert.deepEqual(calendar.holidayOf('2026-03-08'), { name: '妇女节', kind: 'solar' });
  assert.deepEqual(calendar.holidayOf('2026-05-01'), { name: '劳动节', kind: 'solar' });
  assert.deepEqual(calendar.holidayOf('2026-06-01'), { name: '儿童节', kind: 'solar' });
  assert.deepEqual(calendar.holidayOf('2026-10-01'), { name: '国庆', kind: 'solar' });
  assert.deepEqual(calendar.holidayOf('2026-12-24'), { name: '平安夜', kind: 'solar' });
  assert.deepEqual(calendar.holidayOf('2026-12-25'), { name: '圣诞', kind: 'solar' });
});

test('holidayOf：农历大节日（2026 春节 / 2027 春节 / 2028 中秋）', () => {
  assert.deepEqual(calendar.holidayOf('2026-02-17'), { name: '春节', kind: 'lunar' });
  assert.deepEqual(calendar.holidayOf('2026-03-03'), { name: '元宵', kind: 'lunar' });
  assert.deepEqual(calendar.holidayOf('2026-06-19'), { name: '端午', kind: 'lunar' });
  assert.deepEqual(calendar.holidayOf('2026-09-25'), { name: '中秋', kind: 'lunar' });
  assert.deepEqual(calendar.holidayOf('2027-02-06'), { name: '春节', kind: 'lunar' });
  assert.deepEqual(calendar.holidayOf('2028-10-03'), { name: '中秋', kind: 'lunar' });
});

test('holidayOf：普通日子 / 非法日期返回 null，Date 与字符串一致', () => {
  assert.equal(calendar.holidayOf('2026-07-15'), null);
  assert.equal(calendar.holidayOf('not-a-date'), null);
  assert.equal(calendar.holidayOf('2026-02-30'), null);
  assert.deepEqual(calendar.holidayOf(new Date(2026, 9, 1)), calendar.holidayOf('2026-10-01'));
});

// ---------------------------------------------------------------------------
// 节气 / 季节
// ---------------------------------------------------------------------------

test('solarTermOf：2026 节气与普通日', () => {
  assert.equal(calendar.solarTermOf('2026-10-08'), '寒露');
  assert.equal(calendar.solarTermOf('2026-11-07'), '立冬');
  assert.equal(calendar.solarTermOf('2026-12-22'), '冬至');
  assert.equal(calendar.solarTermOf('2026-10-10'), null);
  assert.equal(calendar.solarTermOf('2035-01-05'), null, '表外年份返回 null');
});

test('solarTermOf：每年 24 条，2027–2030 可用', () => {
  for (const year of [2027, 2028, 2029, 2030]) {
    let found = 0;
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= 28; day += 1) {
        const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (calendar.solarTermOf(key)) found += 1;
      }
    }
    // 节气落在 5/6/7/8/20/21/22/23 日附近，1–28 日里应能取到全部 24 个
    assert.equal(found, 24, `${year} 年应有 24 个节气`);
  }
});

test('seasonOf：按月份划分春夏秋冬', () => {
  assert.equal(calendar.seasonOf('2026-03-01'), '春');
  assert.equal(calendar.seasonOf('2026-05-31'), '春');
  assert.equal(calendar.seasonOf('2026-07-15'), '夏');
  assert.equal(calendar.seasonOf('2026-10-27'), '秋');
  assert.equal(calendar.seasonOf('2026-01-01'), '冬');
  assert.equal(calendar.seasonOf('2026-12-25'), '冬');
});

// ---------------------------------------------------------------------------
// 季节概率天气
// ---------------------------------------------------------------------------

test('seasonalWeather：同一天同种子结果完全一致', () => {
  const a = calendar.seasonalWeather('2026-10-27', 'char-a');
  const b = calendar.seasonalWeather('2026-10-27', 'char-a');
  assert.deepEqual(a, b);
  assert.equal(a.source, 'seasonal');
  assert.ok(['clear', 'cloudy', 'rain', 'snow'].includes(a.code));
  assert.equal(a.isRain, a.code === 'rain');
  assert.equal(a.isClear, a.code === 'clear');
});

test('seasonalWeather：不同种子 / 不同日期有变化，但取值始终合法', () => {
  const codes = new Set();
  for (let index = 0; index < 30; index += 1) {
    const value = calendar.seasonalWeather('2026-07-15', `seed-${index}`);
    assert.ok(['clear', 'cloudy', 'rain', 'snow'].includes(value.code));
    codes.add(value.code);
  }
  assert.ok(codes.size >= 2, '不同种子应能抽出不同天气');

  // 冬天允许出现雪
  const winterCodes = new Set();
  for (let index = 0; index < 120; index += 1) {
    winterCodes.add(calendar.seasonalWeather('2026-01-15', `w-${index}`).code);
  }
  assert.ok(winterCodes.has('snow'), '冬天应能抽到雪');
});

// ---------------------------------------------------------------------------
// 节日活动
// ---------------------------------------------------------------------------

test('festivalActivities：春节给出饺子类活动，且全部过硬约束', () => {
  const c = character();
  const items = calendar.festivalActivities(c, c.persona.inner.profile, {
    date: '2026-02-17',
    holiday: { name: '春节', kind: 'lunar' },
    season: '春',
  });
  assert.ok(items.length >= 1 && items.length <= 2);
  assert.ok(items.some((item) => /饺子/.test(item.text)));
  assert.equal(items[0].festival, '春节');
  // 再过一次 filterPool，结果不应被删
  const filtered = activity.filterPool(items, { character: c, profile: c.persona.inner.profile });
  assert.equal(filtered.length, items.length);
});

test('festivalActivities：中秋有月饼，元宵有汤圆', () => {
  const c = character();
  const moon = calendar.festivalActivities(c, c.persona.inner.profile, { date: '2026-09-25' });
  assert.ok(moon.some((item) => /月饼/.test(item.text)));

  const yuanxiao = calendar.festivalActivities(c, c.persona.inner.profile, { date: '2026-03-03' });
  assert.ok(yuanxiao.some((item) => /汤圆/.test(item.text)));
});

test('festivalActivities：低社交 / 低开放角色不会拿到聚会或人群活动', () => {
  const c = character({ profile: { social: 10, openness: 10 } });
  const items = calendar.festivalActivities(c, c.persona.inner.profile, {
    date: '2026-02-17',
    holiday: { name: '春节', kind: 'lunar' },
  });
  assert.ok(items.length >= 1);
  const allowed = new Set(activity.allowedCategories({ character: c, profile: c.persona.inner.profile }));
  for (const item of items) {
    assert.ok(allowed.has(item.category), `${item.category} 应被允许`);
    assert.ok(!['social', 'crowd', 'visit'].includes(item.category));
  }
});

test('festivalActivities：非节日 / 无法识别的节日返回空数组', () => {
  const c = character();
  assert.deepEqual(calendar.festivalActivities(c, c.persona.inner.profile, { date: '2026-07-15' }), []);
});
