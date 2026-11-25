'use strict';

// scheduler.js 测试：覆盖计划 Task 8 的 4 个必要点，外加：
// - 静默时段边界（23:29 / 23:30 / 07:59 / 08:00）与 from === to 全天静默
// - 设置缺字段 / 非法格式 / 非法时钟时 isQuiet 返回 false
// - shouldExtractIdle 的「从未有用户消息 / 刚刚抽取过 / 时钟回拨」不触发
// - tickOnce 连续快速调用只执行一次
// - onTick 抛错与 rejected promise 都不杀循环，且不产生 unhandledRejection
// - start/stop 与 intervalMs 兜底（不依赖 >2s 的真实等待）

const { test } = require('node:test');
const assert = require('node:assert');

const { isQuiet, shouldExtractIdle, createScheduler } = require('../src/main/scheduler');

const DEFAULT_SETTINGS = { life: { quietFrom: '23:30', quietTo: '08:00' } };

/** 本地时间构造（2026-10-26），绝不用 UTC 字符串避免时区干扰 */
function at(hour, minute, day = 26) {
  return new Date(2026, 9, day, hour, minute, 0, 0);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 800) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

// ---------------------------------------------------------------- isQuiet

test('isQuiet 跨午夜区间：23:29 与 08:00 之外，23:30 与 07:59 之内', () => {
  const cases = [
    [23, 29, false],
    [23, 30, true],
    [7, 59, true],
    [8, 0, false],
    [23, 45, true],
    [0, 0, true],
    [6, 30, true],
    [8, 1, false],
    [12, 0, false],
    [22, 0, false],
  ];
  for (const [hour, minute, expected] of cases) {
    assert.equal(isQuiet(DEFAULT_SETTINGS, at(hour, minute)), expected, `${hour}:${minute}`);
  }
});

test('isQuiet 同一天内的非跨夜区间（12:00–14:00）', () => {
  assert.equal(isQuiet({ life: { quietFrom: '12:00', quietTo: '14:00' } }, at(11, 59)), false);
  assert.equal(isQuiet({ life: { quietFrom: '12:00', quietTo: '14:00' } }, at(12, 0)), true);
  assert.equal(isQuiet({ life: { quietFrom: '12:00', quietTo: '14:00' } }, at(13, 59)), true);
  assert.equal(isQuiet({ life: { quietFrom: '12:00', quietTo: '14:00' } }, at(14, 0)), false);
  assert.equal(isQuiet({ life: { quietFrom: '12:00', quietTo: '14:00' } }, at(0, 0)), false);
});

test('isQuiet：from === to 视为全天静默', () => {
  const allDay = { life: { quietFrom: '00:00', quietTo: '00:00' } };
  for (const [hour, minute] of [[0, 0], [3, 15], [10, 30], [18, 0], [23, 59]]) {
    assert.equal(isQuiet(allDay, at(hour, minute)), true, `${hour}:${minute}`);
  }
  assert.equal(isQuiet({ life: { quietFrom: '12:00', quietTo: '12:00' } }, at(3, 15)), true);
  // 也接受扁平写法（settings 直接带 quietFrom/quietTo）
  assert.equal(isQuiet({ quietFrom: '08:00', quietTo: '08:00' }, at(20, 0)), true);
});

test('isQuiet：设置缺字段或格式非法时返回 false', () => {
  assert.equal(isQuiet(undefined, at(23, 45)), false);
  assert.equal(isQuiet(null, at(23, 45)), false);
  assert.equal(isQuiet({}, at(23, 45)), false);
  assert.equal(isQuiet({ life: {} }, at(23, 45)), false);
  assert.equal(isQuiet({ life: { quietFrom: '23:30' } }, at(23, 45)), false);
  assert.equal(isQuiet({ life: { quietTo: '08:00' } }, at(23, 45)), false);
  assert.equal(isQuiet({ life: { quietFrom: null, quietTo: null } }, at(23, 45)), false);
  assert.equal(isQuiet({ life: { quietFrom: '25:00', quietTo: '08:00' } }, at(23, 45)), false);
  assert.equal(isQuiet({ life: { quietFrom: '23:30', quietTo: '8:0' } }, at(23, 45)), false);
  assert.equal(isQuiet({ life: { quietFrom: 'abc', quietTo: '08:00' } }, at(23, 45)), false);
  assert.equal(isQuiet(DEFAULT_SETTINGS, new Date('not a date')), false);
});

// ------------------------------------------------------- shouldExtractIdle

test('shouldExtractIdle：距最后一条用户消息满 10 分钟且期间未抽取才触发', () => {
  const lastUserAt = at(20, 50);
  const lastExtractAt = at(20, 0);

  // 正好 10 分钟
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt, now: at(21, 0) }),
    true,
  );
  // 9 分钟：还不到
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt, now: at(20, 59) }),
    false,
  );
  // 远超 10 分钟：触发
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt, now: at(21, 30) }),
    true,
  );
  // 自定义 idleMinutes
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt, now: at(20, 55), idleMinutes: 5 }),
    true,
  );
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt, now: at(20, 54), idleMinutes: 5 }),
    false,
  );
});

test('shouldExtractIdle：刚抽取过 / 抽取点不早于最后消息时不触发', () => {
  const lastUserAt = at(20, 50);
  // 刚抽取过（抽取时间晚于最后一条消息）
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt: at(21, 0), now: at(21, 5) }),
    false,
  );
  // 抽取时间与最后消息相同：没有未抽取内容
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt: new Date(lastUserAt.getTime()), now: at(21, 30) }),
    false,
  );
  // 抽取时间在未来（时钟异常）也不触发
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt: at(23, 0), now: at(21, 30) }),
    false,
  );
  // 从未抽取过：视为有未抽取内容
  assert.equal(
    shouldExtractIdle({ lastUserAt, now: at(21, 30) }),
    true,
  );
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt: null, now: at(21, 30) }),
    true,
  );
  // 抽取时间无法解析：按从未抽取处理
  assert.equal(
    shouldExtractIdle({ lastUserAt, lastExtractAt: new Date('bad'), now: at(21, 30) }),
    true,
  );
});

test('shouldExtractIdle：从来没有用户消息或时钟回拨时不触发', () => {
  assert.equal(shouldExtractIdle(), false);
  assert.equal(shouldExtractIdle({}), false);
  assert.equal(shouldExtractIdle({ now: at(21, 0) }), false);
  assert.equal(shouldExtractIdle({ lastUserAt: null, now: at(21, 0) }), false);
  assert.equal(
    shouldExtractIdle({ lastUserAt: new Date('bad'), now: at(21, 0) }),
    false,
  );
  // 时钟回拨：now 早于最后一条用户消息
  assert.equal(
    shouldExtractIdle({ lastUserAt: at(21, 0), lastExtractAt: at(20, 0), now: at(20, 30) }),
    false,
  );
});

// ------------------------------------------------------------ createScheduler

test('tickOnce 执行一次并返回 true，注入的 now 被传给 onTick', () => {
  const fixed = at(21, 30);
  const seen = [];
  const scheduler = createScheduler({ now: () => fixed, onTick: (value) => seen.push(value) });

  assert.equal(scheduler.tickOnce(), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].getTime(), fixed.getTime());
  // 传给 onTick 的是副本，外部修改不影响调度器
  assert.notEqual(seen[0], fixed);
});

test('tickOnce 重入保护：上一次未完成时直接返回 false', async () => {
  const pending = deferred();
  let calls = 0;
  const scheduler = createScheduler({
    onTick: () => {
      calls += 1;
      return pending.promise;
    },
  });

  assert.equal(scheduler.tickOnce(), true);
  assert.equal(scheduler.tickOnce(), false);
  assert.equal(scheduler.tickOnce(), false);
  assert.equal(calls, 1);

  pending.resolve();
  await flush();
  assert.equal(scheduler.tickOnce(), true);
  assert.equal(calls, 2);
});

test('onTick 同步抛错被吞掉，第二次 tick 仍会执行', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    let calls = 0;
    const scheduler = createScheduler({
      onTick: () => {
        calls += 1;
        throw new Error('同步 boom');
      },
    });

    assert.equal(scheduler.tickOnce(), true);
    assert.equal(scheduler.tickOnce(), true);
    assert.equal(calls, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test('onTick 返回 rejected promise 被捕获，不产生 unhandledRejection', async () => {
  const rejections = [];
  const onUnhandled = (reason) => rejections.push(reason);
  const originalWarn = console.warn;
  console.warn = () => {};
  process.on('unhandledRejection', onUnhandled);

  try {
    let calls = 0;
    const scheduler = createScheduler({
      onTick: async () => {
        calls += 1;
        throw new Error('异步 boom');
      },
    });

    assert.equal(scheduler.tickOnce(), true);
    // 未结算前重入被挡掉
    assert.equal(scheduler.tickOnce(), false);

    await sleep(0);
    await sleep(0);

    assert.deepEqual(rejections, [], '不应产生 unhandledRejection');
    assert.equal(scheduler.tickOnce(), true);
    assert.equal(calls, 2);
    await sleep(0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    console.warn = originalWarn;
  }
});

test('start 后按 interval 触发；stop 后不再触发，手动 tickOnce 仍可用', async () => {
  let calls = 0;
  const scheduler = createScheduler({
    intervalMs: 10,
    onTick: () => {
      calls += 1;
    },
  });

  scheduler.start();
  assert.equal(await waitFor(() => calls >= 2), true, 'start 后应至少触发两次');

  scheduler.stop();
  scheduler.stop(); // 幂等
  const afterStop = calls;
  await sleep(60);
  assert.equal(calls, afterStop, 'stop 后定时器不应再触发');

  assert.equal(scheduler.tickOnce(), true);
  assert.equal(calls, afterStop + 1);
});

test('intervalMs ≤ 0 / 非法值回落到 60000，不会立刻连续触发', async () => {
  for (const bad of [0, -1, -1000, Number.NaN, Infinity, 'x', null]) {
    let calls = 0;
    const scheduler = createScheduler({
      intervalMs: bad,
      onTick: () => {
        calls += 1;
      },
    });

    scheduler.start();
    await sleep(30);
    scheduler.stop();
    assert.equal(calls, 0, `intervalMs=${String(bad)} 不应在 30ms 内触发`);
  }
});

test('createScheduler 缺省参数不抛错，tickOnce 视为已执行', () => {
  const scheduler = createScheduler();
  assert.equal(typeof scheduler.start, 'function');
  assert.equal(typeof scheduler.stop, 'function');
  assert.equal(scheduler.tickOnce(), true);
  scheduler.start();
  scheduler.stop();
});
