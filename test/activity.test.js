'use strict';

// 活动池与每日抽样（P2）。全部为纯逻辑，不依赖网络 / 文件。

const { test } = require('node:test');
const assert = require('node:assert');

const activity = require('../src/main/activity');

const FIVE_DIM = {
  social: 50, structure: 50, openness: 60, pace: 50, expressiveness: 50,
};

function character(overrides = {}) {
  const life = {
    city: '上海',
    home: '徐汇的小房子',
    occupation: '自由插画师',
    hobbies: ['手冲咖啡', '逛书店'],
    ...(overrides.life || {}),
  };
  const profile = { ...FIVE_DIM, ...(overrides.profile || {}) };
  return {
    id: overrides.id || 'char-a',
    name: '她',
    life,
    persona: {
      traits: ['安静'],
      inner: { profile },
    },
  };
}

function makeItem(category, text, extras = {}) {
  return {
    category,
    text,
    solo: false,
    indoor: true,
    energyCost: 10,
    needs: { socialMin: 0, opennessMin: 0 },
    ...extras,
  };
}

function makePool(items) {
  return {
    generatedAt: '2026-10-27T08:00:00+08:00',
    week: '2026-10-27',
    items,
  };
}

function samplePool() {
  return makePool([
    makeItem('home', '煮了一锅汤，慢慢等它咕嘟'),
    makeItem('home', '把常看的那本书翻到折角那页'),
    makeItem('chore', '把地拖了一遍，水桶换了两次'),
    makeItem('selfcare', '洗了头发，吹到半干'),
    makeItem('discovery', '发现楼下换了新的招牌', { indoor: false }),
    makeItem('discovery', '听到一首没听过的歌，单曲循环了很久'),
    makeItem('solo_out', '去街角书店翻半小时画册', { solo: true, indoor: false }),
    makeItem('create', '改了两页稿子，越改越顺', { solo: true }),
  ]);
}

function minutesOf(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

// ---------------------------------------------------------------------------
// 职业判定
// ---------------------------------------------------------------------------

test('occupationKind：受雇 / 自由 / 创意 / 学生 / 无职业', () => {
  assert.equal(activity.occupationKind(character({ life: { occupation: '公司职员' } })), 'employed');
  assert.equal(activity.occupationKind(character({ life: { occupation: '小学老师' } })), 'employed');
  assert.equal(activity.occupationKind(character({ life: { occupation: '自由插画师' } })), 'freelance');
  assert.equal(activity.occupationKind(character({ life: { occupation: '独立开发者' } })), 'freelance');
  assert.equal(activity.occupationKind(character({ life: { occupation: '插画师' } })), 'creative');
  assert.equal(activity.occupationKind(character({ life: { occupation: '大学生' } })), 'student');
  assert.equal(activity.occupationKind(character({ life: { occupation: '无职业' } })), 'none');
  assert.equal(activity.occupationKind(character({ life: { occupation: '待业' } })), 'none');
  assert.equal(activity.occupationKind(character({ life: { occupation: '' } })), 'none');
  assert.equal(activity.occupationKind({}), 'none');
});

// ---------------------------------------------------------------------------
// 允许类别（spec 2.2 / 2.3）
// ---------------------------------------------------------------------------

test('allowedCategories：home/chore/selfcare/discovery 始终允许', () => {
  const allowed = activity.allowedCategories({
    character: character({
      life: { occupation: '待业' },
      profile: { social: 10, openness: 10 },
    }),
  });
  for (const category of ['home', 'chore', 'selfcare', 'discovery']) {
    assert.ok(allowed.includes(category), `${category} 应始终允许`);
  }
  assert.ok(!allowed.includes('social'));
  assert.ok(!allowed.includes('work'));
});

test('allowedCategories：social 需要 social ≥70 且 openness ≥60', () => {
  const yes = activity.allowedCategories({
    character: character({ profile: { social: 70, openness: 60 } }),
  });
  assert.ok(yes.includes('social'));

  const lowSocial = activity.allowedCategories({
    character: character({ profile: { social: 69, openness: 80 } }),
  });
  assert.ok(!lowSocial.includes('social'));

  const lowOpen = activity.allowedCategories({
    character: character({ profile: { social: 90, openness: 59 } }),
  });
  assert.ok(!lowOpen.includes('social'));
});

test('allowedCategories：visit ≥55、crowd ≥60、solo_out ≥45', () => {
  const mid = activity.allowedCategories({
    character: character({ profile: { social: 55, openness: 45 } }),
  });
  assert.ok(mid.includes('visit'));
  assert.ok(!mid.includes('crowd'));
  assert.ok(mid.includes('solo_out'));

  const crowd = activity.allowedCategories({
    character: character({ profile: { social: 60, openness: 44 } }),
  });
  assert.ok(crowd.includes('crowd'));
  assert.ok(!crowd.includes('solo_out'), 'openness 44 < 45 不应允许独自出门');

  const visit = activity.allowedCategories({
    character: character({ profile: { social: 54 } }),
  });
  assert.ok(!visit.includes('visit'));
});

test('allowedCategories：work 仅受雇型，自由职业 / 学生 / 无职业都没有', () => {
  const employed = activity.allowedCategories({ character: character({ life: { occupation: '公司职员' } }) });
  assert.ok(employed.includes('work'));

  const freelance = activity.allowedCategories({ character: character({ life: { occupation: '自由插画师' } }) });
  assert.ok(!freelance.includes('work'));

  const student = activity.allowedCategories({ character: character({ life: { occupation: '大学生' } }) });
  assert.ok(!student.includes('work'));

  const none = activity.allowedCategories({ character: character({ life: { occupation: '待业' } }) });
  assert.ok(!none.includes('work'));
});

test('allowedCategories：create 只看创作属性（职业或爱好）', () => {
  const byOccupation = activity.allowedCategories({
    character: character({ life: { occupation: '自由插画师', hobbies: [] } }),
  });
  assert.ok(byOccupation.includes('create'));

  const byHobby = activity.allowedCategories({
    character: character({ life: { occupation: '公司职员', hobbies: ['写小说'] } }),
  });
  assert.ok(byHobby.includes('create'));

  const none = activity.allowedCategories({
    character: character({ life: { occupation: '公司职员', hobbies: ['跑步', '做饭'] } }),
  });
  assert.ok(!none.includes('create'));
});

test('allowedCategories：energy < 30 去掉 social/crowd/solo_out，focus < 40 去掉 create', () => {
  const base = character({ profile: { social: 80, openness: 80 } });
  const normal = activity.allowedCategories({ character: base });
  assert.ok(normal.includes('social'));
  assert.ok(normal.includes('crowd'));
  assert.ok(normal.includes('solo_out'));
  assert.ok(normal.includes('create'));

  const tired = activity.allowedCategories({
    character: base,
    state: { energy: 29, focus: 60 },
  });
  assert.ok(!tired.includes('social'));
  assert.ok(!tired.includes('crowd'));
  assert.ok(!tired.includes('solo_out'));
  assert.ok(tired.includes('home'));

  const scattered = activity.allowedCategories({
    character: base,
    state: { energy: 60, focus: 39 },
  });
  assert.ok(!scattered.includes('create'));
});

// ---------------------------------------------------------------------------
// 过滤与兜底池
// ---------------------------------------------------------------------------

test('filterPool：只保留允许类别，并校验 needs 门槛', () => {
  const c = character({ profile: { social: 50, openness: 50 } });
  const items = [
    makeItem('home', '在家看书'),
    makeItem('social', '朋友聚会'),
    makeItem('work', '去公司开会'),
    makeItem('solo_out', '独自去看电影', { solo: true, needs: { opennessMin: 90 } }),
    makeItem('solo_out', '独自散步', { solo: true, needs: { opennessMin: 45 } }),
    makeItem('home', '需要高社交的在家活动', { needs: { socialMin: 80 } }),
  ];
  const kept = activity.filterPool(items, { character: c });
  assert.deepEqual(kept.map((item) => item.text), ['在家看书', '独自散步']);
});

test('filterPool：类别不可用时，文本里的冲突词也会被拦下', () => {
  const freelancer = character({ life: { occupation: '待业', hobbies: [] }, profile: { social: 40, openness: 50 } });
  const items = [
    makeItem('home', '窝在沙发上听歌'),
    makeItem('home', '坐地铁通勤回家'),
    makeItem('home', '和朋友聚会回来'),
    makeItem('home', '下午改稿改到眼酸'),
    makeItem('solo_out', '本来约了人一起出门', { solo: false }),
  ];
  const kept = activity.filterPool(items, { character: freelancer });
  assert.deepEqual(kept.map((item) => item.text), ['窝在沙发上听歌']);
});

test('buildFallbackPool：12–20 条，且严格落在允许集合内', () => {
  const c = character();
  const pool = activity.buildFallbackPool({ character: c });
  assert.ok(pool.length >= 12 && pool.length <= 20, `实际 ${pool.length} 条`);

  const allowed = new Set(activity.allowedCategories({ character: c }));
  for (const item of pool) {
    assert.ok(allowed.has(item.category), `越界类别：${item.category}`);
    assert.ok(item.text.length > 0);
    assert.equal(item.solo, Boolean(item.solo));
    assert.ok(Number.isFinite(item.energyCost));
    assert.ok(item.needs && typeof item.needs === 'object');
  }

  // 自由插画师：不该出现通勤 / 开会 / 公司
  const text = pool.map((item) => item.text).join('|');
  assert.doesNotMatch(text, /通勤|开会|打卡|公司/);
  assert.ok(!pool.some((item) => item.category === 'work'));
});

test('buildFallbackPool：内向角色没有聚会 / 人群密集 / 见朋友', () => {
  const c = character({ profile: { social: 30, openness: 50 } });
  const pool = activity.buildFallbackPool({ character: c });
  assert.ok(pool.length >= 12 && pool.length <= 20);
  for (const item of pool) {
    assert.ok(!['social', 'crowd', 'visit'].includes(item.category), `不该出现 ${item.category}`);
  }
  const text = pool.map((item) => item.text).join('|');
  assert.doesNotMatch(text, /聚会|火锅|市集|商场|朋友家|父母家/);
});

test('buildFallbackPool：低精力时去掉外出类，且确定性', () => {
  const c = character({ profile: { social: 80, openness: 80 } });
  const pool = activity.buildFallbackPool({ character: c, state: { energy: 20, focus: 70 } });
  assert.ok(!pool.some((item) => ['social', 'crowd', 'solo_out'].includes(item.category)));
  assert.ok(pool.length >= 12);

  const a = activity.buildFallbackPool({ character: c });
  const b = activity.buildFallbackPool({ character: c });
  assert.deepEqual(a.map((item) => item.text), b.map((item) => item.text));
});

// ---------------------------------------------------------------------------
// 提示词与解析
// ---------------------------------------------------------------------------

test('buildPoolMessages：要求 20–24 条，并列出禁止类型与字段格式', () => {
  const c = character();
  const messages = activity.buildPoolMessages({ character: c, now: new Date(2026, 9, 27, 9, 0, 0) });
  assert.ok(Array.isArray(messages) && messages.length >= 2);
  const all = messages.map((message) => message.content).join('\n');

  assert.match(all, /20–24 条/);
  assert.match(all, /"category"/);
  assert.match(all, /energyCost/);
  assert.match(all, /needs/);
  assert.match(all, /自由插画师/);
  assert.match(all, /禁止出现的类型/);
  assert.match(all, /通勤|开会|坐班/);
  assert.match(all, /聚会|饭局/);
  assert.match(all, /2026-10-27/);
  // 出门行为白名单：不许发明"专门出门"的活动
  assert.match(all, /她能出门的理由只有/);
  assert.match(all, /不要写「为了出门而出门」/);
});

test('buildPoolMessages：最近出现过的句子会作为“不要复用”传给模型', () => {
  const messages = activity.buildPoolMessages({
    character: character(),
    avoidTexts: ['弹会儿琴，不唱，就磨那几段老卡住的地方'],
  });
  const all = messages.map((message) => message.content).join('\n');
  assert.match(all, /不要复用/);
  assert.match(all, /磨那几段老卡住/);
});

test('parsePool：丢掉「坐两站公交再走回来」这种为了出门而出门的条目', () => {
  const c = character();
  const raw = JSON.stringify([
    { category: 'solo_out', text: '坐两站公交再走回来' },
    { category: 'solo_out', text: '去超市买鸡蛋' },
    { category: 'home', text: '煮一锅小米粥' },
    { category: 'home', text: '浇窗台的绿萝' },
    { category: 'chore', text: '换床单被套' },
    { category: 'chore', text: '拖一遍地板' },
    { category: 'selfcare', text: '泡脚' },
    { category: 'discovery', text: '看楼下那只三花猫' },
  ]);
  const items = activity.parsePool(raw, { character: c });
  assert.ok(items && items.length >= 6);
  assert.ok(!items.some((item) => item.text.includes('坐两站公交')));
  assert.ok(items.some((item) => item.text === '去超市买鸡蛋'));
});

test('parsePool：avoidTexts 中的重复句子会被丢掉', () => {
  const c = character();
  const raw = JSON.stringify([
    { category: 'home', text: '煮了一锅汤' },
    { category: 'home', text: '把书翻到折角那页' },
    { category: 'chore', text: '把地拖了一遍' },
    { category: 'selfcare', text: '洗了头发' },
    { category: 'discovery', text: '发现楼下换了新的招牌' },
    { category: 'create', text: '改了两页稿子' },
    { category: 'home', text: '弹会儿琴，不唱，就磨那几段老卡住的地方' },
  ]);
  const items = activity.parsePool(raw, {
    character: c,
    avoidTexts: ['弹会儿琴，不唱，就磨那几段老卡住的地方'],
  });
  assert.equal(items.length, 6);
  assert.ok(!items.some((item) => item.text.includes('磨那几段老卡住')));
});

test('parsePool：解析围栏 JSON 并补默认字段', () => {
  const c = character();
  const raw = '```json\n' + JSON.stringify([
    { category: 'home', text: '煮了一锅汤' },
    { category: 'home', text: '把书翻到折角那页' },
    { category: 'chore', text: '把地拖了一遍' },
    { category: 'selfcare', text: '洗了头发' },
    { category: 'discovery', text: '发现楼下换了新的招牌' },
    { category: 'create', text: '改了两页稿子' },
  ]) + '\n```';

  const items = activity.parsePool(raw, { character: c });
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 6);
  const home = items.find((item) => item.text === '煮了一锅汤');
  assert.equal(home.solo, true);
  assert.equal(home.indoor, true);
  assert.equal(home.energyCost, 10);
  assert.deepEqual(home.needs, { socialMin: 0, opennessMin: 0, occupation: null });
  assert.match(home.id, /^a\d+$/);
});

test('parsePool：解析失败 / 合格条目 < 6 返回 null，并逐条过硬约束', () => {
  const c = character({ profile: { social: 40, openness: 50 } });
  assert.equal(activity.parsePool('不是 JSON', { character: c }), null);
  assert.equal(activity.parsePool('', { character: c }), null);

  const five = JSON.stringify(
    Array.from({ length: 5 }, (_, index) => ({ category: 'home', text: `在家待着 ${index}` })),
  );
  assert.equal(activity.parsePool(five, { character: c }), null);

  // 7 条里 2 条 social 被过滤 → 只剩 5 条 → null
  const withForbidden = JSON.stringify([
    ...Array.from({ length: 5 }, (_, index) => ({ category: 'home', text: `在家待着 ${index}` })),
    { category: 'social', text: '朋友聚会' },
    { category: 'crowd', text: '去商场' },
  ]);
  assert.equal(activity.parsePool(withForbidden, { character: c }), null);

  // needs 不满足的条目会被丢掉
  const withNeeds = JSON.stringify([
    ...Array.from({ length: 6 }, (_, index) => ({ category: 'home', text: `在家待着 ${index}` })),
    { category: 'home', text: '需要高社交', needs: { socialMin: 90 } },
  ]);
  const parsed = activity.parsePool(withNeeds, { character: c });
  assert.equal(parsed.length, 6);
  assert.ok(!parsed.some((item) => item.text === '需要高社交'));
});

// ---------------------------------------------------------------------------
// 每日抽样
// ---------------------------------------------------------------------------

test('sampleDay：3–5 条、时间升序、时段类别正确、每天 1 条 discovery', () => {
  const c = character({ profile: { social: 80, openness: 80 } });
  const pool = makePool([
    ...samplePool().items,
    makeItem('work', '去公司开会', { needs: { occupation: 'employed' } }),
    makeItem('crowd', '去市集逛了一圈', { needs: { socialMin: 60 } }),
    makeItem('social', '和朋友吃饭', { needs: { socialMin: 70, opennessMin: 60 } }),
  ]);

  const schedule = activity.sampleDay({
    pool,
    date: '2026-10-27',
    profile: c.persona.inner.profile,
    context: { character: c },
  });

  assert.ok(schedule.length >= 3 && schedule.length <= 5, `实际 ${schedule.length} 条`);
  assert.equal(schedule.filter((item) => item.category === 'discovery').length, 1);

  const periodCategories = {
    morning: ['home', 'chore', 'selfcare'],
    midday: ['work', 'create', 'solo_out', 'crowd', 'social', 'visit'],
    evening: ['home', 'create', 'discovery'],
  };
  for (let index = 0; index < schedule.length; index += 1) {
    const item = schedule[index];
    assert.match(item.time, /^([01]\d|2[0-3]):[0-5]\d$/);
    const minutes = minutesOf(item.time);
    if (minutes < 11 * 60) {
      assert.ok(periodCategories.morning.includes(item.category), `早间越界：${item.category}`);
    } else if (minutes < 18 * 60) {
      assert.ok(periodCategories.midday.includes(item.category), `午间越界：${item.category}`);
    } else {
      assert.ok(periodCategories.evening.includes(item.category), `晚间越界：${item.category}`);
    }
    if (index > 0) assert.ok(schedule[index - 1].time <= item.time, '时间应升序');
  }
});

test('sampleDay：同一天同一角色两次抽样结果一致（种子稳定）', () => {
  const c = character();
  const pool = samplePool();
  const a = activity.sampleDay({
    pool, date: '2026-10-27', profile: c.persona.inner.profile, context: { character: c },
  });
  const b = activity.sampleDay({
    pool, date: '2026-10-27', profile: c.persona.inner.profile, context: { character: c },
  });
  assert.deepEqual(a, b);
  assert.ok(a.length >= 3);
});

test('sampleDay：最早的日程不早于角色的活跃窗口（09:00 起床就不排 07:39）', () => {
  const c = character();
  c.life = { ...c.life, activeFrom: '09:00', activeTo: '23:30' };
  const pool = samplePool();
  const rows = activity.sampleDay({
    pool, date: '2026-10-27', profile: c.persona.inner.profile, context: { character: c },
  });
  assert.ok(rows.length >= 3);
  const earliest = rows
    .map((row) => Number(row.time.slice(0, 2)) * 60 + Number(row.time.slice(3, 5)))
    .reduce((min, value) => Math.min(min, value), 24 * 60);
  assert.ok(earliest >= 9 * 60, `最早一条应在 09:00 之后，实际 ${rows[0].time}`);
});

test('sampleDay：7 天内出现过的条目优先避开，有替代时不再重复', () => {
  const c = character();
  const old = '煮了一锅汤，慢慢等它咕嘟';
  const fresh = '把常看的那本书翻到折角那页';
  const pool = makePool([
    makeItem('home', old),
    makeItem('home', fresh),
    makeItem('chore', '把地拖了一遍'),
    makeItem('selfcare', '洗了头发'),
    makeItem('discovery', '发现楼下换了新的招牌'),
  ]);
  const recentDays = [
    { date: '2026-10-26', schedule: [{ time: '08:00', activity: old }] },
  ];

  // 只看「最近 7 天」窗口内的日期（10-27 ~ 11-02）
  const dates = [
    '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31',
    '2026-11-01', '2026-11-02',
  ];
  let oldCount = 0;
  let freshCount = 0;
  for (const date of dates) {
    const schedule = activity.sampleDay({
      pool,
      date,
      profile: c.persona.inner.profile,
      context: { character: c },
      recentDays,
    });
    for (const item of schedule) {
      if (item.activity === old) oldCount += 1;
      if (item.activity === fresh) freshCount += 1;
    }
  }
  assert.ok(oldCount < freshCount, `重复条目应更少：old=${oldCount}, fresh=${freshCount}`);
  assert.equal(oldCount, 0, `有替代条目时，7 天内出现过的活动不应再被抽到：${oldCount} 次`);
});

test('sampleDay：solo_out 每周最多 3 次', () => {
  const c = character({ profile: { openness: 90, social: 40 } });
  const pool = makePool([
    makeItem('home', '在家看书'),
    makeItem('chore', '把地拖了一遍'),
    makeItem('selfcare', '洗了头发'),
    makeItem('discovery', '发现楼下换了新的招牌'),
    makeItem('solo_out', '去街角书店', { solo: true, needs: { opennessMin: 45 } }),
    makeItem('solo_out', '一个人去看电影', { solo: true, needs: { opennessMin: 45 } }),
  ]);
  const recentDays = [
    { date: '2026-10-26', schedule: [{ time: '12:00', activity: '去街角书店', category: 'solo_out' }] },
    { date: '2026-10-25', schedule: [{ time: '12:00', activity: '一个人去看电影', category: 'solo_out' }] },
    { date: '2026-10-24', schedule: [{ time: '12:00', activity: '去公园的长椅', category: 'solo_out' }] },
  ];
  const schedule = activity.sampleDay({
    pool,
    date: '2026-10-27',
    profile: c.persona.inner.profile,
    context: { character: c },
    recentDays,
  });
  assert.ok(!schedule.some((item) => item.category === 'solo_out'), '本周已满 3 次，不应再排独自出门');

  // 反过来：最近 7 天一次都没出门时，当天会补一条 solo_out（每周至少 1 次）
  const fresh = activity.sampleDay({
    pool,
    date: '2026-10-27',
    profile: c.persona.inner.profile,
    context: { character: c },
  });
  assert.ok(fresh.some((item) => item.category === 'solo_out'), '一周没出门时应安排一次独自出门');
});

test('sampleDay：visit 每月最多 2 次，social 每 7 天最多 1 次', () => {
  const c = character({ profile: { social: 90, openness: 80 } });
  const pool = makePool([
    makeItem('home', '在家看书'),
    makeItem('chore', '把地拖了一遍'),
    makeItem('selfcare', '洗了头发'),
    makeItem('discovery', '发现楼下换了新的招牌'),
    makeItem('visit', '去朋友家坐了半下午', { needs: { socialMin: 55 } }),
    makeItem('social', '和朋友吃了顿火锅', { needs: { socialMin: 70, opennessMin: 60 } }),
  ]);

  const withVisit = activity.sampleDay({
    pool,
    date: '2026-10-27',
    profile: c.persona.inner.profile,
    context: { character: c },
    recentDays: [
      { date: '2026-10-10', schedule: [{ time: '13:00', activity: '去朋友家坐了半下午' }] },
      { date: '2026-10-01', schedule: [{ time: '13:00', activity: '去朋友家坐了半下午' }] },
    ],
  });
  assert.ok(!withVisit.some((item) => item.category === 'visit'), '本月 2 次已用完');

  const withSocial = activity.sampleDay({
    pool,
    date: '2026-10-27',
    profile: c.persona.inner.profile,
    context: { character: c },
    recentDays: [
      { date: '2026-10-24', schedule: [{ time: '18:00', activity: '和朋友吃了顿火锅' }] },
    ],
  });
  assert.ok(!withSocial.some((item) => item.category === 'social'), '7 天内已经聚过一次');
});

test('sampleDay：低精力不排外出，低专注不排创作', () => {
  const c = character({ profile: { social: 80, openness: 80 } });
  const pool = makePool([
    makeItem('home', '在家看书'),
    makeItem('chore', '把地拖了一遍'),
    makeItem('selfcare', '洗了头发'),
    makeItem('discovery', '发现楼下换了新的招牌'),
    makeItem('solo_out', '去街角书店', { solo: true, needs: { opennessMin: 45 } }),
    makeItem('create', '改了两页稿子'),
    makeItem('social', '和朋友吃饭', { needs: { socialMin: 70, opennessMin: 60 } }),
  ]);

  const tired = activity.sampleDay({
    pool,
    date: '2026-10-27',
    profile: c.persona.inner.profile,
    state: { energy: 20, focus: 80 },
    context: { character: c },
  });
  assert.ok(!tired.some((item) => ['solo_out', 'social'].includes(item.category)));

  const scattered = activity.sampleDay({
    pool,
    date: '2026-10-27',
    profile: c.persona.inner.profile,
    state: { energy: 80, focus: 30 },
    context: { character: c },
  });
  assert.ok(!scattered.some((item) => item.category === 'create'));
});

test('sampleDay：时间抖动有限，不会占掉生日的 19:30', () => {
  const c = character({ profile: { social: 80, openness: 80 } });
  const pool = makePool([
    ...samplePool().items,
    makeItem('work', '去公司开会', { needs: { occupation: 'employed' } }),
    makeItem('visit', '去朋友家', { needs: { socialMin: 55 } }),
    makeItem('crowd', '去市集', { needs: { socialMin: 60 } }),
  ]);

  for (let day = 1; day <= 28; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({
      pool,
      date,
      profile: c.persona.inner.profile,
      context: { character: c },
    });
    assert.ok(!schedule.some((item) => item.time === '19:30'), `${date} 不应占用 19:30`);
    for (const item of schedule) {
      const minutes = minutesOf(item.time);
      assert.ok(minutes >= 6 * 60 && minutes <= 23 * 60, `${item.time} 越界`);
    }
  }
});

test('sampleDay：模型池漏掉 discovery 时，用本地素材补每天 1 条', () => {
  const c = character();
  const pool = makePool([
    makeItem('home', '煮了一锅汤'),
    makeItem('home', '把常看的那本书翻到折角那页'),
    makeItem('chore', '把地拖了一遍'),
    makeItem('selfcare', '洗了头发'),
  ]);
  const schedule = activity.sampleDay({
    pool, date: '2026-10-27', profile: c.persona.inner.profile, context: { character: c },
  });
  assert.equal(schedule.filter((item) => item.category === 'discovery').length, 1);
});

// ---------------------------------------------------------------------------
// P7：规律 / 节奏 / 表达三维落地
// ---------------------------------------------------------------------------

// spec 2 五维里「规律」的四个固定锚点：早 / 午 / 下午 / 晚
const ANCHOR_MINUTES = [8 * 60, 12 * 60 + 30, 15 * 60 + 30, 19 * 60 + 30];

function distanceToAnchor(time) {
  const minutes = minutesOf(time);
  return Math.min(...ANCHOR_MINUTES.map((anchor) => Math.abs(minutes - anchor)));
}

/** 富池：早/午/晚/发现/自理都有多条，避免条数测试被池子大小限制 */
function richPool() {
  return makePool([
    makeItem('home', '煮了一锅汤，慢慢等它咕嘟'),
    makeItem('home', '把常看的那本书翻到折角那页'),
    makeItem('home', '窝在沙发上听了一会儿歌'),
    makeItem('chore', '把地拖了一遍，水桶换了两次'),
    makeItem('chore', '整理了衣柜，翻出去年的围巾'),
    makeItem('selfcare', '洗了头发，吹到半干'),
    makeItem('selfcare', '做了十分钟拉伸，肩颈松了点'),
    makeItem('selfcare', '认真涂了护手霜'),
    makeItem('discovery', '在抽屉最里面翻到一张旧车票'),
    makeItem('discovery', '听到一首没听过的歌'),
    makeItem('discovery', '在便利店买到最后一瓶喜欢的饮料'),
    makeItem('solo_out', '去街角书店翻半小时画册', { solo: true, indoor: false, needs: { opennessMin: 45 } }),
    makeItem('solo_out', '一个人去看了场下午场电影', { solo: true, indoor: false, needs: { opennessMin: 45 } }),
    makeItem('create', '改了两页稿子，越改越顺'),
    makeItem('create', '起了个草稿，只画了轮廓'),
    makeItem('create', '写了一段，又删掉一半'),
  ]);
}

test('sampleDay：规律 ≥70 时间贴固定锚点（±10 分钟），且可复现', () => {
  const steady = character({ profile: { structure: 90, pace: 50, openness: 70 } });
  const pool = richPool();
  const spread = [];

  for (let day = 1; day <= 28; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const args = {
      pool, date, profile: steady.persona.inner.profile, context: { character: steady },
    };
    const schedule = activity.sampleDay(args);
    assert.ok(schedule.length >= 3, `${date} 至少 3 条`);
    for (const item of schedule) {
      const gap = distanceToAnchor(item.time);
      assert.ok(gap <= 10, `${date} ${item.time} 距锚点 ${gap} 分钟`);
      assert.notEqual(item.time, '19:30', '不应占用生日 19:30');
      const minutes = minutesOf(item.time);
      assert.ok(minutes >= 6 * 60 && minutes <= 23 * 60 + 59, `${item.time} 越界`);
    }
    for (let index = 1; index < schedule.length; index += 1) {
      assert.ok(schedule[index - 1].time <= schedule[index].time, '时间应升序');
    }
    spread.push(schedule);
  }

  // 同一天同一角色结果仍然可复现
  const again = activity.sampleDay({
    pool, date: '2026-11-05', profile: steady.persona.inner.profile, context: { character: steady },
  });
  assert.deepEqual(again, spread[4]);
});

test('sampleDay：规律 ≤30 抖动放大到 ±45 分钟（至少一条远离锚点）', () => {
  const loose = character({ profile: { structure: 10, pace: 50, openness: 70 } });
  const pool = richPool();

  let farDays = 0;
  for (let day = 1; day <= 28; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({
      pool, date, profile: loose.persona.inner.profile, context: { character: loose },
    });
    assert.ok(schedule.length >= 3);
    const maxGap = Math.max(...schedule.map((item) => distanceToAnchor(item.time)));
    if (maxGap > 25) farDays += 1;
    // 抖动幅度受 ±45 分钟约束：不会跑到别的时段去
    for (const item of schedule) {
      const minutes = minutesOf(item.time);
      assert.ok(minutes >= 6 * 60 && minutes <= 23 * 60 + 59, `${item.time} 越界`);
    }
  }
  assert.equal(farDays, 28, '低规律每天都应有一条时间明显偏离锚点');
});

test('sampleDay：节奏 ≥70 排满 5 条（可多 1 条顺路），节奏 ≤30 固定 3 条', () => {
  const fast = character({ profile: { pace: 90, openness: 70 } });
  const slow = character({ profile: { pace: 10, openness: 70 } });
  const pool = richPool();
  const allowed = new Set(activity.allowedCategories({ character: fast }));
  let sawSix = false;

  for (let day = 1; day <= 14; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({
      pool, date, profile: fast.persona.inner.profile, context: { character: fast },
    });
    assert.ok(schedule.length >= activity.DAY_TARGET_HIGH, `${date} 高节奏应排满 5 条：${schedule.length}`);
    assert.ok(schedule.length <= activity.DAY_TARGET_HIGH + 1, `${date} 最多再多 1 条顺路：${schedule.length}`);
    if (schedule.length === activity.DAY_TARGET_HIGH + 1) sawSix = true;
    assert.ok(schedule.every((item) => allowed.has(item.category)));
    assert.ok(schedule.every((item) => !Number.isNaN(minutesOf(item.time))));
    // 硬配额不因为凑条数被突破：出门 / 聚会每天最多一条，发现类基础一条
    assert.ok(schedule.filter((item) => item.category === 'solo_out').length <= 1);
    assert.ok(schedule.filter((item) => item.category === 'social').length <= 1);
    assert.ok(schedule.filter((item) => item.category === 'discovery').length >= 1);
    // 顺路条目只能是 discovery / selfcare：第 6 条让这两类至少占到 2 条
    if (schedule.length === activity.DAY_TARGET_HIGH + 1) {
      const counts = {};
      for (const item of schedule) counts[item.category] = (counts[item.category] || 0) + 1;
      assert.ok(
        (counts.discovery || 0) + (counts.selfcare || 0) >= 2,
        '多出来的一条应从 discovery / selfcare 里挑',
      );
    }

    const slowSchedule = activity.sampleDay({
      pool, date, profile: slow.persona.inner.profile, context: { character: slow },
    });
    assert.equal(slowSchedule.length, activity.DAY_TARGET_LOW, `${date} 低节奏固定 3 条`);
    assert.equal(
      slowSchedule.filter((item) => item.category === 'discovery').length,
      1,
      '低节奏也要保留每天 1 条 discovery',
    );
  }
  assert.ok(sawSix, '高节奏应至少出现一次「顺路」的第 6 条');
});

test('sampleDay：表达维度不影响活动准入，社交硬门槛优先', () => {
  const pool = makePool([
    makeItem('home', '在家看书'),
    makeItem('chore', '把地拖了一遍'),
    makeItem('selfcare', '洗了头发'),
    makeItem('discovery', '发现楼下换了新的招牌'),
    makeItem('create', '改了两页稿子'),
    makeItem('social', '和几个朋友吃了顿火锅', { needs: { socialMin: 70, opennessMin: 60 } }),
    makeItem('crowd', '去市集逛了一圈', { needs: { socialMin: 60 } }),
    makeItem('visit', '去看了住在附近的朋友', { needs: { socialMin: 55 } }),
  ]);

  // 低表达 + 高社交，但开放只有 50：聚会的硬门槛不满足，照样不出现
  const closed = character({ profile: { social: 80, openness: 50, expressiveness: 20, pace: 90 } });
  // 低社交 + 高表达：也不会因为表达高就拉进聚会 / 人群
  const shy = character({ profile: { social: 40, openness: 80, expressiveness: 90, pace: 90 } });

  for (let day = 1; day <= 14; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;

    // 低表达 + 高社交 + 开放 50：聚会门槛不满足，即使表达再低也不会「凑」出聚会
    const closedSchedule = activity.sampleDay({
      pool, date, profile: closed.persona.inner.profile, context: { character: closed },
    });
    const closedAllowed = new Set(activity.allowedCategories({ character: closed }));
    for (const item of closedSchedule) {
      assert.ok(closedAllowed.has(item.category), `${item.category} 越过了硬约束`);
    }
    assert.ok(!closedSchedule.some((item) => item.category === 'social'), '开放不足时不该有聚会');

    // 低社交 + 高表达：表达高也换不来聚会 / 人群 / 串门
    const shySchedule = activity.sampleDay({
      pool, date, profile: shy.persona.inner.profile, context: { character: shy },
    });
    const shyAllowed = new Set(activity.allowedCategories({ character: shy }));
    for (const item of shySchedule) {
      assert.ok(shyAllowed.has(item.category), `${item.category} 越过了硬约束`);
      assert.ok(!['social', 'crowd', 'visit'].includes(item.category), `${item.category} 不该出现`);
    }
  }
});

test('sampleDay：池子为空 / 全部被过滤时返回空数组', () => {
  const c = character({ profile: { social: 10, openness: 10 } });
  assert.deepEqual(activity.sampleDay({ pool: makePool([]), date: '2026-10-27', context: { character: c } }), []);
  assert.deepEqual(
    activity.sampleDay({
      pool: makePool([makeItem('social', '聚会')]),
      date: '2026-10-27',
      context: { character: c },
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// P4：天气 / 节日 / 节气 权重
// ---------------------------------------------------------------------------

const CLEAR = { code: 'clear', isClear: true, isRain: false, source: 'seasonal' };
const RAIN = { code: 'rain', isClear: false, isRain: true, source: 'seasonal' };

function weatherPool() {
  return makePool([
    makeItem('home', '在窗边坐了一会儿'),
    makeItem('home', '把常看的那本书翻到折角那页'),
    makeItem('chore', '把地拖了一遍'),
    makeItem('selfcare', '洗了头发'),
    makeItem('discovery', '发现楼下换了新的招牌', { indoor: false }),
    makeItem('solo_out', '去街角书店翻画册', { solo: true, needs: { opennessMin: 45 } }),
    makeItem('solo_out', '一个人去看场电影', { solo: true, needs: { opennessMin: 45 } }),
    makeItem('create', '改了两页稿子'),
    makeItem('create', '起了个草稿，只画了轮廓'),
  ]);
}

function countCategory(schedule, category) {
  return schedule.filter((item) => item.category === category).length;
}

test('sampleDay：同角色同日期集合，晴天比雨天更常安排独自出门', () => {
  const c = character({ profile: { social: 45, openness: 80 } });
  const pool = weatherPool();
  const dates = [];
  for (let day = 1; day <= 28; day += 1) {
    dates.push(`2026-11-${String(day).padStart(2, '0')}`);
  }

  const shiftDays = (key, offset) => {
    const [year, month, day] = key.split('-').map(Number);
    const value = new Date(year, month - 1, day - offset);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  };

  let clearCount = 0;
  let rainCount = 0;
  for (const date of dates) {
    // 每周已经有 1 次 solo_out：避免「一周没出门」的强制补位，让天气权重真正参与比较
    const recentDays = [
      { date: shiftDays(date, 2), schedule: [{ time: '12:00', activity: '去街角书店翻画册', category: 'solo_out' }] },
    ];
    const clear = activity.sampleDay({
      pool, date, profile: c.persona.inner.profile, context: { character: c, weather: CLEAR }, recentDays,
    });
    const rain = activity.sampleDay({
      pool, date, profile: c.persona.inner.profile, context: { character: c, weather: RAIN }, recentDays,
    });
    clearCount += countCategory(clear, 'solo_out');
    rainCount += countCategory(rain, 'solo_out');
    // 雨天不会因此排出非法类别
    assert.ok(rain.every((item) => activity.allowedCategories({ character: c }).includes(item.category)));
  }
  assert.ok(clearCount > rainCount, `晴天应更常出门：clear=${clearCount}, rain=${rainCount}`);
});

test('sampleDay：节日插入专属条目，不占 discovery 名额', () => {
  const c = character({ profile: { social: 60, openness: 70 } });
  const schedule = activity.sampleDay({
    pool: weatherPool(),
    date: '2026-09-25',
    profile: c.persona.inner.profile,
    context: { character: c, holiday: { name: '中秋', kind: 'lunar' }, season: '秋' },
  });

  const festival = schedule.find((item) => item.festival === '中秋');
  assert.ok(festival, '应插入一条中秋活动');
  assert.match(festival.activity, /月饼/);
  assert.ok(['12:00', '19:00'].includes(festival.time), `节日时间固定：${festival.time}`);
  assert.equal(schedule.filter((item) => item.category === 'discovery').length, 1);
  assert.ok(schedule.length <= activity.DAY_MAX_ITEMS + 1, `节日最多多 1 条：${schedule.length}`);
  assert.ok(activity.allowedCategories({ character: c }).includes(festival.category));
});

test('sampleDay：低社交角色的节日也不会出现聚会 / 人群', () => {
  const c = character({ profile: { social: 10, openness: 10 } });
  const pool = makePool([
    makeItem('home', '在家看书'),
    makeItem('home', '煮了碗面'),
    makeItem('chore', '把地拖了一遍'),
    makeItem('selfcare', '洗了头发'),
    makeItem('discovery', '发现楼下换了新的招牌'),
    makeItem('social', '和一群朋友聚餐', { needs: { socialMin: 70, opennessMin: 60 } }),
    makeItem('crowd', '去市集逛了一圈', { needs: { socialMin: 60 } }),
  ]);
  const schedule = activity.sampleDay({
    pool,
    date: '2026-02-17',
    profile: c.persona.inner.profile,
    context: { character: c, holiday: { name: '春节', kind: 'lunar' } },
  });
  const allowed = new Set(activity.allowedCategories({ character: c }));
  for (const item of schedule) {
    assert.ok(allowed.has(item.category), `${item.category} 不应出现`);
    assert.ok(!['social', 'crowd', 'visit'].includes(item.category));
  }
  assert.ok(schedule.some((item) => item.festival === '春节'));
});

test('sampleDay：节气只改措辞，不改变类别与时间', () => {
  const c = character();
  const pool = weatherPool();
  const plain = activity.sampleDay({
    pool, date: '2026-11-07', profile: c.persona.inner.profile, context: { character: c },
  });
  const withTerm = activity.sampleDay({
    pool,
    date: '2026-11-07',
    profile: c.persona.inner.profile,
    context: { character: c, term: '立冬', season: '冬' },
  });

  assert.deepEqual(
    plain.map((item) => ({ time: item.time, category: item.category })),
    withTerm.map((item) => ({ time: item.time, category: item.category })),
  );
  const prefixed = withTerm.filter((item) => item.activity.startsWith('立冬，'));
  assert.equal(prefixed.length, 1, '应有一条活动带节气前缀');
  assert.ok(['home', 'chore', 'selfcare'].includes(prefixed[0].category));
});

// ---------------------------------------------------------------------------
// 池子状态
// ---------------------------------------------------------------------------

test('poolFresh：缺失 / 空 / 过期都要重生成', () => {
  const pool = makePool([makeItem('home', '在家看书')]);
  assert.equal(activity.poolFresh(null), true);
  assert.equal(activity.poolFresh({ generatedAt: null, items: [] }), true);
  assert.equal(activity.poolFresh({ generatedAt: '2026-10-27T08:00:00+08:00', items: [] }), true);

  assert.equal(activity.poolFresh(pool, new Date(2026, 9, 28, 8, 0, 0), 7), false);
  assert.equal(activity.poolFresh(pool, new Date(2026, 10, 3, 9, 0, 0), 7), true);
});

test('poolStats：返回 total / allowed / dropped', () => {
  const c = character({ profile: { social: 40, openness: 40 } });
  const pool = makePool([
    makeItem('home', '在家看书'),
    makeItem('social', '朋友聚会'),
    makeItem('crowd', '去商场'),
    makeItem('work', '去公司开会'),
  ]);
  assert.deepEqual(activity.poolStats(pool, { character: c }), {
    total: 4,
    allowed: 1,
    dropped: 3,
  });
});

test('parsePool：被 max_tokens 截断的 JSON 也能抢救出完整条目', () => {
  const items = [];
  for (let i = 1; i <= 8; i += 1) {
    items.push({ category: i % 2 ? 'home' : 'chore', text: `第${i}件事，慢慢做完`, solo: true, indoor: true, energyCost: 5 });
  }
  const truncated = JSON.stringify(items).slice(0, -40); // 故意截断，数组不闭合
  const parsed = activity.parsePool(truncated, {
    character: character(),
    profile: { social: 65, structure: 25, openness: 85, pace: 75, expressiveness: 80 },
  });
  assert.ok(parsed, '截断时不应直接返回 null');
  assert.ok(parsed.length >= 6, '应抢救出至少 6 条');
});

// ---------------------------------------------------------------------------
// P8：地点连续性（晚间室内、居家后不立刻外出）
// ---------------------------------------------------------------------------

/** 从池子里建「文本 → 是否室内」索引；本地兜底素材一律算室内 */
function indoorLookup(pool) {
  const map = new Map();
  for (const item of pool.items) map.set(item.text, item.indoor === true);
  return (text) => (map.has(text) ? map.get(text) : true);
}

/** 按规则 1/2 校验一份日程：晚间必须室内；居家后外出要够间隔且不过 20:00 */
function assertLocationContinuity(schedule, indoorOf) {
  for (let index = 0; index < schedule.length; index += 1) {
    const item = schedule[index];
    const indoor = indoorOf(item.activity);
    const minutes = minutesOf(item.time);
    if (minutes >= activity.EVENING_INDOOR_FROM) {
      assert.equal(indoor, true, `${item.time} ${item.activity} 是晚间条目，应为室内`);
    }
    if (index === 0) continue;
    const previous = schedule[index - 1];
    const previousIndoor = indoorOf(previous.activity);
    const previousStaysHome = previousIndoor
      && ['home', 'chore', 'selfcare'].includes(previous.category);
    if (!previousStaysHome || indoor) continue;
    const gap = minutes - minutesOf(previous.time);
    assert.ok(
      gap >= activity.LEAVE_HOME_MIN_GAP && minutes < activity.EVENING_INDOOR_FROM,
      `${previous.time} 居家之后 ${item.time} 外出（间隔 ${gap} 分钟）`,
    );
  }
}

test('pruneScheduleByLocation：20:00 后户外条目被剔除（18:06 在家 → 21:04 户外不出现）', () => {
  const rows = [
    { time: '18:06', category: 'home', indoor: true },
    { time: '20:59', category: 'discovery', indoor: false },
    { time: '21:04', category: 'discovery', indoor: false },
    { time: '21:30', category: 'discovery', indoor: true },
    { time: '21:55', category: 'solo_out', indoor: false },
  ];
  const kept = activity.pruneScheduleByLocation(rows);
  assert.deepEqual(kept.map((row) => row.time), ['18:06', '21:30']);
});

test('pruneScheduleByLocation：居家后立刻外出被剔除，间隔 ≥120 且 <20:00 才保留', () => {
  const tight = activity.pruneScheduleByLocation([
    { time: '17:00', category: 'home', indoor: true },
    { time: '17:30', category: 'solo_out', indoor: false },
  ]);
  assert.deepEqual(tight.map((row) => row.time), ['17:00'], '17:00 在家后 17:30 外出应剔除');

  const boundaryNo = activity.pruneScheduleByLocation([
    { time: '17:00', category: 'chore', indoor: true },
    { time: '18:59', category: 'solo_out', indoor: false },
  ]);
  assert.deepEqual(boundaryNo.map((row) => row.time), ['17:00'], '119 分钟不够 120');

  const boundaryYes = activity.pruneScheduleByLocation([
    { time: '17:00', category: 'selfcare', indoor: true },
    { time: '19:00', category: 'solo_out', indoor: false },
  ]);
  assert.deepEqual(boundaryYes.map((row) => row.time), ['17:00', '19:00'], '刚好 120 分钟应保留');

  const lateAfternoon = activity.pruneScheduleByLocation([
    { time: '17:00', category: 'home', indoor: true },
    { time: '19:30', category: 'solo_out', indoor: false },
  ]);
  assert.deepEqual(lateAfternoon.map((row) => row.time), ['17:00', '19:30'], '19:30 早于 20:00 应保留');
});

test('pruneScheduleByLocation：户外 → 室内永远允许（回家不断档）', () => {
  const kept = activity.pruneScheduleByLocation([
    { time: '10:00', category: 'solo_out', indoor: false },
    { time: '10:30', category: 'home', indoor: true },
    { time: '11:00', category: 'selfcare', indoor: true },
    { time: '11:20', category: 'solo_out', indoor: false },
  ]);
  assert.deepEqual(kept.map((row) => row.time), ['10:00', '10:30', '11:00']);
});

test('sampleDay：18:00 的室内居家之后，21:00 的户外 discovery 不再出现', () => {
  const c = character({ profile: { social: 40, openness: 70 } });
  const outdoorText = '路过时看到一只猫在窗台上打盹';
  const pool = makePool([
    makeItem('home', '把书架上的书按颜色重排了一遍'),
    makeItem('home', '煮了一碗面，加了一个蛋'),
    makeItem('chore', '把地拖了一遍，水桶换了两次'),
    makeItem('selfcare', '洗了头发，吹到半干'),
    makeItem('discovery', outdoorText, { indoor: false }),
  ]);

  for (let day = 1; day <= 14; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({
      pool, date, profile: c.persona.inner.profile, context: { character: c },
    });
    assert.ok(!schedule.some((item) => item.activity === outdoorText), `${date} 不应出现户外发现`);
    assertLocationContinuity(schedule, indoorLookup(pool));
    for (let index = 1; index < schedule.length; index += 1) {
      assert.ok(schedule[index - 1].time <= schedule[index].time, '时间应升序');
    }
  }
});

test('sampleDay：池子全是户外时，晚间不排户外，条数可少但仍有 3 条室内', () => {
  const c = character({ profile: { social: 40, openness: 70 } });
  const pool = makePool([
    makeItem('discovery', '在便利店买到最后一瓶喜欢的饮料', { indoor: false }),
    makeItem('solo_out', '沿着河边走了很久，没戴耳机', {
      solo: true, indoor: false, needs: { opennessMin: 45 },
    }),
  ]);

  for (let day = 1; day <= 14; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({
      pool, date, profile: c.persona.inner.profile, context: { character: c },
    });
    assert.ok(schedule.length >= activity.DAY_MIN_ITEMS, `${date} 至少 3 条：${schedule.length}`);
    assert.ok(schedule.length < activity.DAY_TARGET_MID, `${date} 应少于目标条数：${schedule.length}`);
    const indoorOf = indoorLookup(pool);
    assertLocationContinuity(schedule, indoorOf);
    const eveningRows = schedule.filter((item) => minutesOf(item.time) >= activity.EVENING_INDOOR_FROM);
    assert.ok(eveningRows.length > 0, `${date} 不足 3 条时应补晚间室内条目`);
    for (const row of eveningRows) {
      assert.equal(indoorOf(row.activity), true, `${row.time} ${row.activity} 晚间应为室内`);
    }
    // 池子里没有任何 home / selfcare：出现的只能是补进来的室内居家条
    assert.ok(
      schedule.some((item) => ['home', 'selfcare'].includes(item.category)),
      `${date} 应补室内 home / selfcare 凑够 3 条`,
    );
  }
});

test('sampleDay：20:00 后任何 outdoor 都不出现（28 天，含户外发现 / 独自出门）', () => {
  const c = character({ profile: { social: 60, openness: 80, pace: 90 } });
  const pool = makePool([
    makeItem('home', '在窗边坐了一会儿，什么都没做'),
    makeItem('home', '把常看的那本书翻到折角那页'),
    makeItem('chore', '把地拖了一遍，水桶换了两次'),
    makeItem('selfcare', '认真涂了护手霜，手背不再起皮'),
    makeItem('create', '改了两页稿子，越改越顺'),
    makeItem('discovery', '发现楼下换了新的招牌', { indoor: false }),
    makeItem('discovery', '听到一首没听过的歌，单曲循环了很久'),
    makeItem('solo_out', '去街角书店翻半小时画册', {
      solo: true, indoor: false, needs: { opennessMin: 45 },
    }),
    makeItem('crowd', '去市集逛了一圈，人多但挺热闹', { indoor: false, needs: { socialMin: 60 } }),
  ]);
  const indoorOf = indoorLookup(pool);

  for (let day = 1; day <= 28; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({
      pool, date, profile: c.persona.inner.profile, context: { character: c },
    });
    assertLocationContinuity(schedule, indoorOf);
    for (const item of schedule) {
      if (minutesOf(item.time) >= activity.EVENING_INDOOR_FROM) {
        assert.equal(indoorOf(item.activity), true, `${date} ${item.time} ${item.activity}`);
      }
    }
  }
});

test('bonusCandidatesForContinuity：前一条室内 → 顺路只能室内；20:00 后也只留室内', () => {
  const candidates = [
    makeItem('discovery', '在抽屉最里面翻到一张旧车票', { indoor: true }),
    makeItem('discovery', '路边看猫', { indoor: false }),
    makeItem('selfcare', '在楼下长椅上坐了会儿', { indoor: false }),
    makeItem('selfcare', '剪了指甲，顺手修了修', { indoor: true }),
  ];

  const afterHome = activity.bonusCandidatesForContinuity(candidates, {
    previousIndoor: true, minutes: 17 * 60,
  });
  assert.deepEqual(afterHome.map((item) => item.indoor), [true, true]);

  const afterOutdoor = activity.bonusCandidatesForContinuity(candidates, {
    previousIndoor: false, minutes: 15 * 60,
  });
  assert.equal(afterOutdoor.length, candidates.length, '前一条在户外时可以继续在户外');

  const evening = activity.bonusCandidatesForContinuity(candidates, {
    previousIndoor: false, minutes: 21 * 60 + 15,
  });
  assert.deepEqual(evening.map((item) => item.indoor), [true, true]);
});

test('sampleDay：高 pace 的顺路条目沿用前一条地点属性（前一条室内 → 顺路室内）', () => {
  const fast = character({ profile: { pace: 90, openness: 70 } });
  const pool = richPool();
  pool.items.push(makeItem('selfcare', '在楼下长椅上坐了会儿', { indoor: false }));
  pool.items.push(makeItem('discovery', '路边看猫，它先走了', { indoor: false }));
  const indoorOf = indoorLookup(pool);
  let sawSix = false;

  for (let day = 1; day <= 14; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({
      pool, date, profile: fast.persona.inner.profile, context: { character: fast },
    });
    assertLocationContinuity(schedule, indoorOf);
    if (schedule.length === activity.DAY_TARGET_HIGH + 1) {
      sawSix = true;
      const last = schedule[schedule.length - 1];
      const previous = schedule[schedule.length - 2];
      assert.ok(['discovery', 'selfcare'].includes(last.category), `顺路条目类别：${last.category}`);
      assert.equal(indoorOf(last.activity), true, '前一条室内时顺路条目必须室内');
      if (indoorOf(previous.activity)) {
        assert.equal(indoorOf(last.activity), true);
      }
    }
  }
  assert.ok(sawSix, '高节奏应至少出现一次「顺路」的第 6 条');
});

test('sampleDay：低社交角色叠加地点规则后，户外发现也不会带来聚会 / 人群', () => {
  const shy = character({ profile: { social: 30, openness: 70, pace: 90 } });
  const pool = makePool([
    makeItem('home', '在窗边坐了一会儿，什么都没做'),
    makeItem('chore', '把地拖了一遍，水桶换了两次'),
    makeItem('selfcare', '洗了头发，吹到半干'),
    makeItem('discovery', '试了一家新开的小店，味道一般', { indoor: false }),
    makeItem('solo_out', '去公园的长椅上坐了会儿', {
      solo: true, indoor: false, needs: { opennessMin: 45 },
    }),
    makeItem('social', '和几个朋友吃了顿火锅', { needs: { socialMin: 70, opennessMin: 60 } }),
    makeItem('crowd', '去夜市吃了两样小吃', { indoor: false, needs: { socialMin: 60 } }),
    makeItem('visit', '去看了住在附近的朋友', { needs: { socialMin: 55 } }),
  ]);
  const indoorOf = indoorLookup(pool);
  const allowed = new Set(activity.allowedCategories({ character: shy }));

  for (let day = 1; day <= 14; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({
      pool, date, profile: shy.persona.inner.profile, context: { character: shy },
    });
    for (const item of schedule) {
      assert.ok(allowed.has(item.category), `${item.category} 越过了硬约束`);
      assert.ok(!['social', 'crowd', 'visit'].includes(item.category), `${item.category} 不该出现`);
    }
    assertLocationContinuity(schedule, indoorOf);
  }
});

test('sampleDay：晚间 discovery 优先室内变体（池里两种都有时）', () => {
  const c = character({ profile: { social: 40, openness: 70, pace: 50 } });
  const indoorText = '听到一首没听过的歌，单曲循环了很久';
  const outdoorText = '楼下有人搬家，纸箱堆了一地';
  const pool = makePool([
    makeItem('home', '窝在沙发上听了一会儿歌'),
    makeItem('home', '把常看的那本书翻到折角那页'),
    makeItem('chore', '整理了衣柜，翻出去年的围巾'),
    makeItem('selfcare', '洗了个澡，换上干净的衣服'),
    makeItem('discovery', indoorText),
    makeItem('discovery', outdoorText, { indoor: false }),
  ]);

  for (let day = 1; day <= 14; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({
      pool, date, profile: c.persona.inner.profile, context: { character: c },
    });
    assert.ok(schedule.some((item) => item.activity === indoorText), `${date} 应选室内发现`);
    assert.ok(!schedule.some((item) => item.activity === outdoorText), `${date} 不该选户外发现`);
  }
});

test('「去小店」即使标成 indoor:true，晚上也不该出现在居家之后', () => {
  const rows = [
    { time: '18:06', category: 'home', text: '重新摆一遍书架，把书摞在床头' },
    { time: '21:04', category: 'discovery', text: '走进一家没去过的小店，慢慢转一圈' },
  ];
  const kept = activity.pruneScheduleByLocation(rows);
  assert.deepEqual(kept.map((r) => r.time), ['18:06']);

  // 下午、且间隔足够，则允许出门
  const afternoon = [
    { time: '14:00', category: 'home', text: '在家擦桌子' },
    { time: '16:30', category: 'discovery', text: '走进一家没去过的小店，慢慢转一圈' },
  ];
  assert.equal(activity.pruneScheduleByLocation(afternoon).length, 2);
});

test('睡前动作（关灯/梳头/洗漱）必须是当天最后一条', () => {
  const rows = [
    { time: '18:06', category: 'home', activity: '重新摆一遍书架' },
    { time: '21:24', category: 'selfcare', activity: '睡前拿木梳慢慢梳头，梳到不着急了才去关灯' },
    { time: '21:37', category: 'discovery', activity: '旧书里翻出一张夹着的车票' },
  ];
  const fixed = activity.enforceWindDownLast(rows);
  assert.equal(fixed[fixed.length - 1].activity.includes('关灯'), true);
  assert.deepEqual(fixed.map((r) => r.time), ['18:06', '21:24', '21:37']);

  const already = [
    { time: '21:00', category: 'discovery', activity: '翻到旧照片' },
    { time: '22:10', category: 'selfcare', activity: '刷牙，关灯躺下' },
  ];
  assert.equal(activity.enforceWindDownLast(already)[1].activity.includes('关灯'), true);
});

test('文案里的时段词要和实际时间相符', () => {
  assert.equal(activity.textTimeFits('半夜想到一个构图，爬起来画三笔', 12 * 60 + 4), false);
  assert.equal(activity.textTimeFits('半夜想到一个构图，爬起来画三笔', 23 * 60), true);
  assert.equal(activity.textTimeFits('傍晚绕着小马路走一圈', 14 * 60 + 43), false);
  assert.equal(activity.textTimeFits('傍晚绕着小马路走一圈', 19 * 60), true);
  assert.equal(activity.textTimeFits('阴天不想出门，把毯子拉到腿上', 18 * 60), true);
  // 睡前类只能在晚上：不能因为句子里有「早上」就被排到早间
  const bedtime = '睡前把明天要穿的衣服搭在椅背上，省得早上翻柜子找半天';
  assert.equal(activity.textTimeFits(bedtime, 7 * 60 + 39), false);
  assert.equal(activity.textTimeFits(bedtime, 22 * 60 + 10), true);
  // 打盹只能中午到下午，不能排到傍晚/晚上
  assert.equal(activity.textTimeFits('床上眯一会儿', 18 * 60 + 31), false);
  assert.equal(activity.textTimeFits('床上眯一会儿', 13 * 60), true);
  // 泡脚只能在晚上
  assert.equal(activity.textTimeFits('泡脚', 15 * 60), false);
  assert.equal(activity.textTimeFits('泡脚', 20 * 60), true);
});

test('sampleDay：本地兜底也不会漏进「沙发」「听歌」这类明确不要的内容', () => {
  const c = character();
  c.life.avoidTopics = ['沙发', '听歌'];
  c.life.forbiddenActivities = ['沙发', '听歌'];
  const pool = makePool([
    makeItem('selfcare', '泡脚'),
    makeItem('selfcare', '剪指甲'),
    makeItem('chore', '拖地'),
    makeItem('chore', '擦灶台'),
    makeItem('solo_out', '小区里走两圈'),
  ]);
  const rows = activity.sampleDay({
    pool, date: '2026-10-27', profile: c.persona.inner.profile, context: { character: c },
  });
  assert.ok(rows.length >= 3);
  assert.ok(!rows.some((row) => /沙发|听歌/.test(row.activity)));
});

test('当天出过门之后，不能再说「不想出门」；天气也要一致', () => {
  const rows = [
    { time: '12:04', category: 'solo_out', activity: '去街角便利店买酸奶' },
    { time: '18:55', category: 'home', activity: '阴天不想出门，把毯子拉到腿上' },
  ];
  const kept = activity.pruneContradictions(rows, {});
  assert.deepEqual(kept.map((r) => r.time), ['12:04']);

  // 没出过门时，「不想出门」是合法的
  const stayHome = [
    { time: '10:00', category: 'home', activity: '不想出门，在家里慢慢收拾' },
    { time: '15:00', category: 'create', activity: '改了两页稿子' },
  ];
  assert.equal(activity.pruneContradictions(stayHome, {}).length, 2);

  // 晴天却写「阴天/下雨」 → 去掉
  const sunny = [
    { time: '10:00', category: 'home', activity: '下雨天，把窗关好' },
    { time: '15:00', category: 'home', activity: '把毯子拉到腿上' },
  ];
  const clearKept = activity.pruneContradictions(sunny, { weather: { isClear: true } });
  assert.equal(clearKept.length, 1);
  assert.equal(clearKept[0].time, '15:00');
});

test('抽样：相邻两条不出现同类别（discovery 例外），且一天最多 2 条 discovery', () => {
  const c = character({ profile: { social: 60, openness: 85, structure: 50, pace: 85, expressiveness: 60 } });
  const profile = { social: 60, openness: 85, structure: 50, pace: 85, expressiveness: 60 };
  const pool = activity.buildFallbackPool({ character: c, profile });

  for (let day = 1; day <= 30; day += 1) {
    const date = `2026-12-${String(day).padStart(2, '0')}`;
    const schedule = activity.sampleDay({ pool, date, profile, context: { character: c } });
    for (let i = 1; i < schedule.length; i += 1) {
      const prev = schedule[i - 1].category;
      const cur = schedule[i].category;
      if (prev === cur && cur !== 'discovery') {
        assert.fail(`${date} 相邻两条同类：${prev} @ ${schedule[i - 1].time} / ${schedule[i].time}`);
      }
    }
    const discoveries = schedule.filter((row) => row.category === 'discovery').length;
    assert.ok(discoveries <= 2, `${date} discovery 过多：${discoveries}`);
  }
});

test('作息：声明 20:00 后活跃时，18:00 之后的活动被挪进窗口', () => {
  const c = {
    id: 'rhythm', name: '小满',
    life: { occupation: '学校工作', activeFrom: '20:00', activeTo: '23:30', hobbies: ['看书'] },
    persona: { inner: { profile: { social: 45, structure: 60, openness: 45, pace: 45, expressiveness: 40 } } },
  };
  const pool = activity.buildFallbackPool({ character: c, profile: c.persona.inner.profile });
  for (const date of ['2026-11-02', '2026-11-05']) {
    const schedule = activity.sampleDay({ pool, date, profile: c.persona.inner.profile, context: { character: c } });
    for (const row of schedule) {
      const minutes = Number(row.time.slice(0, 2)) * 60 + Number(row.time.slice(3, 5));
      if (minutes >= 18 * 60) assert.ok(minutes >= 20 * 60, `${date} ${row.time} 应落在 20:00 之后`);
    }
  }
});


test('filterPool：life.forbiddenActivities 命中即丢弃', () => {
  const c = character({ life: { forbiddenActivities: ['画画', '图书馆'] } });
  const items = [
    { category: 'home', text: '在画桌前画画', solo: true, indoor: true, energyCost: 5, needs: {} },
    { category: 'solo_out', text: '去图书馆坐一下午', solo: true, indoor: false, energyCost: 8, needs: {} },
    { category: 'home', text: '在窗边弹了会儿琴', solo: true, indoor: true, energyCost: 5, needs: {} },
  ];
  const out = activity.filterPool(items, {
    character: c,
    profile: FIVE_DIM,
    state: { mood: 70, energy: 70, focus: 70 },
  });
  assert.deepEqual(out.map((item) => item.text), ['在窗边弹了会儿琴']);
});
