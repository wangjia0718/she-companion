'use strict';

// 单击 / 双击 / 拖动的判定（reviewer 阻塞 1）：
// 单击延迟必须 ≥ 系统双击间隔，且双击第二下要撤销已排队的单击。

const { test } = require('node:test');
const assert = require('node:assert');

const { createClickGate, DEFAULT_DELAY_MS } = require('../src/renderer/pet/pet-click');

/** 可控时钟：只跑我自己调用过的定时器 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    pending() {
      return timers.size;
    },
  };
}

function setup(delay = DEFAULT_DELAY_MS) {
  const opened = [];
  const clock = fakeClock();
  const gate = createClickGate({
    delay,
    onSingle: () => opened.push('chat'),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { opened, clock, gate };
}

/** 模拟双击：第一下松手 → gap 毫秒后第二下松手 → dblclick 打开设置 */
function doubleClick(gapMs, delay) {
  const ctx = setup(delay);
  ctx.gate.pointerUp({ detail: 1, dragMoved: false });
  ctx.clock.advance(gapMs);
  const second = ctx.gate.pointerUp({ detail: 2, dragMoved: false });
  // dblclick 处理器做的事：再取消一次（幂等）+ 打开设置
  ctx.gate.cancel();
  ctx.opened.push('settings');
  ctx.clock.advance(2000);
  return { ...ctx, second };
}

test('默认单击延迟是 500ms（不低于 Windows 默认双击间隔）', () => {
  assert.equal(DEFAULT_DELAY_MS, 500);
  assert.equal(setup().gate.delay, 500);
});

test('单击：延迟到点才开聊天，只开一次', () => {
  const ctx = setup();
  assert.equal(ctx.gate.pointerUp({ detail: 1 }), 'queued');
  ctx.clock.advance(499);
  assert.deepEqual(ctx.opened, []);
  ctx.clock.advance(1);
  assert.deepEqual(ctx.opened, ['chat']);
  ctx.clock.advance(5000);
  assert.deepEqual(ctx.opened, ['chat']);
});

test('重复松手不会排两次队（防重复排队）', () => {
  const ctx = setup();
  assert.equal(ctx.gate.pointerUp({ detail: 1 }), 'queued');
  assert.equal(ctx.gate.pointerUp({ detail: 1 }), 'queued');
  ctx.clock.advance(5000);
  assert.deepEqual(ctx.opened, ['chat']);
});

test('150ms 双击：只打开设置，不打开聊天', () => {
  const ctx = doubleClick(150);
  assert.equal(ctx.second, 'superseded');
  assert.deepEqual(ctx.opened, ['settings']);
  assert.equal(ctx.clock.pending(), 0);
});

test('320ms 双击：只打开设置（旧实现 240ms 延迟会先开聊天）', () => {
  const ctx = doubleClick(320);
  assert.equal(ctx.second, 'superseded');
  assert.deepEqual(ctx.opened, ['settings']);
  assert.equal(ctx.clock.pending(), 0);
});

test('拖动 200px 后松手：不开任何窗口', () => {
  const ctx = setup();
  const result = ctx.gate.pointerUp({ detail: 1, dragMoved: true });
  assert.equal(result, 'drag');
  ctx.clock.advance(5000);
  assert.deepEqual(ctx.opened, []);
  assert.equal(ctx.clock.pending(), 0);
});

test('超过延迟的两次单击（600ms 间隔）：算两次单击', () => {
  const ctx = setup();
  ctx.gate.pointerUp({ detail: 1 });
  ctx.clock.advance(600);
  ctx.gate.pointerUp({ detail: 1 });
  ctx.clock.advance(600);
  assert.deepEqual(ctx.opened, ['chat', 'chat']);
});
