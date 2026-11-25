'use strict';

// Task 10：小人窗位置的钳制规则（geometry.clampPetPos）。
// 覆盖：越界右下角、负坐标、多屏负坐标 workArea、非法输入、合法坐标不动、窗口大于屏幕。

const { test } = require('node:test');
const assert = require('node:assert');

const {
  clampPetPos, clampPetPosToNearest, initialPetPosition, nearestWorkArea, MARGIN,
} = require('../src/main/geometry');

const SIZE = { width: 220, height: 380 };
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };

test('超出右下角被钳制在 workArea 内（留 8px 边距）', () => {
  const pos = clampPetPos({ x: 5000, y: 5000 }, SIZE, PRIMARY);
  assert.deepEqual(pos, {
    x: PRIMARY.width - SIZE.width - MARGIN,
    y: PRIMARY.height - SIZE.height - MARGIN,
  });
  assert.deepEqual(pos, { x: 1692, y: 652 });
});

test('负坐标回到 workArea 左/上边距处', () => {
  const pos = clampPetPos({ x: -100, y: -4 }, SIZE, PRIMARY);
  assert.equal(pos.x, PRIMARY.x + MARGIN);
  assert.equal(pos.y, PRIMARY.y + MARGIN);
  assert.deepEqual(pos, { x: 8, y: 8 });
});

test('多屏时用传入的 workArea（负边界的副屏），而不是主屏', () => {
  const leftScreen = { x: -1280, y: -200, width: 1280, height: 1024 };
  const bottomRight = clampPetPos({ x: 99999, y: 99999 }, SIZE, leftScreen);
  assert.deepEqual(bottomRight, {
    x: -1280 + 1280 - SIZE.width - MARGIN,
    y: -200 + 1024 - SIZE.height - MARGIN,
  });
  assert.deepEqual(bottomRight, { x: -228, y: 436 });

  // 右上越界应贴在副屏右上，不会被拉回主屏的 0 点
  const topLeft = clampPetPos({ x: -5000, y: -5000 }, SIZE, leftScreen);
  assert.deepEqual(topLeft, { x: -1272, y: -192 });
});

test('非法输入不抛：null/NaN/缺字段都返回有限整数', () => {
  const cases = [
    [null, SIZE, PRIMARY],
    [{ x: null, y: null }, SIZE, PRIMARY],
    [{ x: Number.NaN, y: 0 }, SIZE, PRIMARY],
    [{ x: Infinity, y: -Infinity }, null, PRIMARY],
    [{ x: 10, y: 20 }, SIZE, null],
    [{ x: 10, y: 20 }, SIZE, { x: 0, y: 0, width: 0, height: 0 }],
    [undefined, undefined, undefined],
    ['nonsense', 'nonsense', 'nonsense'],
  ];
  for (const [pos, size, area] of cases) {
    let result;
    assert.doesNotThrow(() => {
      result = clampPetPos(pos, size, area);
    });
    assert.equal(typeof result.x, 'number');
    assert.equal(typeof result.y, 'number');
    assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y));
  }
});

test('坐标非法但 workArea 合法时回退到右下角', () => {
  const pos = clampPetPos(null, SIZE, PRIMARY);
  assert.deepEqual(pos, { x: 8, y: 652 });
  assert.deepEqual(clampPetPos({ x: Number.NaN, y: 3 }, SIZE, PRIMARY), { x: 8, y: 652 });
});

test('合法坐标原样保留（取整）', () => {
  assert.deepEqual(clampPetPos({ x: 300, y: 200 }, SIZE, PRIMARY), { x: 300, y: 200 });
  assert.deepEqual(clampPetPos({ x: 300.4, y: 200.6 }, SIZE, PRIMARY), { x: 300, y: 201 });
});

test('窗口比 workArea 还大时不会算出负方向越界', () => {
  const tiny = { x: 100, y: 50, width: 120, height: 100 };
  const pos = clampPetPos({ x: 999, y: 999 }, SIZE, tiny);
  assert.equal(pos.x, tiny.x + MARGIN);
  assert.equal(pos.y, tiny.y + MARGIN);
});

// ---------------------------------------------------------------------------
// 多屏启动位置（reviewer 阻塞 2）：已保存坐标按它所在的显示器钳制
// ---------------------------------------------------------------------------

const LEFT_SCREEN = { x: -1280, y: 0, width: 1280, height: 1024 };
const MAIN_SCREEN = { x: 0, y: 0, width: 1920, height: 1040 };

test('nearestWorkArea：按矩形距离选最近的显示器（含负坐标屏）', () => {
  const areas = [MAIN_SCREEN, LEFT_SCREEN];
  assert.deepEqual(nearestWorkArea({ x: -500, y: 300 }, areas), LEFT_SCREEN);
  assert.deepEqual(nearestWorkArea({ x: 300, y: 200 }, areas), MAIN_SCREEN);
  // 非常靠左但仍落在某块屏内
  assert.deepEqual(nearestWorkArea({ x: -1270, y: 10 }, areas), LEFT_SCREEN);
  // 非法输入不抛
  assert.equal(nearestWorkArea(null, areas), null);
  assert.equal(nearestWorkArea({ x: Number.NaN, y: 1 }, areas), null);
  assert.equal(nearestWorkArea({ x: 0, y: 0 }, []), null);
});

test('启动位置：已保存的副屏坐标（-500,300）不会被拉回主屏', () => {
  const pos = initialPetPosition({ x: -500, y: 300 }, SIZE, [MAIN_SCREEN, LEFT_SCREEN], MAIN_SCREEN);
  // 旧实现固定用主屏 → {x: 8, y: 300}；现在应留在副屏
  assert.deepEqual(pos, { x: -500, y: 300 });
  assert.notEqual(pos.x, MAIN_SCREEN.x + MARGIN);
});

test('启动位置：已保存的主屏坐标（300,200）保持不变', () => {
  assert.deepEqual(
    initialPetPosition({ x: 300, y: 200 }, SIZE, [MAIN_SCREEN, LEFT_SCREEN], MAIN_SCREEN),
    { x: 300, y: 200 },
  );
});

test('坐标落在副屏但越界时，钳制到副屏的边距（不回主屏）', () => {
  const pos = clampPetPosToNearest({ x: -9999, y: 9999 }, SIZE, [MAIN_SCREEN, LEFT_SCREEN], MAIN_SCREEN);
  assert.deepEqual(pos, {
    x: LEFT_SCREEN.x + MARGIN,
    y: LEFT_SCREEN.y + LEFT_SCREEN.height - SIZE.height - MARGIN,
  });
});

test('坐标缺失时用 fallback workArea 的左下角', () => {
  assert.deepEqual(
    clampPetPosToNearest(null, SIZE, [MAIN_SCREEN, LEFT_SCREEN], MAIN_SCREEN),
    { x: MARGIN, y: 1040 - 380 - 8 },
  );
  assert.deepEqual(
    clampPetPosToNearest({ x: Number.NaN, y: 5 }, SIZE, [], MAIN_SCREEN),
    { x: MARGIN, y: 1040 - 380 - 8 },
  );
});

