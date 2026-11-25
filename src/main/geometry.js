'use strict';

// 小人窗几何：把窗口左上角坐标钳制在给定的 workArea 内，四周留 8px 边距。
// 纯函数，不依赖 Electron / Node 模块，方便单测（test/geometry.test.js）。
//
// 约定：
//   pos      { x, y }，窗口左上角（屏幕坐标，可为负，多屏）
//   size     { width, height }，窗口尺寸
//   workArea { x, y, width, height }，目标屏幕的可用区域（不含任务栏）
// 返回 { x, y }，整数。

const MARGIN = 8;
// 小人窗默认尺寸（与 main.js 创建窗口、ipc 尺寸下限共用）
const PET_SIZE = { width: 220, height: 380 };

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validArea(workArea) {
  if (workArea === null || typeof workArea !== 'object') return null;
  const { x, y, width, height } = workArea;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function validSize(size) {
  if (size === null || typeof size !== 'object') return { width: 0, height: 0 };
  const width = isFiniteNumber(size.width) && size.width > 0 ? size.width : 0;
  const height = isFiniteNumber(size.height) && size.height > 0 ? size.height : 0;
  return { width, height };
}

function axis(value, min, max) {
  if (!Number.isFinite(value)) return null;
  // 窗口比可用区域还大时，没有「放进屏幕」的解，退到左上边距处，至少不丢到屏幕外
  if (max < min) return Math.round(min);
  return Math.round(Math.min(Math.max(value, min), max));
}

/**
 * 钳制小人窗位置。
 *
 * - 坐标非法（null / NaN / Infinity / 非数字）时回退到 workArea 右下角；
 * - workArea 非法时不做钳制（返回取整后的坐标，坐标也非法则为 {x:0,y:0}）。
 *
 * @param {{ x: number, y: number } | null | undefined} pos
 * @param {{ width: number, height: number } | null | undefined} size
 * @param {{ x: number, y: number, width: number, height: number } | null | undefined} workArea
 * @returns {{ x: number, y: number }}
 */
function clampPetPos(pos, size, workArea) {
  const area = validArea(workArea);
  const box = validSize(size);
  const point = pos !== null && typeof pos === 'object' ? pos : {};
  const hasPos = isFiniteNumber(point.x) && isFiniteNumber(point.y);

  if (!area) {
    if (!hasPos) return { x: 0, y: 0 };
    return { x: Math.round(point.x), y: Math.round(point.y) };
  }

  const minX = area.x + MARGIN;
  const minY = area.y + MARGIN;
  const maxX = area.x + area.width - box.width - MARGIN;
  const maxY = area.y + area.height - box.height - MARGIN;

  if (!hasPos) {
    // 未定位：放到左下角（同样留边距）
    return {
      x: Math.round(minX),
      y: Math.round(maxY >= minY ? maxY : minY),
    };
  }

  return {
    x: axis(point.x, minX, maxX),
    y: axis(point.y, minY, maxY),
  };
}

/** 点到 workArea 矩形的最短距离（平方） */
function areaDistanceSq(x, y, area) {
  const dx = x < area.x ? area.x - x : x > area.x + area.width ? x - (area.x + area.width) : 0;
  const dy = y < area.y ? area.y - y : y > area.y + area.height ? y - (area.y + area.height) : 0;
  return dx * dx + dy * dy;
}

/**
 * 选出离该点最近的 workArea（多屏：负坐标/异尺寸屏幕都按真实几何比较）。
 * 与 Electron 的 `screen.getDisplayNearestPoint()` 同义，但输入是纯数据，便于单测。
 *
 * @param {{ x: number, y: number } | null | undefined} pos
 * @param {Array<{ x: number, y: number, width: number, height: number }>} workAreas
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function nearestWorkArea(pos, workAreas) {
  if (!Array.isArray(workAreas) || workAreas.length === 0) return null;
  const point = pos !== null && typeof pos === 'object' ? pos : {};
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return null;

  let best = null;
  let bestDistance = Infinity;
  for (const raw of workAreas) {
    const area = validArea(raw);
    if (!area) continue;
    const distance = areaDistanceSq(point.x, point.y, area);
    if (distance < bestDistance) {
      best = area;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 按「坐标所在的显示器」钳制：坐标有效时用最近的 workArea，坐标缺失/非法时才用 fallbackArea。
 * 这样副屏（包括负坐标屏）上保存的 petPos 重启后不会被拉回主屏。
 *
 * @param {{ x: number, y: number } | null | undefined} pos
 * @param {{ width: number, height: number } | null | undefined} size
 * @param {Array<{ x: number, y: number, width: number, height: number }>} workAreas
 * @param {{ x: number, y: number, width: number, height: number } | null | undefined} fallbackArea
 * @returns {{ x: number, y: number }}
 */
function clampPetPosToNearest(pos, size, workAreas, fallbackArea) {
  const point = pos !== null && typeof pos === 'object' ? pos : {};
  const valid = isFiniteNumber(point.x) && isFiniteNumber(point.y);
  if (!valid) return clampPetPos(null, size, fallbackArea);
  return clampPetPos(point, size, nearestWorkArea(point, workAreas) || fallbackArea);
}

/**
 * 启动时小人窗的落点：有保存坐标就按它所在的显示器钳制，否则放主屏左下角。
 * （main.js 的 petInitialPosition 只是把 screen 的数据喂给这里，逻辑本身可单测）
 *
 * @param {{ x: number, y: number } | null | undefined} savedPos
 * @param {{ width: number, height: number } | null | undefined} size
 * @param {Array<{ x: number, y: number, width: number, height: number }>} workAreas
 * @param {{ x: number, y: number, width: number, height: number } | null | undefined} primaryArea
 * @returns {{ x: number, y: number }}
 */
function initialPetPosition(savedPos, size, workAreas, primaryArea) {
  const point = savedPos !== null && typeof savedPos === 'object' ? savedPos : {};
  const valid = isFiniteNumber(point.x) && isFiniteNumber(point.y);
  return clampPetPosToNearest(valid ? point : null, size, workAreas, primaryArea);
}

module.exports = {
  clampPetPos,
  clampPetPosToNearest,
  initialPetPosition,
  nearestWorkArea,
  validArea,
  MARGIN,
  PET_SIZE,
};
