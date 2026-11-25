'use strict';

// 角色状态（心情 / 体力 / 专注），P3 / specs/2026-10-27-life-v2-design.md 1、2.3。
// 只用 Node 标准库；CommonJS。
//
// 约定：
// - 除 readState / writeState 外全部是纯函数：不改入参、不读盘、不依赖时间以外的外部状态。
// - 数值一律整数并夹在 0–100；缺失 / NaN / 非数字回落到默认值。
// - `day` 是本地日期 'YYYY-MM-DD'（禁止用 toISOString 推导，会按 UTC 跨天）。
// - energyCost 正数表示消耗、负数表示恢复（居家事件用它回一点体力）。
// - 每天只结算一次：settleDay 按「跨过几天」逐日套用恢复公式，同一天重复调用不产生变化。

const paths = require('./paths');
const store = require('./store');
const i18n = require('./i18n');

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MOOD_BASELINE = 60;
const FOCUS_BASELINE = 55;
const ENERGY_REST = 35;
const MOOD_RECOVER_RATIO = 1 / 3;
const FOCUS_RECOVER_RATIO = 1 / 3;
// 长时间没开机时最多补结算 7 天：体力反正会回满，避免数值剧烈抖动
const MAX_SETTLE_DAYS = 7;
const CAN_GO_OUT_ENERGY = 30;
const LOW_ENERGY = 35;
const LOW_MOOD = 35;
const LOW_FOCUS = 40;

const DEFAULT_STATE = Object.freeze({
  mood: 62,
  energy: 60,
  focus: 55,
  day: null,
  updatedAt: null,
  weather: null,
});

// 聊天情绪粗判（零成本本地规则，只用于 ±2 的心情微调）
const NEGATIVE_CHAT_RE = /(难过|不开心|心情不好|好烦|烦死|烦死了|好累|累死|难受|想哭|哭了|生气|失望|焦虑|压力大|崩溃|失眠|孤独|委屈|emo)/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 统一成 Date；非法 / 缺失时用 fallback（总是返回新对象，不改入参） */
function asDate(value, fallback = new Date()) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date(fallback.getTime()) : new Date(value.getTime());
  }
  if (value === undefined || value === null) return new Date(fallback.getTime());
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(fallback.getTime()) : parsed;
}

/** 本地时区的 YYYY-MM-DD */
function dayKey(date = new Date()) {
  const value = asDate(date);
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function localDateFromKey(key) {
  const m = DAY_KEY_PATTERN.exec(clean(key));
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 本地时区的 ISO 时间串（与 chat.jsonl / timeline 一致） */
function localISOString(date = new Date()) {
  const value = asDate(date);
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
    + `T${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** 取 0–100 的整数；缺失 / 非法回落到 fallback */
function clampScore(value, fallback) {
  const number = toNumber(value);
  if (number === null) return fallback;
  return clamp(Math.round(number), 0, 100);
}

function numberOrZero(value) {
  const number = toNumber(value);
  return number === null ? 0 : Math.round(number);
}

/** day 字段：合法的本地日期就保留，否则用 now 当天 */
function dayValue(value, now) {
  const key = clean(value);
  if (DAY_KEY_PATTERN.test(key) && localDateFromKey(key)) return key;
  return dayKey(now);
}

/**
 * 归一化状态：补齐字段、夹到 0–100、day 用本地日期。
 * @param {unknown} raw
 * @param {Date|string|number} [now]
 * @returns {{ mood: number, energy: number, focus: number, day: string,
 *             updatedAt: string|null, weather: object|null }}
 */
function normalizeState(raw, now = new Date()) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    mood: clampScore(src.mood, DEFAULT_STATE.mood),
    energy: clampScore(src.energy, DEFAULT_STATE.energy),
    focus: clampScore(src.focus, DEFAULT_STATE.focus),
    day: dayValue(src.day, now),
    updatedAt: clean(src.updatedAt) || null,
    weather: isPlainObject(src.weather) ? { ...src.weather } : null,
  };
}

/**
 * 跨天结算（幂等）。
 * - 同一天 / 时钟回拨：只把 day 收敛到今天，数值不变；
 * - 每跨一天：energy +35（上限 100），mood 向 60 回归 1/3，focus 向 55 回归 1/3；
 * - 首次使用（day 缺失）：只写入当天，不做恢复。
 * @param {unknown} state
 * @param {Date|string|number} [now]
 * @returns {object} 新状态对象
 */
function settleDay(state, now = new Date()) {
  const current = asDate(now);
  const today = dayKey(current);
  const src = isPlainObject(state) ? state : {};
  const rawDay = clean(src.day);
  const normalized = normalizeState(src, current);

  if (!DAY_KEY_PATTERN.test(rawDay) || !localDateFromKey(rawDay)) {
    return { ...normalized, day: today, updatedAt: localISOString(current) };
  }
  if (rawDay === today) return normalized;
  if (rawDay > today) return { ...normalized, day: today };

  const from = localDateFromKey(rawDay);
  const to = localDateFromKey(today);
  const gap = Math.max(
    1,
    Math.min(MAX_SETTLE_DAYS, Math.round((to.getTime() - from.getTime()) / 86400000)),
  );

  let { mood, energy, focus } = normalized;
  for (let index = 0; index < gap; index += 1) {
    energy = clamp(energy + ENERGY_REST, 0, 100);
    mood = clamp(Math.round(mood + (MOOD_BASELINE - mood) * MOOD_RECOVER_RATIO), 0, 100);
    focus = clamp(Math.round(focus + (FOCUS_BASELINE - focus) * FOCUS_RECOVER_RATIO), 0, 100);
  }

  return {
    ...normalized,
    mood,
    energy,
    focus,
    day: today,
    updatedAt: localISOString(current),
  };
}

/**
 * 事件对状态的影响：energyCost 正数扣体力，负数恢复体力。
 * @param {unknown} state
 * @param {{ energyCost?: number, moodDelta?: number, focusDelta?: number,
 *           now?: Date|string|number }} [effect]
 * @returns {object} 新状态对象
 */
function applyEvent(state, {
  energyCost = 0, moodDelta = 0, focusDelta = 0, now = new Date(),
} = {}) {
  const current = asDate(now);
  const normalized = normalizeState(state, current);
  return {
    ...normalized,
    energy: clamp(normalized.energy - numberOrZero(energyCost), 0, 100),
    mood: clamp(normalized.mood + numberOrZero(moodDelta), 0, 100),
    focus: clamp(normalized.focus + numberOrZero(focusDelta), 0, 100),
    updatedAt: localISOString(current),
  };
}

/**
 * 聊天后的微调：正面 +2 心情、-1 体力；负面 -2 心情。
 * @param {unknown} state
 * @param {{ positive?: boolean, now?: Date|string|number }} [input]
 * @returns {object} 新状态对象
 */
function applyChat(state, { positive = true, now = new Date() } = {}) {
  return applyEvent(state, positive
    ? { energyCost: 1, moodDelta: 2, now }
    : { moodDelta: -2, now });
}

/** 一句话状态描述（供提示词 / 设置页用，不出现数值） */
function describeState(state) {
  const s = normalizeState(state);
  const energyPart = s.energy < LOW_ENERGY
    ? '有点累'
    : s.energy >= 75
      ? '精神很好'
      : '体力还行';
  const moodPart = s.mood < LOW_MOOD
    ? '心情不太好'
    : s.mood >= 70
      ? '心情不错'
      : '心情还行';
  const focusPart = s.focus < LOW_FOCUS
    ? '，有点走神'
    : s.focus >= 75
      ? '，挺专注的'
      : '';
  if (i18n.getLanguage() === 'en') {
    const text = `${i18n.t(energyPart)}, ${i18n.t(moodPart)}${focusPart ? i18n.t(focusPart) : ''}`;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return `${energyPart}，${moodPart}${focusPart}`;
}

/** 体力够不够出门 */
function canGoOut(state) {
  return normalizeState(state).energy >= CAN_GO_OUT_ENERGY;
}

/** 聊天情绪粗判：命中明显负面词返回 false（负面情绪） */
function isPositiveChat(text) {
  return !NEGATIVE_CHAT_RE.test(clean(text));
}

/** 两份状态在关键字段上是否一致（用于避免重复落盘） */
function sameState(a, b) {
  const left = normalizeState(a);
  const right = normalizeState(b);
  return left.mood === right.mood
    && left.energy === right.energy
    && left.focus === right.focus
    && left.day === right.day
    && left.updatedAt === right.updatedAt;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function safeIdOrNull(id) {
  const value = String(id === undefined || id === null ? '' : id);
  if (!value || !SAFE_ID_PATTERN.test(value) || value.endsWith('.')) return null;
  return value;
}

/**
 * 读状态：文件缺失 / 损坏 / id 非法一律返回默认状态（不抛）。
 * @param {string} dir 数据目录
 * @param {string} characterId
 * @param {Date|string|number} [now]
 * @returns {object}
 */
function readState(dir, characterId, now = new Date()) {
  const id = safeIdOrNull(characterId);
  if (typeof dir !== 'string' || !dir || !id) return normalizeState(DEFAULT_STATE, now);
  let raw = null;
  try {
    raw = store.readJSON(paths.stateFile(dir, id), null);
  } catch (error) {
    console.warn(`[state] 读取状态失败，按默认值处理：${error && error.message ? error.message : error}`);
  }
  return normalizeState(isPlainObject(raw) ? raw : DEFAULT_STATE, now);
}

/**
 * 写状态（store 原子写）。id 非法时抛错，与 store.writeTimeline 一致。
 * @param {string} dir
 * @param {string} characterId
 * @param {unknown} state
 * @param {Date|string|number} [now]
 * @returns {object} 实际写入的归一化状态
 */
function writeState(dir, characterId, state, now = new Date()) {
  const id = safeIdOrNull(characterId);
  if (!id) throw new Error(`非法角色 id：${JSON.stringify(characterId)}`);
  const value = normalizeState(state, now);
  store.writeJSON(paths.stateFile(dir, id), value);
  return value;
}

module.exports = {
  DEFAULT_STATE,
  MOOD_BASELINE,
  FOCUS_BASELINE,
  ENERGY_REST,
  CAN_GO_OUT_ENERGY,
  normalizeState,
  settleDay,
  applyEvent,
  applyChat,
  describeState,
  canGoOut,
  isPositiveChat,
  sameState,
  readState,
  writeState,
  // 便于其他模块 / 测试复用
  dayKey,
  localISOString,
};
