'use strict';

// 每分钟调度器与静默时段（Spec 8 / Task 8）。
// 只用 Node 标准库；CommonJS。时间一律按本地时区解释，禁止用 toISOString。

const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_IDLE_MINUTES = 10;
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 统一成 Date；无法解析时返回 null，交给调用方决定回落方式 */
function asDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (value === undefined || value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 本地时区的 HH:MM（23:59 与次日 00:00 分属两天） */
function hhmm(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** settings 既接受完整设置，也接受 settings.life（方便调用方） */
function lifeSection(settings) {
  const src = isPlainObject(settings) ? settings : {};
  return isPlainObject(src.life) ? src.life : src;
}

/**
 * 是否处于静默时段。
 * quietFrom/quietTo 用 HH:MM 字符串直接比较：from > to 表示跨夜（如 23:30–08:00），
 * from === to 视为全天静默。字段缺失或格式非法时返回 false（宁可打扰，不误静默）。
 * @param {unknown} settings 完整设置或 settings.life
 * @param {Date|number|string} [now]
 * @returns {boolean}
 */
function isQuiet(settings, now = new Date()) {
  const life = lifeSection(settings);
  const from = life.quietFrom;
  const to = life.quietTo;
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  if (!HHMM_PATTERN.test(from) || !HHMM_PATTERN.test(to)) return false;

  const date = asDate(now);
  if (!date) return false;

  const current = hhmm(date);
  if (from === to) return true;
  if (from < to) return current >= from && current < to;
  // 跨夜：23:30–08:00 → [23:30, 24:00) ∪ [00:00, 08:00)
  return current >= from || current < to;
}

/**
 * 距最后一条用户消息已满 idleMinutes，且期间没有抽取过记忆 → true。
 * - 从来没有用户消息 / 时间无法解析 → false
 * - 时钟回拨（now 早于 lastUserAt）→ false
 * - lastExtractAt 不早于 lastUserAt（刚抽取过）→ false
 * @param {{ lastUserAt?: Date|number|string|null, lastExtractAt?: Date|number|string|null,
 *           now?: Date|number|string, idleMinutes?: number }} [input]
 * @returns {boolean}
 */
function shouldExtractIdle(input = {}) {
  const src = isPlainObject(input) ? input : {};
  const now = asDate(src.now);
  const lastUserAt = asDate(src.lastUserAt);
  if (!now || !lastUserAt) return false;

  const elapsedMs = now.getTime() - lastUserAt.getTime();
  if (elapsedMs < 0) return false;

  const rawIdle = src.idleMinutes;
  const idleMinutes = typeof rawIdle === 'number' && Number.isFinite(rawIdle) && rawIdle >= 0
    ? rawIdle
    : DEFAULT_IDLE_MINUTES;
  if (elapsedMs < idleMinutes * 60000) return false;

  const lastExtractAt = asDate(src.lastExtractAt);
  // 从未抽取过：视为有未抽取内容；抽取时间无法解析也按从未抽取处理
  if (!lastExtractAt) return true;
  return lastExtractAt.getTime() < lastUserAt.getTime();
}

function warn(message, error) {
  const detail = error && error.message ? error.message : String(error);
  console.warn(`[scheduler] ${message}：${detail}`);
}

/**
 * 每分钟 tick 的调度器。
 * tickOnce 返回是否真正执行（重入时直接返回 false）；onTick 抛错或 rejected promise 都被吞掉，不杀循环。
 * @param {{ intervalMs?: number, onTick?: (now: Date) => any, now?: () => Date }} [options]
 * @returns {{ start: () => void, stop: () => void, tickOnce: () => boolean }}
 */
function createScheduler(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const rawInterval = opts.intervalMs;
  const intervalMs = typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 0
    ? rawInterval
    : DEFAULT_INTERVAL_MS;
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();

  let timer = null;
  // 上一次 tick 尚未结算（同步或异步）时为 true，用于重入保护
  let ticking = false;

  function currentTime() {
    const value = now();
    return value instanceof Date ? new Date(value.getTime()) : value;
  }

  function settle() {
    ticking = false;
  }

  function tickOnce() {
    if (ticking) return false;
    ticking = true;

    let result;
    try {
      result = onTick ? onTick(currentTime()) : undefined;
    } catch (error) {
      warn('tick 失败', error);
      settle();
      return true;
    }

    if (result && typeof result.then === 'function') {
      // 两个分支都处理：rejected promise 不会变成 unhandledRejection
      Promise.resolve(result).then(settle, (error) => {
        warn('tick 失败', error);
        settle();
      });
    } else {
      settle();
    }
    return true;
  }

  function start() {
    if (timer) return;
    timer = setInterval(tickOnce, intervalMs);
    // 不让调度器把进程 / 测试挂住
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, tickOnce };
}

module.exports = {
  isQuiet,
  shouldExtractIdle,
  createScheduler,
};
