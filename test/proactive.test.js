'use strict';

// 主动消息扩展（P6 / specs/2026-10-27-life-v2-design.md 第 6 节）。
// 新增触发源：bedtime / holiday / birthday / followup / project / weather。
// 全部走纯决策 + 本地兜底，不等待真实时间、不联网；模型调用一律本地 stub。

const { test } = require('node:test');
const assert = require('node:assert');

const life = require('../src/main/life');
const llm = require('../src/main/llm');

const NIGHT_WORDS = /(今晚|晚安|早点睡|该睡了|该休息了|睡觉吧|夜里|深夜)/u;
const BIRTHDAY = { calendar: 'solar', year: 1999, month: 10, day: 1 }; // 与国庆同一天，方便测优先级

function settings(overrides = {}) {
  return {
    life: {
      enabled: true,
      quietFrom: '23:30',
      quietTo: '08:00',
      proactivePerDay: 2,
      ...overrides,
    },
  };
}

function character(overrides = {}) {
  return {
    id: 'char-p6',
    name: '她',
    persona: { traits: ['安静'], birthday: { ...BIRTHDAY } },
    life: { city: '上海', occupation: '自由插画师' },
    ...overrides,
  };
}

function makeDay(overrides = {}) {
  return {
    schedule: [],
    events: [],
    proactive: {},
    ...overrides,
  };
}

function at(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** 只有「生日 + 节日 + 项目 + 天气」都满足时才方便测优先级 */
function richArgs(now) {
  return {
    day: makeDay({
      events: [{
        time: '09:50',
        activity: '完成项目：读完《夜晚的潜水艇》',
        text: '她读完了《夜晚的潜水艇》',
        projectTitle: '读完《夜晚的潜水艇》',
        projectDone: true,
        fired: true,
      }],
    }),
    now,
    settings: settings({ proactivePerDay: 9 }),
    state: { energy: 70, mood: 65, weather: { code: 'rain', isRain: true, isClear: false } },
    previousWeather: { code: 'clear', isRain: false, isClear: true },
    lastUserAt: new Date(now.getTime() - 20 * 60 * 60 * 1000),
    lastUserText: '昨天去看了个牙医',
    character: character(),
    startedAt: new Date(now.getTime() - 60 * 60 * 1000),
  };
}

/** 临时替换 llm.chat，测试结束自动还原 */
function mockLlm(t, chat) {
  const original = llm.chat;
  llm.chat = chat;
  t.after(() => {
    llm.chat = original;
  });
}

// ---------------------------------------------------------------------------
// 1. bedtime
// ---------------------------------------------------------------------------

test('bedtime：静默开始前 30 分钟内且体力 <60 才选中', () => {
  const base = {
    day: makeDay(),
    settings: settings(),
    character: character(),
  };

  const picked = life.pickProactive({
    ...base, now: at(2026, 10, 20, 23, 20), state: { energy: 50, mood: 60 },
  });
  assert.equal(picked.trigger, 'bedtime');
  assert.ok(picked.meta.bedInMinutes > 0 && picked.meta.bedInMinutes <= 30);

  // 静默前一分钟仍然可以发
  const justBefore = life.pickProactive({
    ...base, now: at(2026, 10, 20, 23, 29), state: { energy: 50, mood: 60 },
  });
  assert.equal(justBefore.trigger, 'bedtime');

  // 还差 50 分钟：不在窗口内
  assert.equal(life.pickProactive({
    ...base, now: at(2026, 10, 20, 22, 40), state: { energy: 50, mood: 60 },
  }), null);

  // 体力 ≥60：不提醒
  assert.equal(life.pickProactive({
    ...base, now: at(2026, 10, 20, 23, 20), state: { energy: 62, mood: 60 },
  }), null);
});

test('bedtime：静默时段内一律不发（23:30 / 23:31）', () => {
  const base = {
    day: makeDay(),
    settings: settings(),
    state: { energy: 40, mood: 60 },
    character: character(),
  };
  assert.equal(life.pickProactive({ ...base, now: at(2026, 10, 20, 23, 30) }), null);
  assert.equal(life.pickProactive({ ...base, now: at(2026, 10, 20, 23, 31) }), null);
});

// ---------------------------------------------------------------------------
// 2. holiday
// ---------------------------------------------------------------------------

test('holiday：节日当天选中，meta 带节日名', () => {
  const picked = life.pickProactive({
    day: makeDay(),
    now: at(2027, 1, 1, 10, 0),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    character: character(),
  });
  assert.equal(picked.trigger, 'holiday');
  assert.equal(picked.meta.holiday, '元旦');
});

test('holiday：非节日不选', () => {
  const picked = life.pickProactive({
    day: makeDay(),
    now: at(2026, 10, 20, 10, 0),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    character: character(),
  });
  assert.equal(picked, null);
});

// ---------------------------------------------------------------------------
// 3. birthday 与优先级
// ---------------------------------------------------------------------------

test('birthday：生日当天选中（不受节日干扰）', () => {
  const picked = life.pickProactive({
    day: makeDay(),
    now: at(2026, 10, 1, 10, 0),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    character: character(),
  });
  assert.equal(picked.trigger, 'birthday');
});

test('优先级：生日 > 节日 > 项目 > 天气', () => {
  const now = at(2026, 10, 1, 10, 0);
  const args = richArgs(now);
  const order = [];

  let picked = life.pickProactive(args);
  order.push(picked && picked.trigger);
  args.day.proactive[picked.trigger] = true;

  picked = life.pickProactive(args);
  order.push(picked && picked.trigger);
  args.day.proactive[picked.trigger] = true;

  picked = life.pickProactive(args);
  order.push(picked && picked.trigger);
  args.day.proactive[picked.trigger] = true;

  picked = life.pickProactive(args);
  order.push(picked && picked.trigger);

  assert.deepEqual(order, ['birthday', 'holiday', 'project', 'weather']);
});

test('优先级：回访 > 睡前 > 开机', () => {
  const now = at(2026, 10, 20, 23, 20);
  const args = {
    day: makeDay(),
    now,
    settings: settings({ proactivePerDay: 9 }),
    state: { energy: 50, mood: 60 },
    lastUserAt: at(2026, 10, 19, 21, 0),
    lastUserText: '昨天去看了个牙医',
    character: character(),
    startedAt: at(2026, 10, 20, 23, 0),
  };

  const followup = life.pickProactive(args);
  assert.equal(followup.trigger, 'followup');
  args.day.proactive.followup = true;

  const bedtime = life.pickProactive(args);
  assert.equal(bedtime.trigger, 'bedtime');
  args.day.proactive.bedtime = true;

  const idle = life.pickProactive(args);
  assert.equal(idle.trigger, 'idle');
  args.day.proactive.idle = true;

  // 深夜不再用“刚开机/刚醒”当 boot 问候
  assert.equal(life.pickProactive(args), null);
});

// ---------------------------------------------------------------------------
// 4. 全局规则
// ---------------------------------------------------------------------------

test('每日上限：已有 2 条主动消息时，所有触发源都返回 null', () => {
  const now = at(2026, 10, 1, 10, 0);
  const args = richArgs(now);
  args.settings = settings(); // 默认上限 2
  args.day.proactive = { holiday: true, boot: true }; // 已用 2 条

  assert.equal(life.pickProactive(args), null);
});

test('energy < 25：任何触发源都不发', () => {
  const now = at(2026, 10, 1, 10, 0);
  const args = richArgs(now);
  args.state = { ...args.state, energy: 24 };

  assert.equal(life.pickProactive(args), null);
});

// ---------------------------------------------------------------------------
// 5. followup
// ---------------------------------------------------------------------------

test('followup：昨天没聊天不发', () => {
  const now = at(2026, 10, 20, 10, 0);
  const picked = life.pickProactive({
    day: makeDay(),
    now,
    settings: settings(),
    state: { energy: 70, mood: 60 },
    lastUserAt: at(2026, 10, 20, 9, 50), // 今天刚聊过
    lastUserText: '昨天去看了个牙医',
    character: character(),
  });
  assert.equal(picked, null);
});

test('followup：昨天聊过但今天已发过一条不发', () => {
  const now = at(2026, 10, 20, 10, 0);
  const picked = life.pickProactive({
    day: makeDay({ proactive: { boot: true, idle: true, event: true } }),
    now,
    settings: settings(),
    state: { energy: 70, mood: 60 },
    lastUserAt: at(2026, 10, 19, 21, 0),
    lastUserText: '昨天去看了个牙医',
    character: character(),
  });
  assert.equal(picked, null, '今天已有主动消息，回访要让位');
});

test('followup：昨天聊过且今天没发过，取关键词触发', () => {
  const now = at(2026, 10, 20, 10, 0);
  const picked = life.pickProactive({
    day: makeDay(),
    now,
    settings: settings(),
    state: { energy: 70, mood: 60 },
    lastUserAt: at(2026, 10, 19, 21, 0),
    lastUserText: '昨天去看了个牙医',
    character: character(),
  });
  assert.equal(picked.trigger, 'followup');
  assert.equal(picked.meta.keyword, '牙医');
});

test('followup：跳过晚安，从昨天最后一件正事取话题并带原话', () => {
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
    { role: 'user', text: '嗯嗯~那我去睡啦~你也早点休息~', ts: '2026-10-31T22:39:09+08:00' },
    { role: 'user', text: '晚安良人~', ts: '2026-10-31T22:39:22+08:00' },
  ];
  const picked = life.pickProactive({
    day: makeDay(),
    now: at(2026, 11, 1, 9, 18),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    lastUserAt: at(2026, 10, 31, 22, 39),
    lastUserText: '晚安良人~',
    recentMessages,
    character: character(),
    startedAt: at(2026, 11, 1, 8, 0),
  });

  assert.equal(picked.trigger, 'followup');
  assert.match(picked.meta.sourceText, /你送我的那盆也冒出两片新的/);
  assert.match(picked.meta.keyword, /盆|冒出两片新/);
  assert.doesNotMatch(picked.meta.keyword, /晚安/);
  assert.match(picked.meta.replyText, /缓过来了/);
  assert.equal(life.followupKeyword('晚安良人~'), '', '寒暄不能当回访话题');
});

test('followup：只有晚安时宁可不发，不拿寒暄硬凑话题', () => {
  const picked = life.pickProactive({
    day: makeDay(),
    now: at(2026, 10, 20, 10, 0),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    lastUserAt: at(2026, 10, 19, 22, 39),
    lastUserText: '晚安良人~',
    character: character(),
  });
  assert.notEqual(picked && picked.trigger, 'followup');
});

// ---------------------------------------------------------------------------
// 6. weather / project
// ---------------------------------------------------------------------------

test('weather：昨天与今天天气相同不发', () => {
  const picked = life.pickProactive({
    day: makeDay(),
    now: at(2026, 10, 20, 10, 0),
    settings: settings(),
    state: { energy: 70, mood: 60, weather: { isRain: true, isClear: false } },
    previousWeather: { isRain: true, isClear: false },
    character: character(),
  });
  assert.equal(picked, null);
});

test('weather：晴转雨 / 雨转晴各触发一次，meta 说明今天', () => {
  const base = {
    day: makeDay(),
    now: at(2026, 10, 20, 10, 0),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    character: character(),
  };

  const rainy = life.pickProactive({
    ...base,
    state: { ...base.state, weather: { isRain: true, isClear: false } },
    previousWeather: { isRain: false, isClear: true },
  });
  assert.equal(rainy.trigger, 'weather');
  assert.equal(rainy.meta.weather, 'rain');

  const clear = life.pickProactive({
    ...base,
    state: { ...base.state, weather: { isRain: false, isClear: true } },
    previousWeather: { isRain: true, isClear: false },
  });
  assert.equal(clear.trigger, 'weather');
  assert.equal(clear.meta.weather, 'clear');
});

test('project：当天有完成记录才分享，并带项目名', () => {
  const now = at(2026, 10, 20, 10, 0);
  const base = {
    now,
    settings: settings(),
    state: { energy: 70, mood: 60 },
    character: character(),
  };

  const picked = life.pickProactive({
    ...base,
    day: makeDay({
      events: [{
        time: '09:50',
        activity: '完成项目：读完《夜晚的潜水艇》',
        text: '她读完了《夜晚的潜水艇》',
        projectTitle: '读完《夜晚的潜水艇》',
        projectDone: true,
        fired: true,
      }],
    }),
  });
  assert.equal(picked.trigger, 'project');
  assert.equal(picked.meta.project, '读完《夜晚的潜水艇》');

  // 只有普通事件：不触发
  assert.equal(life.pickProactive({
    ...base,
    day: makeDay({ events: [{ time: '09:50', text: '她喝了口水', fired: true }] }),
  }), null);
});

// ---------------------------------------------------------------------------
// 7. 兜底文案
// ---------------------------------------------------------------------------

test('兜底：每个新触发源都有 ≥2 条、≤40 字，且不含夜间用语（bedtime 除外）', async () => {
  const triggers = ['bedtime', 'holiday', 'birthday', 'followup', 'project', 'weather'];
  for (const trigger of triggers) {
    const pool = life.PROACTIVE_FALLBACKS[trigger];
    assert.ok(Array.isArray(pool) && pool.length >= 2, `${trigger} 至少 2 条兜底`);
    for (const text of pool) {
      assert.ok(Array.from(text).length <= life.MAX_PROACTIVE_CHARS, `${trigger} 超 40 字：${text}`);
      if (trigger !== 'bedtime') {
        assert.equal(NIGHT_WORDS.test(text), false, `${trigger} 兜底含夜间用语：${text}`);
      }
    }

    const day = makeDay();
    const message = await life.runProactive({
      character: character(),
      now: at(2026, 10, 20, 10, 0),
      day,
      trigger,
      settings: settings(),
      state: { energy: 70, mood: 60 },
    });
    assert.ok(message, `${trigger} 应返回兜底消息`);
    assert.equal(message.trigger, trigger);
    assert.ok(Array.from(message.text).length <= life.MAX_PROACTIVE_CHARS);
    assert.equal(day.proactive[trigger], true);
  }
});

test('生日消息在下午不会说「今晚/晚安」（重写后仍冲突则用兜底）', async (t) => {
  let calls = 0;
  mockLlm(t, async () => {
    calls += 1;
    return { text: '今晚早点睡，生日也就这样了。', usage: {} };
  });

  const message = await life.runProactive({
    character: character(),
    now: at(2026, 10, 1, 15, 0), // 下午
    day: makeDay(),
    trigger: 'birthday',
    settings: settings(),
    state: { energy: 70, mood: 60 },
    profile: { baseUrl: 'https://api.example.com/v1', model: 'm' },
  });

  assert.ok(message);
  assert.equal(message.trigger, 'birthday');
  assert.equal(calls, 2, '冲突只重写一次，最多 2 次调用');
  assert.equal(NIGHT_WORDS.test(message.text), false, `不该出现夜间用语：${message.text}`);
});

test('runProactive：最近说过的事换说法重复，会重写而不是当新发现再说一遍', async (t) => {
  let calls = 0;
  const seen = [];
  mockLlm(t, async ({ messages }) => {
    calls += 1;
    seen.push(messages);
    if (calls === 1) {
      return { text: '早啊，刚闲着看那盆绿植，真冒出两片新叶了。', usage: null, model: 'm' };
    }
    return { text: '你那盆现在长得怎么样了？', usage: null, model: 'm' };
  });

  const recentMessages = [
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
  const message = await life.runProactive({
    character: character(),
    now: at(2026, 11, 1, 9, 18),
    day: makeDay(),
    trigger: 'followup',
    meta: {
      keyword: '那盆',
      sourceText: '嗯嗯~你送我的那盆也冒出两片新的~',
      replyText: '噢噢真的啊，那就说明缓过来了。别急着多浇水，土干了再浇就好～',
    },
    recentMessages,
    settings: settings(),
    state: { energy: 70, mood: 60 },
    profile: { baseUrl: 'https://api.example.com/v1', model: 'm' },
  });

  assert.ok(message);
  assert.equal(calls, 2, '撞到最近说过的话只重写一次');
  assert.equal(message.text, '你那盆现在长得怎么样了？');
  const retryMessages = seen[1] || [];
  assert.match(retryMessages[retryMessages.length - 1].content, /已经说过/);
});

// ---------------------------------------------------------------------------
// 8. 原有触发源不受影响
// ---------------------------------------------------------------------------

test('原有三源（boot / event / idle）在没有新素材时照常工作', () => {
  const now = at(2026, 10, 20, 10, 30);
  const base = {
    day: makeDay({
      events: [{ time: '10:28', text: '刚收拾完桌子', fired: true }],
    }),
    now,
    settings: settings({ proactivePerDay: 9 }),
    state: { energy: 70, mood: 60 },
    startedAt: at(2026, 10, 20, 10, 0),
    lastUserAt: at(2026, 10, 20, 10, 25),
  };

  const boot = life.pickProactive(base);
  assert.equal(boot.trigger, 'boot');
  base.day.proactive.boot = true;

  const event = life.pickProactive(base);
  assert.equal(event.trigger, 'event');
  base.day.proactive.event = true;

  base.lastUserAt = at(2026, 10, 20, 1, 0); // 9.5 小时前
  const idle = life.pickProactive(base);
  assert.equal(idle.trigger, 'idle');
});

// ---------------------------------------------------------------------------
// 9. P7：表达维度 → 主动消息「少而短」
// ---------------------------------------------------------------------------

/** 五维里只改表达：其余维度固定在中间档，避免生日 / 星座自动值干扰 */
function expressive(value) {
  return {
    ...character(),
    persona: {
      traits: ['安静'],
      birthday: { ...BIRTHDAY },
      inner: {
        profile: {
          social: 50, structure: 50, openness: 60, pace: 50, expressiveness: value,
        },
      },
    },
  };
}

test('表达 ≤30：单条上限 28 字，每日上限降 1，followup 不触发', async () => {
  const low = expressive(20);
  assert.equal(life.proactiveMaxChars(low), 28);
  assert.equal(life.proactiveDailyLimit(settings(), low), 1, '默认 2 条 → 1 条');
  assert.equal(life.proactiveMaxChars(expressive(30)), 28);
  assert.equal(life.proactiveMaxChars(expressive(31)), 34, '刚过线回到 34 字');

  // 只剩 1 条额度：已经发过 1 条就不再挑触发源
  const busy = life.pickProactive({
    day: makeDay({ proactive: { boot: true } }),
    now: at(2026, 10, 20, 10, 0),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    character: low,
    startedAt: at(2026, 10, 20, 9, 0),
    lastUserAt: at(2026, 10, 20, 9, 55),
  });
  assert.equal(busy, null, '低表达每日只发 1 条');

  // followup：同样「昨天聊过、今天还没发」，高表达会回访，低表达跳过
  const args = {
    day: makeDay(),
    now: at(2026, 10, 20, 10, 0),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    startedAt: at(2026, 10, 20, 9, 55), // 刚启动，排除 boot
    lastUserAt: at(2026, 10, 19, 21, 0),
    lastUserText: '昨天去看了个牙医',
  };
  assert.equal(life.pickProactive({ ...args, character: expressive(90) }).trigger, 'followup');
  const skipped = life.pickProactive({ ...args, character: low });
  assert.notEqual(skipped && skipped.trigger, 'followup', '低表达不发回访');

  // runProactive 也拦一层：直接指定 followup 也不会发
  const direct = await life.runProactive({
    character: low,
    now: at(2026, 10, 20, 10, 0),
    day: makeDay(),
    trigger: 'followup',
    meta: { keyword: '牙医' },
    settings: settings(),
    state: { energy: 70, mood: 60 },
  });
  assert.equal(direct, null);
});

test('表达 ≤30：模型文案被截到 28 字，提示词里也写 28 字', async (t) => {
  const long = '刚把稿子改完，眼睛有点酸，窗外的天已经暗下来了，桌上的杯子也空了，忽然想问问你今天过得怎么样，吃饭了没有。';
  const seen = [];
  mockLlm(t, async ({ messages }) => {
    seen.push(messages);
    return { text: long, usage: null, model: 'm' };
  });

  const message = await life.runProactive({
    character: expressive(20),
    now: at(2026, 10, 20, 15, 0),
    day: makeDay(),
    trigger: 'idle',
    settings: settings(),
    state: { energy: 70, mood: 60 },
    profile: { baseUrl: 'https://api.example.com/v1', model: 'm' },
  });

  assert.ok(message);
  assert.ok(Array.from(message.text).length <= 28, `实际 ${Array.from(message.text).length} 字`);
  assert.ok(message.text.endsWith('…'));
  assert.match(seen[0][0].content, /≤28 字/);
  assert.doesNotMatch(seen[0][0].content, /≤40 字/);
});

test('表达 ≥70：维持 40 字与原有每日上限', async () => {
  const high = expressive(90);
  assert.equal(life.proactiveMaxChars(high), 40);
  assert.equal(life.proactiveDailyLimit(settings(), high), 2);
  assert.equal(life.proactiveMaxChars(expressive(70)), 40);
  assert.equal(life.proactiveMaxChars(expressive(69)), 34);

  const base = {
    day: makeDay({
      events: [{ time: '10:28', text: '刚收拾完桌子', fired: true }],
      proactive: { boot: true }, // 已用 1 条
    }),
    now: at(2026, 10, 20, 10, 30),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    character: high,
    startedAt: at(2026, 10, 20, 10, 0),
    lastUserAt: at(2026, 10, 20, 10, 25),
  };
  // 高表达还剩 1 条额度；低表达已经用完
  assert.equal(life.pickProactive(base).trigger, 'event', '高表达当天还能再发一条');
  assert.equal(life.pickProactive({ ...base, character: expressive(20) }), null);
});

test('表达低时兜底文案同样截到 28 字（模型失败也不超限）', async (t) => {
  mockLlm(t, async () => {
    throw new Error('boom');
  });

  const low = expressive(20);
  const message = await life.runProactive({
    character: low,
    now: at(2026, 10, 20, 15, 0),
    day: makeDay(),
    trigger: 'idle',
    settings: settings(),
    state: { energy: 70, mood: 60 },
    profile: { baseUrl: 'https://api.example.com/v1', model: 'm' },
  });

  assert.ok(message);
  assert.ok(Array.from(message.text).length <= 28);
  // 兜底池里超过 28 字的句子会被截断，不会整句照抄
  const raw = life.PROACTIVE_FALLBACKS.idle;
  const clipped = raw.filter((text) => Array.from(text).length > 28);
  if (clipped.length > 0) {
    assert.ok(clipped.every((text) => text.length > 28));
    assert.ok(message.text.endsWith('…') || Array.from(message.text).length <= 28);
  }
});


test('pickProactive：22:50 启动不再用 boot（刚开机/刚醒只属于一天开始）', () => {
  const picked = life.pickProactive({
    day: makeDay(),
    now: at(2026, 10, 20, 22, 50),
    settings: settings(),
    state: { energy: 70, mood: 60 },
    lastUserAt: at(2026, 10, 20, 22, 40),
    character: character(),
    startedAt: at(2026, 10, 20, 22, 35),
  });
  assert.equal(picked, null);
});

test('life 兜底：空档到了但九类触发源都不成立时，允许随口说一句', () => {
  const now = at(2026, 11, 25, 21, 30);
  const day = makeDay({
    proactivePlan: {
      version: 5,
      weekKey: '2026-11-23',
      weekCount: 5,
      dayCount: 1,
      plannedSlots: 1,
      selected: true,
      slots: [{ time: '21:30', sent: false }],
    },
  });
  const args = {
    day,
    now,
    settings: settings(),
    state: { energy: 80, mood: 70 },
    character: character(),
    lastUserAt: null,
    startedAt: null,
    lastUserText: '',
    recentMessages: [],
  };
  // 没显式开启：保持原来的「不满足就不发」
  assert.equal(life.pickProactive({ ...args }), null);
  // 开启兜底：随口分享一句；没有事件素材也不影响
  const picked = life.pickProactive({ ...args, allowLifeFallback: true });
  assert.equal(picked && picked.trigger, 'life');
});
