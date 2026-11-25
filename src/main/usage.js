'use strict';

// 调用记账与后台预算闸门（Spec 5.6 / 8.5）。
// 只用 Node 标准库；CommonJS。读取统一走 store.readJSON 的损坏恢复链，任何情况都不抛。
// 注意：日期归属一律按本地时区，禁止用 toISOString（会按 UTC 跨天）。

const paths = require('./paths');
const store = require('./store');

const PURPOSES = ['chat', 'background', 'embedding'];
const KEEP_DAYS = 60;
const DEFAULT_MAX_BACKGROUND_CALLS_PER_DAY = 24;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 统一成 Date；总是返回新对象，调用方传进来的 Date 不会被就地修改 */
function asDate(value, fallback = new Date()) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date(fallback.getTime()) : new Date(value.getTime());
  }
  if (value === undefined || value === null) return new Date(fallback.getTime());
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(fallback.getTime()) : parsed;
}

/** 本地时区的 YYYY-MM-DD（23:59 与次日 00:00 分属两天） */
function dayKey(date = new Date()) {
  const value = asDate(date);
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

/** 计数与 token 只接受非负有限数字；缺失 / 非数字 / 负数一律按 0 */
function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 一天的空账目（也是对外返回的固定字段集） */
function emptyDay() {
  return { chat: 0, background: 0, embedding: 0, promptTokens: 0, completionTokens: 0 };
}

function normalizeDay(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const day = emptyDay();
  for (const purpose of PURPOSES) day[purpose] = toCount(src[purpose]);
  day.promptTokens = toCount(src.promptTokens);
  day.completionTokens = toCount(src.completionTokens);
  return day;
}

/** 把磁盘内容收敛为 { days: { 'YYYY-MM-DD': DayUsage } }，坏条目直接丢弃 */
function normalizeUsage(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const days = {};
  if (isPlainObject(src.days)) {
    for (const [key, value] of Object.entries(src.days)) {
      if (!DAY_KEY_PATTERN.test(key) || !isPlainObject(value)) continue;
      days[key] = normalizeDay(value);
    }
  }
  return { ...src, days };
}

function readUsage(dir) {
  return normalizeUsage(store.readJSON(paths.usageFile(dir), { days: {} }));
}

/** 兼容上游 usage 的两种命名（llm.js 用 camelCase；OpenAI 原始字段是 snake_case） */
function readTokens(usage) {
  const src = isPlainObject(usage) ? usage : {};
  const pick = (camel, snake) => toCount(src[camel] !== undefined ? src[camel] : src[snake]);
  return {
    promptTokens: pick('promptTokens', 'prompt_tokens'),
    completionTokens: pick('completionTokens', 'completion_tokens'),
  };
}

/**
 * 记一次调用：次数 +1、token 累加；写盘前顺带裁剪到最近 KEEP_DAYS 天。
 * @param {string} dir 数据目录
 * @param {'chat'|'background'|'embedding'} purpose
 * @param {{ promptTokens?: number, completionTokens?: number, prompt_tokens?: number, completion_tokens?: number }} [usage]
 * @param {Date|number|string} [now]
 * @returns {{ chat: number, background: number, embedding: number, promptTokens: number, completionTokens: number }}
 */
function record(dir, purpose, usage, now = new Date()) {
  if (!PURPOSES.includes(purpose)) {
    throw new Error(`未知的用量类型：${JSON.stringify(purpose)}`);
  }

  const key = dayKey(now);
  const data = readUsage(dir);
  const day = normalizeDay(data.days[key]);
  day[purpose] += 1;

  const tokens = readTokens(usage);
  day.promptTokens += tokens.promptTokens;
  day.completionTokens += tokens.completionTokens;

  data.days[key] = day;
  store.writeJSON(paths.usageFile(dir), pruneDays(data, KEEP_DAYS, now));
  return { ...day };
}

/**
 * 读某一天的账目；文件缺失、损坏或没有该天时返回零值。
 * @param {string} dir
 * @param {Date|number|string} [now]
 */
function today(dir, now = new Date()) {
  return normalizeDay(readUsage(dir).days[dayKey(now)]);
}

/** settings 既接受完整设置，也接受 settings.life（方便调用方） */
function maxBackgroundCalls(settings) {
  const src = isPlainObject(settings) ? settings : {};
  const life = isPlainObject(src.life) ? src.life : src;
  const raw = life.maxBackgroundCallsPerDay;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_MAX_BACKGROUND_CALLS_PER_DAY;
}

/**
 * 后台任务是否还能跑：当日 background 次数 < maxBackgroundCallsPerDay。
 * @param {object} settings
 * @param {{ background?: number } | null | undefined} dayUsage
 */
function canRunBackground(settings, dayUsage) {
  return normalizeDay(dayUsage).background < maxBackgroundCalls(settings);
}

/**
 * 当日剩余后台次数（用于设置页「今日后台 5/24 次」）。
 * @param {object} settings
 * @param {{ background?: number } | null | undefined} dayUsage
 */
function remainingBackground(settings, dayUsage) {
  return Math.max(0, maxBackgroundCalls(settings) - normalizeDay(dayUsage).background);
}

/**
 * 只保留最近 keep 天（含 now 当天）；返回新对象，不修改入参。
 * @param {{ days?: object }} usage
 * @param {number} [keep]
 * @param {Date|number|string} [now]
 */
function pruneDays(usage, keep = KEEP_DAYS, now = new Date()) {
  const src = isPlainObject(usage) ? usage : {};
  const days = isPlainObject(src.days) ? src.days : {};
  const keepDays = Number.isInteger(keep) && keep > 0 ? keep : KEEP_DAYS;

  const cutoff = asDate(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (keepDays - 1));
  const cutoffKey = dayKey(cutoff);

  const kept = {};
  for (const key of Object.keys(days)) {
    // YYYY-MM-DD 的字典序即时间序；非日期 key 不认，避免把脏数据永久带下去
    if (DAY_KEY_PATTERN.test(key) && key >= cutoffKey) kept[key] = days[key];
  }
  return { ...src, days: kept };
}

module.exports = {
  dayKey,
  record,
  today,
  canRunBackground,
  pruneDays,
  remainingBackground,
};
