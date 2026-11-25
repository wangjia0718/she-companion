'use strict';

// 过日子引擎（Spec 8 / 计划 Task 7）：每日日程、事件推进、日记、主动消息决策。
// 只用 Node 标准库；CommonJS。
//
// 约定：
// - 日期归属一律按本地时区（禁止 toISOString 切天）。
// - day 结构 = timeline.days['YYYY-MM-DD']，除 Spec 5.4 的字段外新增
//   proactive: { boot, event, idle }，记录三个主动触发源当天是否已用。
// - 事件推进与主动消息的模板兜底都是纯本地行为，0 token；后台预算不足或模型失败
//   一律静默降级，不向调用方抛错。
// - runProactive 会把 day.proactive[trigger] 置 true（就地改传入的 day 对象），
//   调用方负责把该 day 写回 timeline；日程与日记的落盘由本模块完成。

const store = require('./store');
const llm = require('./llm');
const prompt = require('./prompt');
const usage = require('./usage');
const persona = require('./persona');
const activity = require('./activity');
const projectsEngine = require('./projects');
const stateEngine = require('./state');
const calendar = require('./calendar');
const weatherEngine = require('./weather');
const i18n = require('./i18n');
const content = require('./content');
const { isQuiet } = require('./scheduler');

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCHEDULE_START = '06:00';
const SCHEDULE_END = '23:59';
const SCHEDULE_MIN_ITEMS = 3;
const SCHEDULE_MAX_ITEMS = 5;
// 生日当天在生成日程后额外补一条；P4 节日也会多一条，上限放宽到 7 条
const BIRTHDAY_TIME = '19:30';
const BIRTHDAY_ACTIVITY = '给自己做点特别的（生日）';
const SCHEDULE_MAX_WITH_BIRTHDAY = SCHEDULE_MAX_ITEMS + 2;
// P5：有进行中的长期项目时，晚间再补一条推进项目的活动；最多 6 条
const SCHEDULE_MAX_WITH_PROJECT = SCHEDULE_MAX_ITEMS + 1;

const DEFAULT_PROACTIVE_PER_DAY = 1;
// 每周主动消息次数范围可设 0–63；63 = 7 天 × 每天最多 9 条（受可用触发源限制）
const DEFAULT_PROACTIVE_WEEK_MIN = 0;
const DEFAULT_PROACTIVE_WEEK_MAX = 10;
const PROACTIVE_WEEK_SETTING_MAX = 63;
const PROACTIVE_PLAN_VERSION = 5;
// 主动消息可以排在她当天的任意空闲时段；静默时段不发
const PROACTIVE_FREE_MIN_WINDOW = 30;
// 单条主动消息之间至少隔 3 小时；同一天排多条时缩到 30 分钟
const PROACTIVE_MIN_GAP_MINUTES = 180;
const PROACTIVE_MULTI_GAP_MINUTES = 30;
// 单日上限 9 条：受可用触发源数量限制（生日 / 节日 / 项目 / 天气 / 回访 / 睡前 / 开机 / 事件 / 久未联系）
const PROACTIVE_BASE_DAILY_CAP = 3;
const PROACTIVE_MAX_DAILY_CAP = 9;
// 主动消息只在日程空档里挑时间：每个空档至少 60 分钟，落点后 30 分钟内有效
const PROACTIVE_SLOT_MIN_WINDOW = 60;
const PROACTIVE_SLOT_GRACE_MINUTES = 30;
const DEFAULT_BOOT_DELAY_MINUTES = 10;
// 「刚开机 / 刚醒」只在她一天开始时成立；中午以后不再用它当问候
const BOOT_EARLIEST_HOUR = 5;
const BOOT_LATEST_HOUR = 12;
// 开机问候只在启动后 2 小时内有效，避免排到下午还说「刚开机」
const BOOT_WINDOW_MINUTES = 120;
const DEFAULT_EVENT_WINDOW_MINUTES = 3;
const DEFAULT_IDLE_HOURS = 6;
const MAX_PROACTIVE_CHARS = 40;
// P7：表达维度 → 主动消息「少而短」
const EXPRESSIVE_LOW_CUT = 30;
const EXPRESSIVE_HIGH_CUT = 70;
const LOW_EXPRESSIVE_CHARS = 28;
const MID_EXPRESSIVE_CHARS = 34;
const DIARY_MIN_CHARS = 100;
const DIARY_MAX_CHARS = 180;
// 日程自检：只输出与原日程同构的 JSON 数组，1200 足够
const SCHEDULE_REVIEW_MAX_TOKENS = 3000;
// P6：睡前提醒窗口（静默开始前 30 分钟内）与体力门槛
const BEDTIME_WINDOW_MINUTES = 30;
const BEDTIME_MAX_ENERGY = 60;

const PROACTIVE_TRIGGERS = [
  'boot', 'event', 'idle',
  'bedtime', 'holiday', 'birthday', 'followup', 'project', 'weather',
  // 兜底：以上都不成立（比如从没聊过天、当天也没排到事件）时，随口分享一句自己的状态
  'life',
];

// P6 优先级：生日 > 节日 > 项目完成 > 天气突变 > 隔天回访 > 睡前 > 开机 > 事件 > 久未联系
const PROACTIVE_PRIORITY = [
  'birthday', 'holiday', 'project', 'weather', 'followup', 'bedtime', 'boot', 'event', 'idle', 'life',
];
const MOODS = ['平静', '专注', '有点懒', '开心', '安静', '疲惫'];

// 事件模板：内容在 src/main/content/event-templates.json。
// 事件推进按 (seed + mood 偏移) 轮转，同一 seed / mood 输出稳定。
const EVENT_TEMPLATES = content.eventTemplates;

// 主动消息的模板兜底（模型失败 / 预算不足时用）。每条都 ≤40 字。
// P6：新触发源各至少 2 条；除 bedtime 外不含「今晚 / 晚安 / 早点睡」这类夜间用语。
const PROACTIVE_FALLBACKS = content.proactiveFallbacks;

// 事件对状态的影响（P3）：按活动类别给体力 / 心情 / 专注的小幅变化。
// energyCost 正数扣体力；负数表示居家类活动「回一点体力」。
const EVENT_STATE_EFFECTS = {
  home: { energyCost: -3, moodDelta: 1 },
  chore: { energyCost: 3 },
  selfcare: { energyCost: 1, moodDelta: 2 },
  discovery: { energyCost: 1, moodDelta: 2 },
  create: { energyCost: 5, moodDelta: 1, focusDelta: 3 },
  work: { energyCost: 6, focusDelta: -3 },
  solo_out: { energyCost: 9, moodDelta: 2 },
  crowd: { energyCost: 12, moodDelta: 2, focusDelta: -3 },
  social: { energyCost: 14, moodDelta: 3, focusDelta: -2 },
  visit: { energyCost: 8, moodDelta: 2 },
  project: { energyCost: 3, moodDelta: 1, focusDelta: 2 },
};

/**
 * 某类事件对状态的固定影响（纯函数，未知类别返回 {}）。
 * @param {string} [category]
 * @returns {{ energyCost?: number, moodDelta?: number, focusDelta?: number }}
 */
function eventStateEffect(category) {
  const key = clean(category);
  return EVENT_STATE_EFFECTS[key] ? { ...EVENT_STATE_EFFECTS[key] } : {};
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fillTemplate(template, values = {}) {
  return String(template).replace(/\{(\w+)\}/g, (all, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : all
  ));
}

function asList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }
  const text = clean(value);
  return text ? [text] : [];
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function warn(message, error) {
  const detail = error && error.message ? error.message : '';
  console.warn(`[life] ${message}${detail ? `：${detail}` : ''}`);
}

/** settings 既接受完整设置，也接受 settings.life（方便调用方） */
function lifeSection(settings) {
  const src = isPlainObject(settings) ? settings : {};
  return isPlainObject(src.life) ? src.life : src;
}

/** 统一成 Date；无法解析时返回 null，由调用方决定回落方式 */
function toDateOrNull(value) {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** now 参数兜底：非法/缺失时用当前时间 */
function asDate(value) {
  return toDateOrNull(value) || new Date();
}

function dayKey(date = new Date()) {
  const value = asDate(date);
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

/** 'YYYY-MM-DD' → 本地 Date；格式不对返回 null */
function localDateFromKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(key));
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function hhmm(date) {
  const value = asDate(date);
  return `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
}

function minutesOfDay(date) {
  const value = asDate(date);
  return value.getHours() * 60 + value.getMinutes();
}

/** 本地时区的 ISO 时间串（与 chat.jsonl 其它消息一致，带 +08:00 这类偏移） */
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

function charLength(text) {
  return Array.from(text).length;
}

function hashString(text) {
  let hash = 0;
  for (const ch of String(text)) {
    hash = (hash * 31 + ch.codePointAt(0)) % 1000003;
  }
  return Math.abs(hash);
}

function normalizeProactive(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const flags = {};
  for (const trigger of PROACTIVE_TRIGGERS) flags[trigger] = src[trigger] === true;
  return flags;
}

function countUsedProactive(flags) {
  return PROACTIVE_TRIGGERS.reduce((sum, key) => sum + (flags[key] ? 1 : 0), 0);
}

/** 距离上一条主动消息是否已经超过最小间隔（单条 3 小时；同一天多条 30 分钟） */
function proactiveGapOk(day, now) {
  const lastAt = toDateOrNull(isPlainObject(day) ? day.lastProactiveAt : null);
  if (!lastAt) return true;
  const plan = isPlainObject(day) && isPlainObject(day.proactivePlan) ? day.proactivePlan : null;
  const multi = plan && Array.isArray(plan.slots) && plan.slots.length > 1;
  const minGap = multi ? PROACTIVE_MULTI_GAP_MINUTES : PROACTIVE_MIN_GAP_MINUTES;
  const current = asDate(now);
  return current.getTime() - lastAt.getTime() >= minGap * 60000;
}

function timeMinutes(text) {
  const src = clean(text);
  if (!HHMM_PATTERN.test(src)) return null;
  return Number(src.slice(0, 2)) * 60 + Number(src.slice(3, 5));
}

/** 日程里两件事之间的空档；每件事按「前 30 分钟 + 后 60 分钟」算忙 */
function freeWindows(day, settings) {
  const life = lifeSection(settings);
  const start = timeMinutes(life.quietTo) ?? 8 * 60;
  const end = timeMinutes(life.quietFrom) ?? 23 * 60 + 30;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const busy = normalizeScheduleList(day && day.schedule)
    .map((item) => timeMinutes(item.time))
    .filter((value) => value !== null)
    .map((value) => [value - 30, value + 60])
    .sort((a, b) => a[0] - b[0]);

  const windows = [];
  let cursor = start;
  for (const [from, to] of busy) {
    const left = Math.max(start, from);
    const right = Math.min(end, to);
    if (right <= start || left >= end) continue;
    if (left > cursor) windows.push([cursor, left]);
    cursor = Math.max(cursor, right);
  }
  if (cursor < end) windows.push([cursor, end]);
  return windows.filter(([from, to]) => to - from >= PROACTIVE_SLOT_MIN_WINDOW);
}

/** 某天所在周的周一（本地时区） */
function weekStartDate(dateText) {
  const date = localDateFromKey(dateText) || asDate(dateText);
  const offset = (date.getDay() + 6) % 7; // 周一 = 0
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** 每周主动消息次数范围：0–63；缺省或非法时用默认范围 */
function proactiveWeekRange(settings) {
  const life = lifeSection(settings);
  const toInt = (value, fallback) => {
    const number = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value.trim())
        : Number.NaN;
    return Number.isFinite(number)
      ? Math.max(0, Math.min(PROACTIVE_WEEK_SETTING_MAX, Math.floor(number)))
      : fallback;
  };
  const min = toInt(life.proactiveWeekMin, DEFAULT_PROACTIVE_WEEK_MIN);
  const max = toInt(life.proactiveWeekMax, DEFAULT_PROACTIVE_WEEK_MAX);
  return { min: Math.min(min, max), max };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/** 文案里的关系描述：认识很久 / 亲密加分，刚认识 / 疏远减分 */
function relationshipTextScore(character) {
  const c = isPlainObject(character) ? character : {};
  const personaSrc = isPlainObject(c.persona) ? c.persona : {};
  const text = clean(personaSrc.relationship);
  let score = 0.5;
  if (/(很熟|认识很久|老朋友|多年|亲密|亲近|恋人|爱人|家人|无话不谈|互相照应|依赖|信任)/u.test(text)) {
    score += 0.25;
  }
  if (/(刚认识|不熟|陌生|冷淡|疏远|客气|普通朋友|同事|点头之交|不太联系)/u.test(text)) {
    score -= 0.25;
  }
  return clamp01(score);
}

/** 对话历史：聊得越多、持续越久、最近越常来，关系分越高 */
function historyCloseness(dir, character, now) {
  const messages = readRecentMessages(dir, character, 500);
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let userCount = 0;
  const activeDays = new Set();
  let lastUserAt = null;
  for (const message of messages) {
    if (!isPlainObject(message) || message.role !== 'user') continue;
    userCount += 1;
    const at = toDateOrNull(message.ts);
    if (!at) continue;
    activeDays.add(dayKey(at));
    if (!lastUserAt || at.getTime() > lastUserAt.getTime()) lastUserAt = at;
  }
  if (userCount === 0) return 0;

  const current = asDate(now);
  const volume = Math.min(1, userCount / 100);
  const continuity = Math.min(1, activeDays.size / 14);
  const recency = lastUserAt
    ? clamp01(1 - Math.max(0, current.getTime() - lastUserAt.getTime()) / 86400000 / 14)
    : 0;
  const created = toDateOrNull(character && character.createdAt);
  const age = created
    ? clamp01((current.getTime() - created.getTime()) / 86400000 / 30)
    : 0;
  return clamp01(0.45 * volume + 0.25 * continuity + 0.20 * recency + 0.10 * age);
}

/**
 * 主动消息倾向 0–1：
 * 表达欲 / 社交 / 节奏（性格）+ 关系文案 / 对话历史（亲密）+ 当前心情 / 体力。
 * 越低越容易随机到小次数，越高越容易随机到大次数。
 */
function proactiveAffinity(character, dir, state, now) {
  const profile = fiveDimProfile(character);
  const expressiveness = scoreOf(profile && profile.expressiveness) / 100;
  const social = scoreOf(profile && profile.social) / 100;
  const pace = scoreOf(profile && profile.pace) / 100;
  const personality = clamp01(0.55 * expressiveness + 0.35 * social + 0.10 * pace);
  const relationship = clamp01(
    0.65 * relationshipTextScore(character) + 0.35 * historyCloseness(dir, character, now),
  );
  const stateScore = isPlainObject(state)
    ? clamp01(0.65 * scoreOf(state.mood) / 100 + 0.35 * scoreOf(state.energy) / 100)
    : 0.5;
  return clamp01(0.55 * personality + 0.30 * relationship + 0.15 * stateScore);
}

/** 生日 / 节日当天强制选为主动日，避免特殊日子被随机漏掉 */
function isSpecialProactiveDay(character, date) {
  if (birthdayToday(character, date)) return true;
  const holiday = calendar.holidayOf(date);
  return !!(holiday && holiday.name);
}

/** 本周已经发过多少条主动消息（同一天可能多条，按触发源标记计数） */
function proactiveSentCountForWeek(timeline, start) {
  if (!isPlainObject(timeline) || !isPlainObject(timeline.days)) return 0;
  let count = 0;
  for (let index = 0; index < 7; index += 1) {
    const key = dayKey(addDays(start, index));
    const flags = normalizeProactive(timeline.days[key] && timeline.days[key].proactive);
    count += countUsedProactive(flags);
  }
  return count;
}

/** 读本周已存的主动计划；版本 / 范围不一致时视为过期（次数以已存值为准，周内不重掷） */
function storedWeekPlan(timeline, weekKey, start, min, max) {
  if (!isPlainObject(timeline) || !isPlainObject(timeline.proactiveWeeks)) return null;
  const plan = timeline.proactiveWeeks[weekKey];
  if (!isPlainObject(plan) || plan.version !== PROACTIVE_PLAN_VERSION || !isPlainObject(plan.days)) return null;
  if (plan.min !== min || plan.max !== max) return null;
  if (!Number.isInteger(plan.count) || plan.count < min || plan.count > max) return null;
  const end = addDays(start, 7);
  for (const [date, times] of Object.entries(plan.days)) {
    const parsed = localDateFromKey(date);
    if (!parsed || parsed < start || parsed >= end) return null;
    if (!Number.isInteger(times) || times < 0) return null;
  }
  return plan;
}

/** 线性同余伪随机：同一 seed 输出稳定，保证同一周的计划不随 tick 抖动 */
function seededRandom(seedText) {
  let state = calendar.hashString(String(seedText)) || 1;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * 把本周剩余次数随机分到日期上（不做平均分配）。
 * - 先随机决定要占用几天：次数少时可能只占一两天，某天连发多条；
 * - 再把剩余次数随机加到这些天，单日不超过当天上限；
 * - 生日 / 节日固定先占 1 条。
 * 单日上限按整周总量放大：≤21 条时 3 条/天，63 条时 9 条/天。
 */
function distributeWeeklyCount(count, candidates, seed, weeklyTotal) {
  const pool = Array.isArray(candidates) ? candidates : [];
  if (count <= 0 || pool.length === 0) return new Map();

  const total = Number.isInteger(weeklyTotal) && weeklyTotal > 0 ? weeklyTotal : count;
  const dailyCap = Math.min(
    PROACTIVE_MAX_DAILY_CAP,
    Math.max(PROACTIVE_BASE_DAILY_CAP, Math.ceil(total / 7)),
  );
  const random = seededRandom(`${seed}|distribute|${count}`);

  const counts = new Map();
  const special = pool
    .filter((item) => item.special)
    .sort((a, b) => Number(b.birthday) - Number(a.birthday) || a.offset - b.offset)
    .slice(0, Math.min(count, pool.length));
  for (const item of special) counts.set(item.offset, 1);

  // 用最少天数 / 最多天数夹住，再随机取一个；次数 ≤7 时偏向少几天
  const minDays = Math.max(counts.size, Math.ceil(count / dailyCap));
  const maxDays = Math.min(pool.length, count);
  let dayCount = minDays;
  if (maxDays > minDays) {
    const span = maxDays - minDays + 1;
    // 次数少时明显偏向「少几天、某天多条」；次数多时再铺开
    const bias = count <= 7 ? 2.5 : count <= 14 ? 1.4 : 1;
    dayCount = minDays + Math.floor(Math.pow(random(), bias) * span);
  }
  dayCount = Math.max(counts.size, Math.min(pool.length, dayCount));

  // 随机补足要占用的普通日期
  const rest = pool.filter((item) => !counts.has(item.offset));
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  for (const item of rest) {
    if (counts.size >= dayCount) break;
    counts.set(item.offset, 1);
  }

  // 剩余次数随机加到还没到单日上限的日期上
  let remaining = count - [...counts.values()].reduce((sum, times) => sum + times, 0);
  const offsets = [...counts.keys()];
  while (remaining > 0) {
    const open = offsets.filter((offset) => (counts.get(offset) || 0) < dailyCap);
    if (open.length === 0) break;
    const pick = open[Math.floor(random() * open.length)];
    counts.set(pick, (counts.get(pick) || 0) + 1);
    remaining -= 1;
  }
  return counts;
}

/**
 * 本周主动计划：在设置范围内按性格 / 关系加权取一个总次数，存到
 * timeline.proactiveWeeks 里，整周固定；周中才启动时只从今天往后排，
 * 并把本周已经发过的条数扣掉。生日 / 节日优先占用名额。
 */
function weeklyProactivePlan(character, settings, dateText, timeline, now, context = {}) {
  const start = weekStartDate(dateText);
  const weekKey = dayKey(start);
  const { min, max } = proactiveWeekRange(settings);
  const current = localDateFromKey(dateText) || asDate(now);
  const index = (current.getDay() + 6) % 7;
  const todayKey = dayKey(current);
  const sent = proactiveSentCountForWeek(timeline, start);

  // 先读本周已存计划：周内状态 / 聊天变化不再重掷次数，保证整周固定
  const stored = storedWeekPlan(timeline, weekKey, start, min, max);
  if (stored) {
    const planned = Object.values(stored.days).reduce((sum, times) => sum + times, 0);
    const storedAffinity = Number.isFinite(stored.affinity) ? stored.affinity / 100 : 0.5;
    return {
      weekKey, min, max, count: stored.count, sent, planned,
      dayCount: stored.days[todayKey] || 0, index, affinity: storedAffinity,
    };
  }

  const seed = `${weekKey}|${(character && character.id) || 'x'}`;
  const affinity = proactiveAffinity(character, context.dir, context.state, now);
  const roll = calendar.hashString(
    `${seed}|week-count|${min}|${max}|${Math.round(affinity * 1000)}`,
  ) / 1000003;
  // 倾向越低，幂次越大，随机结果越靠小次数；倾向越高越靠大次数
  const gamma = 2.8 - 2.6 * affinity;
  const count = min + Math.round(Math.pow(roll, gamma) * (max - min));

  const todayUsed = countUsedProactive(
    normalizeProactive(
      timeline && isPlainObject(timeline.days)
        ? timeline.days[todayKey] && timeline.days[todayKey].proactive
        : null,
    ),
  ) > 0;
  // 今天已经发过就把剩余名额留给明天，避免把名额又算在已经发过的今天上
  const firstIndex = todayUsed ? index + 1 : index;
  const candidates = [];
  for (let offset = firstIndex; offset < 7; offset += 1) {
    const date = addDays(start, offset);
    candidates.push({
      offset,
      date: dayKey(date),
      birthday: birthdayToday(character, date),
      special: isSpecialProactiveDay(character, date),
    });
  }
  const remaining = Math.max(0, count - sent);
  const counts = distributeWeeklyCount(remaining, candidates, seed, count);
  const days = {};
  for (const [offset, times] of counts) {
    if (times > 0) days[dayKey(addDays(start, offset))] = times;
  }
  const planned = Object.values(days).reduce((sum, times) => sum + times, 0);
  const plan = {
    version: PROACTIVE_PLAN_VERSION,
    generatedAt: localISOString(now),
    start: weekKey,
    min,
    max,
    count,
    affinity: Math.round(affinity * 100),
    planned,
    days,
  };
  if (isPlainObject(timeline)) {
    if (!isPlainObject(timeline.proactiveWeeks)) timeline.proactiveWeeks = {};
    timeline.proactiveWeeks[weekKey] = plan;
  }

  return {
    weekKey, min, max, count, sent, planned, dayCount: days[todayKey] || 0, index, affinity,
  };
}

/** 当天的空闲时段：静默时段之外、没有日程安排的时间（活动前后各有缓冲） */
function proactiveFreeWindows(day, settings) {
  return freeWindows(day, settings)
    .filter(([from, to]) => to - from >= PROACTIVE_FREE_MIN_WINDOW);
}

/**
 * 单条时优先落在静默前 90 分钟（通常 22:00）；这个时间不在空档里时，
 * 退到当天最后一段空档的末尾。全天空闲的角色仍然会偏向晚一点。
 */
function proactiveSlotMinutes(day, settings) {
  const windows = proactiveFreeWindows(day, settings);
  if (windows.length === 0) return null;
  const quietFrom = timeMinutes(lifeSection(settings).quietFrom) ?? 23 * 60 + 30;
  const preferred = quietFrom - 90;
  for (const [from, to] of windows) {
    if (preferred >= from + 5 && preferred <= to - 5) {
      return Math.round(preferred / 5) * 5;
    }
  }
  const [from, to] = windows[windows.length - 1];
  let at = Math.max(from + 5, to - 10);
  at = Math.round(at / 5) * 5;
  return Math.max(from + 5, Math.min(to - 5, at));
}

function nextUsableAtOrAfter(minutes, windows) {
  for (const [from, to] of windows) {
    if (minutes <= from) return from;
    if (minutes <= to) return minutes;
  }
  return null;
}

/**
 * 当天的主动时间点：只在她的空档里排，每条至少隔 30 分钟。
 * 单条时用固定的晚间偏好；多条时把全天可用空档均分，空档不够就按上限截断。
 *
 * now 只在「当天」传进来：晚上才第一次算计划时，21:30 这种已经过去的点不能再排，
 * 否则当天永远发不出去（过了 30 分钟宽限就作废）。
 */
function proactiveSlotMinutesList(day, settings, count, now = null) {
  const wanted = Number.isInteger(count) ? count : 0;
  if (wanted <= 0) return [];
  const windows = proactiveFreeWindows(day, settings);
  if (windows.length === 0) return [];

  const current = now ? asDate(now) : null;
  const nowMinutes = current ? current.getHours() * 60 + current.getMinutes() : null;
  const floor = nowMinutes === null ? null : nowMinutes + 5;

  if (wanted === 1) {
    const one = proactiveSlotMinutes(day, settings);
    if (one === null) return [];
    if (floor === null || one >= floor) return [one];
    // 已经过了：顺延到今天还剩下的最早空档（空档都没了就今天不发）
    const shifted = nextUsableAtOrAfter(floor, windows);
    return shifted === null ? [] : [Math.round(shifted / 5) * 5];
  }

  const margin = 10;
  const usable = windows
    .map(([from, to]) => [from + margin, to - margin])
    .filter(([from, to]) => to > from);
  if (usable.length === 0) return [];
  const total = usable.reduce((sum, [from, to]) => sum + (to - from), 0);
  const maxSlots = Math.min(
    PROACTIVE_MAX_DAILY_CAP,
    PROACTIVE_TRIGGERS.length,
    Math.max(1, Math.floor(total / PROACTIVE_MULTI_GAP_MINUTES) + 1),
  );
  const slots = Math.min(wanted, maxSlots);
  if (slots <= 1) {
    const one = proactiveSlotMinutes(day, settings);
    return one === null ? [] : [one];
  }

  const result = [];
  for (let index = 0; index < slots; index += 1) {
    const target = (index + 0.5) * total / slots;
    let acc = 0;
    let raw = null;
    for (const [from, to] of usable) {
      const span = to - from;
      if (target < acc + span) {
        raw = from + (target - acc);
        break;
      }
      acc += span;
    }
    if (raw === null) continue;
    let at = nextUsableAtOrAfter(Math.round(raw / 5) * 5, usable);
    if (at === null) continue;
    const previous = result[result.length - 1];
    if (previous !== undefined && at - previous < PROACTIVE_MULTI_GAP_MINUTES) {
      at = nextUsableAtOrAfter(previous + PROACTIVE_MULTI_GAP_MINUTES, usable);
    }
    if (at === null || (previous !== undefined && at <= previous)) continue;
    if (!result.includes(at)) result.push(at);
  }
  // 目标条数接近当晚上限时，中点法可能因 30 分钟间隔的取整少排一条；
  // 退化为「从最早空档开始、按 30 分钟顺排」，保证能排满。
  if (result.length < slots) {
    const filled = [];
    for (const [from] of usable) {
      let cursor = from;
      while (filled.length < slots) {
        const at = nextUsableAtOrAfter(cursor, usable);
        if (at === null) break;
        const previous = filled[filled.length - 1];
        if (previous === undefined || at - previous >= PROACTIVE_MULTI_GAP_MINUTES) {
          filled.push(at);
          cursor = at + PROACTIVE_MULTI_GAP_MINUTES;
        } else {
          cursor = previous + PROACTIVE_MULTI_GAP_MINUTES;
        }
      }
      if (filled.length >= slots) break;
    }
    if (filled.length > result.length) {
      return floor === null ? filled : filled.filter((at) => at >= floor);
    }
  }
  return floor === null ? result : result.filter((at) => at >= floor);
}

/**
 * 给当天排主动消息：本周目标次数已按性格 / 关系加权取好，再按日期分配。
 * 同一天可能排多条；只落在她当天的空闲时段（静默时段除外）。按周 + 角色固定，不随 tick 抖动。
 */
function ensureProactivePlan(day, character, settings, dateText, now, timeline, context = {}) {
  if (!isPlainObject(day)) return null;
  const date = typeof dateText === 'string' && dateText ? dateText : dayKey(now);
  const week = weeklyProactivePlan(character, settings, date, timeline, now, context);

  const plan = isPlainObject(day.proactivePlan) && Array.isArray(day.proactivePlan.slots)
    ? day.proactivePlan
    : null;
  if (
    plan
    && plan.version === PROACTIVE_PLAN_VERSION
    && plan.weekKey === week.weekKey
    && plan.weekMin === week.min
    && plan.weekMax === week.max
    && plan.weekCount === week.count
    && plan.weekPlanned === week.planned
    && plan.dayCount === week.dayCount
  ) {
    return plan;
  }

  const selected = week.dayCount > 0;
  const isToday = date === dayKey(now);
  const slots = selected
    ? proactiveSlotMinutesList(day, settings, week.dayCount, isToday ? now : null)
    : [];
  let reason = 'not-selected';
  if (week.max <= 0 || week.count <= 0) reason = 'disabled';
  else if (selected) reason = slots.length === 0 ? 'no-free-window' : 'free-time';
  else if (week.planned <= 0) reason = 'weekly-quota-filled';

  day.proactivePlan = {
    version: PROACTIVE_PLAN_VERSION,
    generatedAt: localISOString(now),
    weekKey: week.weekKey,
    weekMin: week.min,
    weekMax: week.max,
    weekCount: week.count,
    weekAffinity: Math.round(week.affinity * 100),
    weekSent: week.sent,
    weekPlanned: week.planned,
    dayCount: week.dayCount,
    plannedSlots: slots.length,
    selected,
    reason,
    slots: slots.map((at) => ({ time: minutesToTime(at), sent: false })),
  };
  return day.proactivePlan;
}

/** 现在是否落在某个未发送的主动时间点（含 30 分钟宽限） */
function proactiveSlotOpen(day, now) {
  const plan = isPlainObject(day) && isPlainObject(day.proactivePlan) ? day.proactivePlan : null;
  if (!plan || plan.selected === false || !Array.isArray(plan.slots) || plan.slots.length === 0) return false;
  const current = asDate(now);
  const minutes = current.getHours() * 60 + current.getMinutes();
  return plan.slots.some((slot) => {
    if (!slot || slot.sent) return false;
    const at = timeMinutes(slot.time);
    return at !== null && minutes >= at && minutes <= at + PROACTIVE_SLOT_GRACE_MINUTES;
  });
}

function markProactiveSlotSent(day, now) {
  const plan = isPlainObject(day) && isPlainObject(day.proactivePlan) ? day.proactivePlan : null;
  if (!plan || !Array.isArray(plan.slots)) return;
  const current = asDate(now);
  const minutes = current.getHours() * 60 + current.getMinutes();
  const slot = plan.slots.find((item) => {
    if (!item || item.sent) return false;
    const at = timeMinutes(item.time);
    return at !== null && minutes >= at && minutes <= at + PROACTIVE_SLOT_GRACE_MINUTES;
  });
  if (slot) slot.sent = true;
}

function proactiveLimit(settings) {
  // 兼容旧设置 / 单测：proactivePerDay 只作为「每天最多几条」的内部上限；
  // 实际频率由每周目标次数和当天排到的 slot 数决定。
  const life = lifeSection(settings);
  const raw = life.proactivePerDay;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_PROACTIVE_PER_DAY;
}

/** 当天实际最多发几条：有当天计划时按计划 slot 数放开，没有计划时沿用旧上限 */
function proactiveDayLimit(day, settings, character) {
  const base = proactiveDailyLimit(settings, character);
  if (base <= 0) return 0;
  const plan = isPlainObject(day) && isPlainObject(day.proactivePlan) ? day.proactivePlan : null;
  const slots = plan && Array.isArray(plan.slots) ? plan.slots.length : 0;
  if (slots <= 0) return base;
  // 当天排了几条就允许几条；表达 ≤30 仍压到 1 条
  if (expressivenessOf(character) <= EXPRESSIVE_LOW_CUT) return 1;
  return Math.min(slots, PROACTIVE_TRIGGERS.length);
}

/** 有 baseUrl 与 model 才值得调模型；缺字段直接走模板兜底 */
function isUsableProfile(profile) {
  return isPlainObject(profile)
    && typeof profile.baseUrl === 'string'
    && /^https?:\/\//i.test(profile.baseUrl.trim())
    && typeof profile.model === 'string'
    && profile.model.trim() !== '';
}

/** 只保留格式合法的日程项，并按时间升序（同一时间点的多条都保留） */
function normalizeScheduleList(raw) {
  if (!Array.isArray(raw)) return [];
  const schedule = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const time = clean(item.time);
    const activity = clean(item.activity);
    if (!HHMM_PATTERN.test(time) || !activity) continue;
    const row = { time, activity };
    // P3：类别随日程一起保留，事件触发后按类别结算状态；模型生成的日程没有类别
    const category = clean(item.category);
    if (category) row.category = category;
    // 模型生成的「具体小动作细节」，事件触发时优先用它
    const detail = clean(item.detail);
    if (detail) row.detail = detail;
    schedule.push(row);
  }
  schedule.sort((a, b) => a.time.localeCompare(b.time));
  return schedule;
}

function normalizeDayRecord(day) {
  const src = isPlainObject(day) ? day : {};
  return {
    ...src,
    schedule: normalizeScheduleList(src.schedule),
    events: Array.isArray(src.events) ? src.events.filter(isPlainObject) : [],
    proactive: normalizeProactive(src.proactive),
  };
}

// ---------------------------------------------------------------------------
// 每日日程
// ---------------------------------------------------------------------------

/**
 * 内置日程模板：从角色职业 / 住处 / 城市 / hobbies / persona.likes 取素材；
 * 缺字段时用通用句子。固定 5 条，时间升序（08:30–21:00）。
 * @param {object} [character]
 * @returns {Array<{ time: string, activity: string }>}
 */
function defaultSchedule(character) {
  const c = isPlainObject(character) ? character : {};
  const persona = isPlainObject(c.persona) ? c.persona : {};
  const life = isPlainObject(c.life) ? c.life : {};

  const occupation = clean(life.occupation);
  const home = clean(life.home);
  const city = clean(life.city);
  const hobbies = unique([...asList(life.hobbies), ...asList(persona.likes)]);
  const firstHobby = hobbies[0];
  const secondHobby = hobbies[1];

  if (i18n.getLanguage() === 'en') {
    // 英文兜底不起用中文素材（角色资料本身可能仍是中文），用通用英文句子
    const times = ['08:30', '11:00', '14:00', '18:30', '21:00'];
    return content.defaultSchedule.en.map((activity, index) => ({
      time: times[index],
      activity,
    }));
  }

  const tpl = content.defaultSchedule.zh;
  const morning = home
    ? fillTemplate(tpl.morningWithHome, { home })
    : tpl.morning;
  const work = occupation
    ? fillTemplate(tpl.workWithOccupation, { occupation })
    : tpl.work;
  const afternoon = firstHobby
    ? fillTemplate(tpl.afternoonWithHobby, { hobby: firstHobby })
    : tpl.afternoon;
  const evening = secondHobby
    ? fillTemplate(tpl.eveningWithHobby, { hobby: secondHobby })
    : city
      ? fillTemplate(tpl.eveningWithCity, { city })
      : tpl.evening;

  return [
    { time: '08:30', activity: morning },
    { time: '11:00', activity: work },
    { time: '14:00', activity: afternoon },
    { time: '18:30', activity: tpl.dinner },
    { time: '21:00', activity: evening },
  ];
}

/**
 * 职业固定锚点：life.workAnchor = { time, activity }。
 * 例如主播每天 20:00 开播；当天没有这条时补进去，并挪开同时段（±60 分钟）的普通活动。
 * @param {unknown} schedule
 * @param {object} [character]
 * @returns {{ schedule: Array<{time:string, activity:string}>, added: boolean }}
 */
function withWorkAnchor(schedule, character) {
  const list = normalizeScheduleList(schedule);
  const life = isPlainObject(character && character.life) ? character.life : {};
  const raw = isPlainObject(life.workAnchor) ? life.workAnchor : null;
  if (!raw) return { schedule: list, added: false };
  const time = clean(raw.time);
  const activity = clean(raw.activity);
  if (!/^\d{2}:\d{2}$/.test(time) || !activity) return { schedule: list, added: false };
  if (list.some((row) => clean(row.activity).includes(activity))) {
    return { schedule: list, added: false };
  }
  const anchorMinutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const kept = list.filter((row) => {
    const minutes = Number(row.time.slice(0, 2)) * 60 + Number(row.time.slice(3, 5));
    return Math.abs(minutes - anchorMinutes) > 60;
  });
  kept.push({ time, activity });
  kept.sort((a, b) => a.time.localeCompare(b.time));
  return { schedule: kept, added: true };
}

/**
 * 日常锚点：life.routineAnchors = [{ time, activity }]。
 * 用来固定「练琴 / 做晚饭」这类每天都做的事；已有同名活动就跳过，同时段（±45 分钟）的普通活动让位。
 * @param {unknown} schedule
 * @param {object} [character]
 * @returns {{ schedule: Array<{time:string, activity:string}>, added: boolean }}
 */
function withRoutineAnchors(schedule, character) {
  const life = isPlainObject(character && character.life) ? character.life : {};
  const anchors = Array.isArray(life.routineAnchors) ? life.routineAnchors : [];
  let next = normalizeScheduleList(schedule);
  let added = false;
  for (const raw of anchors) {
    if (!isPlainObject(raw)) continue;
    const time = clean(raw.time);
    const activity = clean(raw.activity);
    if (!/^\d{2}:\d{2}$/.test(time) || !activity) continue;
    if (next.some((row) => clean(row.activity).includes(activity))) continue;
    const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    next = next.filter((row) => {
      const m = Number(row.time.slice(0, 2)) * 60 + Number(row.time.slice(3, 5));
      return Math.abs(m - minutes) > 45;
    });
    next.push({ time, activity });
    added = true;
  }
  next.sort((a, b) => a.time.localeCompare(b.time));
  return { schedule: next, added };
}

/**
 * 生日当天的额外日程条目；不是生日返回 null。
 * @param {object} [character]
 * @param {Date|string|number} at
 * @returns {{ time: string, activity: string } | null}
 */
function birthdayScheduleItem(character, at) {
  const c = isPlainObject(character) ? character : {};
  const personaSrc = isPlainObject(c.persona) ? c.persona : {};
  if (!persona.isBirthdayToday(personaSrc.birthday, at)) return null;
  return { time: BIRTHDAY_TIME, activity: i18n.t(BIRTHDAY_ACTIVITY) };
}

/**
 * 在日程里补一条生日条目（同日同时刻已存在就跳过；总条数上限 6）。
 * @param {unknown} schedule
 * @param {object} [character]
 * @param {Date|string|number} at
 * @returns {{ schedule: Array<{time:string, activity:string}>, added: boolean }}
 */
function withBirthdaySchedule(schedule, character, at) {
  const list = normalizeScheduleList(schedule);
  const item = birthdayScheduleItem(character, at);
  if (!item) return { schedule: list, added: false };
  if (list.some((row) => row.time === item.time)) return { schedule: list, added: false };

  const next = list.slice();
  next.push(item);
  next.sort((a, b) => a.time.localeCompare(b.time));
  return { schedule: next.slice(0, SCHEDULE_MAX_WITH_BIRTHDAY), added: true };
}

// ---------------------------------------------------------------------------
// P5：长期项目
// ---------------------------------------------------------------------------

function minutesToTime(minutes) {
  const value = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  return `${pad2(Math.floor(value / 60))}:${pad2(value % 60)}`;
}

/**
 * 今天是否该安排项目：昨天已经有项目条目就跳过（实际节奏 ≈ 每 1–2 天一次）。
 * 只读 timeline，不引入额外状态，跨天仍可复现。
 */
function projectIsDue(timeline, date) {
  const days = timeline && isPlainObject(timeline.days) ? timeline.days : {};
  const target = localDateFromKey(date);
  if (!target) return true;
  const previous = new Date(target.getTime());
  previous.setDate(previous.getDate() - 1);
  const rows = normalizeDayRecord(days[dayKey(previous)]).schedule;
  return !rows.some((row) => clean(row.category) === 'project');
}

/** 超上限时优先挤掉晚间的一条普通活动（生日 / 项目条目保留） */
function trimProjectSchedule(next) {
  if (next.length <= SCHEDULE_MAX_WITH_PROJECT) return next;
  const protectedRow = (row) => clean(row.category) === 'project'
    || clean(row.activity) === i18n.t(BIRTHDAY_ACTIVITY);
  let index = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (protectedRow(next[i])) continue;
    if (next[i].time >= '18:00') {
      index = i;
      break;
    }
  }
  if (index < 0) index = next.findIndex((row) => !protectedRow(row));
  if (index >= 0) next.splice(index, 1);
  return next.slice(0, SCHEDULE_MAX_WITH_PROJECT);
}

/**
 * 有进行中的项目时，在晚间补一条「推进项目」。
 * - 日程里已有 category:'project' → 幂等跳过；
 * - 昨天已经推进过 → 今天跳过（每 1–2 天一次）；
 * - 时间点被占用（生日 19:30 / 节日 19:00 等）→ 向后错 5 分钟，最晚 22:00；
 * - 与生日 / 节日条目共存，只在超过 6 条时挤掉一条晚间普通活动。
 *
 * @param {unknown} schedule
 * @param {object} [character]
 * @param {Date|string|number} at
 * @param {object} [timeline] 用来判断昨天是否已推进
 * @returns {{ schedule: Array<object>, added: boolean }}
 */
function withProjectSchedule(schedule, character, at, timeline) {
  const list = normalizeScheduleList(schedule);
  if (list.some((row) => clean(row.category) === 'project')) {
    return { schedule: list, added: false };
  }
  const project = projectsEngine.activeProject(
    isPlainObject(character) && isPlainObject(character.life) ? character.life.projects : null,
  );
  if (!project) return { schedule: list, added: false };

  const date = dayKey(at);
  if (!projectIsDue(timeline, date)) return { schedule: list, added: false };

  const item = projectsEngine.projectActivity(project, at);
  if (!item) return { schedule: list, added: false };

  const taken = new Set(list.map((row) => row.time));
  let minutes = Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3, 5));
  const latest = 22 * 60;
  while (taken.has(minutesToTime(minutes)) && minutes + 5 <= latest) minutes += 5;
  const time = minutesToTime(minutes);

  const next = list.concat([{ time, activity: item.activity, category: 'project' }]);
  next.sort((a, b) => a.time.localeCompare(b.time));
  return { schedule: trimProjectSchedule(next), added: true };
}

/** 从模型输出里取数组：容忍 ```json 围栏、前后解释文字、{schedule:[...]} 包装 */
function parseSchedulePayload(raw) {
  if (Array.isArray(raw)) return raw;
  if (isPlainObject(raw)) {
    return Array.isArray(raw.schedule) ? raw.schedule : null;
  }
  if (typeof raw !== 'string') return null;

  let text = raw.trim();
  if (!text) return null;
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const attempt = (candidate) => {
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end <= start) return null;
    try {
      const value = JSON.parse(candidate.slice(start, end + 1));
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(text);
  if (direct) return direct;

  // 模型偶尔包成 {"schedule":[...]}：直接解析整个对象再取 schedule
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try {
      const value = JSON.parse(text.slice(objStart, objEnd + 1));
      if (isPlainObject(value) && Array.isArray(value.schedule)) return value.schedule;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 校验日程。
 * 失败条件：无法解析 / 为空 / 条数不在 3–5 / 时间不是 HH:MM / 早于 06:00 / activity 为空 /
 * 时间非升序（同一时间点允许，事件推进时会去重）。失败时整体回落到 defaultSchedule。
 * @param {unknown} raw 数组、{schedule:[]}、或模型原始文本
 * @param {object} [character] 回落模板的素材来源
 * @returns {{ schedule: Array<{time:string, activity:string}>, ok: boolean, warnings: string[] }}
 */
function validateSchedule(raw, character) {
  const warnings = [];
  const fallback = () => defaultSchedule(character);
  const fail = (reason) => {
    warnings.push(reason);
    warnings.push('已回落到内置日程模板');
    return { schedule: fallback(), ok: false, warnings };
  };

  const items = parseSchedulePayload(raw);
  if (!items || items.length === 0) return fail('日程为空或无法解析');
  if (items.length < SCHEDULE_MIN_ITEMS || items.length > SCHEDULE_MAX_ITEMS) {
    return fail(`日程条数应在 ${SCHEDULE_MIN_ITEMS}–${SCHEDULE_MAX_ITEMS} 条，实际 ${items.length} 条`);
  }

  const schedule = [];
  let previous = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const label = `第 ${index + 1} 条`;
    if (!isPlainObject(item)) return fail(`${label}不是对象`);

    const time = clean(item.time);
    const activity = clean(item.activity);
    if (!HHMM_PATTERN.test(time)) return fail(`${label}时间格式非法：${time || '（空）'}`);
    if (time < SCHEDULE_START || time > SCHEDULE_END) {
      return fail(`${label}时间不在 06:00–23:59：${time}`);
    }
    if (!activity) return fail(`${label}缺少活动内容`);
    if (previous !== null && time < previous) {
      return fail(`${label}时间 ${time} 早于上一条 ${previous}，不是升序`);
    }
    previous = time;
    schedule.push({ time, activity });
  }
  return { schedule, ok: true, warnings };
}

/** 读取 timeline（不抛）；dir / id 缺失时返回空时间线 */
function safeReadTimeline(dir, character) {
  const id = character && typeof character.id === 'string' ? character.id : null;
  if (typeof dir !== 'string' || !dir || !id) return { days: {} };
  try {
    return store.readTimeline(dir, id);
  } catch (error) {
    warn('读取 timeline 失败，按空时间线处理', error);
    return { days: {} };
  }
}

/** timeline 落盘（不抛）；dir / id 缺失时静默跳过 */
function safeWriteTimeline(dir, character, timeline) {
  const id = character && typeof character.id === 'string' ? character.id : null;
  if (typeof dir !== 'string' || !dir || !id) return;
  try {
    store.writeTimeline(dir, id, timeline);
  } catch (error) {
    warn('写入 timeline 失败', error);
  }
}

/** 五维性格：优先 persona.inner.profile，缺失时按生日 / 职业自动算一次 */
function fiveDimProfile(character) {
  const c = isPlainObject(character) ? character : {};
  const personaSrc = isPlainObject(c.persona) ? c.persona : {};
  const inner = isPlainObject(personaSrc.inner) ? personaSrc.inner : {};
  if (isPlainObject(inner.profile)) return inner.profile;
  return persona.autoProfile({ birthday: personaSrc.birthday, life: c.life });
}

/** 五维取值：0–100 的整数，缺失 / 非法按中间值 50 */
function scoreOf(value) {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(number)) return 50;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function expressivenessOf(character) {
  const profile = fiveDimProfile(character);
  return scoreOf(isPlainObject(profile) ? profile.expressiveness : undefined);
}

/**
 * 主动消息单条字数上限（P7 表达维度）。
 * ≤30：28 字（少而短）；≥70：40 字（原上限）；其余 34 字。
 * @param {object} [character]
 * @returns {number}
 */
function proactiveMaxChars(character) {
  const value = expressivenessOf(character);
  // 英文字符数约为中文的两倍，按同一语义长度放宽上限
  const scale = i18n.getLanguage() === 'en' ? 2 : 1;
  if (value <= EXPRESSIVE_LOW_CUT) return LOW_EXPRESSIVE_CHARS * scale;
  if (value >= EXPRESSIVE_HIGH_CUT) return MAX_PROACTIVE_CHARS * scale;
  return MID_EXPRESSIVE_CHARS * scale;
}

/**
 * 每日主动消息上限（内部兜底）：表达 ≤30 时少发一条（至少保留 1 条；关闭时仍是 0）。
 * 每周实际发几天由 ensureProactivePlan 控制，不靠这个上限。
 * @param {object} [settings]
 * @param {object} [character]
 * @returns {number}
 */
function proactiveDailyLimit(settings, character) {
  const base = proactiveLimit(settings);
  if (base <= 0) return 0;
  if (expressivenessOf(character) <= EXPRESSIVE_LOW_CUT) return Math.max(1, base - 1);
  return base;
}

function readActivityPool(character) {
  const c = isPlainObject(character) ? character : {};
  const life = isPlainObject(c.life) ? c.life : {};
  return isPlainObject(life.activityPool) ? life.activityPool : null;
}

/** 把活动池写回 character.json（不抛；dir / id 缺失时只改内存对象） */
function writeActivityPool(dir, character, pool) {
  const c = isPlainObject(character) ? character : null;
  if (!c) return false;
  if (!isPlainObject(c.life)) c.life = {};
  c.life.activityPool = pool;
  const id = typeof c.id === 'string' ? c.id : null;
  if (typeof dir !== 'string' || !dir || !id) return false;
  try {
    store.saveCharacter(dir, c);
    return true;
  } catch (error) {
    warn('写入活动池失败', error);
    return false;
  }
}

/** 活动文本归一化（去标点空白），用于判断「和前几天是不是同一件事」 */
function normalizeActivity(text) {
  return String(text == null ? '' : text).replace(/[\s，。、,.;；:：!！?？"'“”‘’（）()\-—…]/gu, '');
}

/** 新日程与最近几天重复了几条（按活动文本归一化后精确比较） */
function scheduleOverlap(schedule, recentDays) {
  const recent = new Set();
  for (const day of Array.isArray(recentDays) ? recentDays : []) {
    const rows = day && Array.isArray(day.schedule) ? day.schedule : [];
    for (const row of rows) {
      const key = normalizeActivity(row && row.activity);
      if (key) recent.add(key);
    }
  }
  let hits = 0;
  for (const row of Array.isArray(schedule) ? schedule : []) {
    const key = normalizeActivity(row && row.activity);
    if (key && recent.has(key)) hits += 1;
  }
  return hits;
}

/** 取目标日期之前最近 n 天的日程（用于「别和前几天一样」） */
function recentSchedules(timeline, date, n = 3) {
  const days = timeline && isPlainObject(timeline.days) ? timeline.days : {};
  return Object.keys(days)
    .filter((key) => key < date)
    .sort()
    .reverse()
    .slice(0, n)
    .map((key) => ({ date: key, schedule: normalizeDayRecord(days[key]).schedule }))
    .filter((item) => item.schedule.length > 0);
}

/** 最近 n 天日程里用过的「具体动作细节」，传给模型做去重（禁重复项） */
function recentDetails(timeline, date, n = 14) {
  const days = timeline && isPlainObject(timeline.days) ? timeline.days : {};
  return Object.keys(days)
    .filter((key) => key < date)
    .sort()
    .reverse()
    .slice(0, n)
    .flatMap((key) => normalizeDayRecord(days[key]).schedule)
    .map((row) => clean(row && row.detail))
    .filter(Boolean);
}

/** 模型返回的「每条日程一句细节」：优先 JSON 数组，退化为逐行；缺项/重复项留空串 */
function parseDetailLines(raw, count) {
  const total = Number.isInteger(count) && count > 0 ? count : 0;
  if (total === 0) return [];
  const text = String(raw || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  let list = [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(value)) list = value;
    } catch {
      list = [];
    }
  }
  if (list.length === 0) {
    // 退化解析（非 JSON）：只接受像句子的行，防止把「这不是 JSON」这种回话当细节
    list = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:\d+\s*[.、)]|[-*•])\s*/, '').trim())
      .filter((line) => line && /[。！？…]$/.test(line));
  }
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    let line = typeof entry === 'string'
      ? entry
      : (isPlainObject(entry) ? clean(entry.detail) || clean(entry.text) : '');
    line = clean(line)
      .replace(/^["'「『]+/, '')
      .replace(/["'」』]+$/, '')
      .trim();
    const length = Array.from(line).length;
    if (!line || length < 6 || length > 80) {
      out.push('');
      continue;
    }
    const key = line.replace(/[。！？，、；\s]/g, '');
    if (seen.has(key)) {
      out.push('');
      continue;
    }
    seen.add(key);
    out.push(line);
  }
  while (out.length < total) out.push('');
  return out.slice(0, total);
}

/**
 * 给当天日程逐条补「具体动作细节」：一次模型调用，结果写进 schedule[].detail。
 * 只在模型可用、后台预算够、当天还没试过时调用；失败就留空，事件触发时退回本地文案池。
 */
async function fillScheduleDetails({
  dir, character, profile, settings, schedule, timeline, date, context, now, day,
}) {
  const rows = Array.isArray(schedule) ? schedule : [];
  if (rows.length === 0) return { schedule: rows, attempted: false };
  if (!rows.some((row) => !clean(row && row.detail))) return { schedule: rows, attempted: false };
  // 一天最多试 2 次：模型偶尔返回空，不能因为一次失败就整天用固定文案
  const tries = Number(day && day.detailsTries) || 0;
  if (tries >= 2) return { schedule: rows, attempted: false };
  if (lifeSection(settings).enabled === false) return { schedule: rows, attempted: false };
  if (!isUsableProfile(profile) || !canRunBackground(dir, settings, now)) {
    return { schedule: rows, attempted: false };
  }
  if (day) {
    day.detailsAt = localISOString(now);
    day.detailsTries = tries + 1;
  }
  try {
    const result = await llm.chat({
      profile,
      messages: prompt.buildDetailMessages({
        character,
        schedule: rows,
        recentDetails: recentDetails(timeline, date, 14),
        context: { ...(isPlainObject(context) ? context : {}), date },
      }),
      retry: 0,
      maxTokens: Math.min(8000, 1500 + rows.length * 200),
    });
    recordBackground(dir, result && result.usage, now);
    const lines = parseDetailLines(result && result.text, rows.length);
    const next = rows.map((row, index) => (
      lines[index] ? { ...row, detail: lines[index] } : row
    ));
    return { schedule: next, attempted: true };
  } catch (error) {
    warn('生成日程细节失败，退回本地文案池', error);
    return { schedule: rows, attempted: true };
  }
}

/** 模型返回的小意外：只取第一行，拒绝 JSON / 空 / 过长 */
function parseDiscoveryLine(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  let text = lines[0];
  if (/^[\[{]/.test(text)) return '';
  text = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/g, '')
    .replace(/^["'“”「」]+/, '')
    .replace(/["'“”「」]+$/, '')
    .replace(/^她\s*[:：]\s*/, '')
    .trim();
  if (!text || /^(无|没有|不需要|空|null|none)$/i.test(text)) return '';
  const length = Array.from(text).length;
  if (length < 6 || length > 60) return '';
  return text;
}

/** 把一条小意外插到 21:00 前后；超过日程上限时挤掉一条普通晚间条目 */
function insertDiscovery(schedule, text) {
  const rows = Array.isArray(schedule) ? schedule.slice() : [];
  const activityText = clean(text);
  if (!activityText) return rows;
  if (rows.some((row) => clean(row.activity) === activityText)) return rows;

  const taken = new Set(rows.map((row) => clean(row.time)));
  let minutes = 21 * 60;
  while (taken.has(minutesToTime(minutes)) && minutes < 22 * 60) minutes += 5;
  const row = { time: minutesToTime(minutes), activity: activityText, category: 'discovery' };
  const next = rows.concat([row]).sort((a, b) => String(a.time).localeCompare(String(b.time)));
  if (next.length <= SCHEDULE_MAX_ITEMS) return next;

  for (let index = next.length - 1; index >= 0; index -= 1) {
    const item = next[index];
    if (item === row) continue;
    const category = clean(item.category);
    if (category === 'project' || category === 'discovery') continue;
    if (clean(item.activity) === BIRTHDAY_ACTIVITY || clean(item.activity) === i18n.t(BIRTHDAY_ACTIVITY)) continue;
    next.splice(index, 1);
    return next;
  }
  return rows;
}

/**
 * 采纳模型自检结果（P9）。
 * 只在「条数与时间点完全一致」且每条 category 都在 allowedCategories 内、
 * 不违反职业 / 社交硬约束时整体替换；任一条不合格就返回 null，
 * 调用方沿用原日程——绝不只采纳一半。
 *
 * @param {Array<{time:string, activity:string, category?:string}>} schedule 原日程
 * @param {unknown} raw 模型输出（数组 / {schedule:[]} / 原始文本）
 * @param {{ character?: object, profile?: object, state?: object }} [ctx]
 * @returns {Array<object>|null} 采纳后的日程；不合格返回 null
 */
function applyScheduleReview(schedule, raw, ctx = {}) {
  const base = Array.isArray(schedule) ? schedule : [];
  if (base.length === 0) return null;
  const items = parseSchedulePayload(raw);
  if (!items || items.length !== base.length) return null;

  const allowed = new Set(activity.allowedCategories(ctx));
  const out = [];
  for (let index = 0; index < base.length; index += 1) {
    const item = items[index];
    if (!isPlainObject(item)) return null;
    const original = isPlainObject(base[index]) ? base[index] : {};
    const time = clean(original.time);
    if (!time || clean(item.time) !== time) return null;
    const activityText = clean(item.activity);
    if (!activityText) return null;

    const row = { ...original, time, activity: activityText };
    const originalCategory = clean(original.category);
    const nextCategory = clean(item.category);
    if (nextCategory && nextCategory !== originalCategory) {
      if (!activity.CATEGORIES.includes(nextCategory)) return null;
      if (!allowed.has(nextCategory)) return null;
      // project / 生日这类由本地追加的条目，category 不允许被模型改写
      if (originalCategory !== 'project') row.category = nextCategory;
    }

    // 职业 / 社交硬约束：文案里命中被禁类型的动作词也整体放弃
    const category = clean(row.category);
    if (category && category !== 'project') {
      const socialCategory = ['visit', 'social', 'crowd'].includes(category);
      const probe = {
        category,
        text: row.activity,
        solo: !socialCategory,
        indoor: true,
        energyCost: 0,
        needs: {},
      };
      if (activity.filterPool([probe], ctx).length !== 1) return null;
    }
    out.push(row);
  }
  return out;
}

/**
 * 保证当天有日程（幂等）。
 * - 当天已有日程：直接返回，generated=false，不调模型；
 * - 活动池缺失 / 过期：预算与模型都可用时只调一次模型生成池子（按周复用）；
 *   预算不足 / 未配置模型 / 模型失败 → buildFallbackPool（0 次调用）；
 * - 每日日程由 sampleDay 抽样得到（0 次调用）；池子不可用才回落 defaultSchedule。
 * generated 表示「本次是否由模型成功生成了活动池」。
 *
 * @param {{ dir?: string, character?: object, date?: string, profile?: object,
 *           settings?: object, state?: object, now?: Date|string|number }} [input]
 * @returns {Promise<{ timeline: object, generated: boolean, state: object }>}
 */
async function ensureSchedule({
  dir, character, date, profile, settings, state, now = new Date(),
} = {}) {
  const current = asDate(now);
  const targetDate = typeof date === 'string' && date ? date : dayKey(current);
  const birthdayAt = localDateFromKey(targetDate) || current;

  // P3：先读状态并跨天结算，再抽样日程（低体力/低专注会在 allowedCategories 里过滤类别）
  const characterId = character && typeof character.id === 'string' ? character.id : null;
  const stateSource = isPlainObject(state) ? state : stateEngine.readState(dir, characterId, current);
  let currentState = stateEngine.settleDay(stateSource, current);
  if (characterId && !stateEngine.sameState(stateSource, currentState)) {
    try {
      stateEngine.writeState(dir, characterId, currentState, current);
    } catch (error) {
      warn('写入角色状态失败', error);
    }
  }

  // P4：当天天气 / 节日 / 节气 / 季节。天气失败静默退回季节概率，最多等 3 秒。
  const lifeSettings = lifeSection(settings);
  const city = character && isPlainObject(character.life) ? clean(character.life.city) : '';
  let todayWeather = null;
  if (lifeSettings.enabled !== false && lifeSettings.useWeather !== false) {
    try {
      todayWeather = await weatherEngine.weatherForDay({
        dir, characterId, city, now: current,
      });
    } catch (error) {
      warn('获取天气失败，改用季节概率', error);
      todayWeather = null;
    }
  }
  if (!todayWeather) {
    todayWeather = {
      ...calendar.seasonalWeather(birthdayAt, characterId || city || 'seasonal'),
      day: dayKey(current),
      city: city || null,
      at: localISOString(current),
    };
  }
  currentState = { ...currentState, weather: todayWeather };
  if (characterId) {
    const previousWeather = JSON.stringify(stateSource && stateSource.weather ? stateSource.weather : null);
    if (previousWeather !== JSON.stringify(todayWeather)) {
      try {
        stateEngine.writeState(dir, characterId, currentState, current);
      } catch (error) {
        warn('写入当天天气失败', error);
      }
    }
  }

  const holiday = calendar.holidayOf(birthdayAt);
  const term = calendar.solarTermOf(birthdayAt);
  const season = calendar.seasonOf(birthdayAt);
  const weekend = [0, 6].includes(birthdayAt.getDay());

  const timeline = safeReadTimeline(dir, character);
  if (!isPlainObject(timeline.days)) timeline.days = {};

  const day = normalizeDayRecord(timeline.days[targetDate]);
  // P6：把当天天气随 day 记下来，第二天据此判断「晴→雨 / 雨→晴」的突变
  const weatherChanged = weatherSignature(day.weather) !== weatherSignature(todayWeather);
  if (weatherChanged) day.weather = todayWeather;
  if (day.schedule.length > 0) {
    // 已有日程：只补生日 / 项目条目（幂等），不重新生成
    const beforePlan = JSON.stringify(day.proactivePlan || null);
    const hadWeekPlan = JSON.stringify(timeline.proactiveWeeks || null);
    ensureProactivePlan(day, character, settings, targetDate, current, timeline, {
      dir,
      state: currentState,
    });
    const planChanged = JSON.stringify(day.proactivePlan || null) !== beforePlan;
    const weekPlanChanged = JSON.stringify(timeline.proactiveWeeks || null) !== hadWeekPlan;
    const birthdayPatched = withBirthdaySchedule(day.schedule, character, birthdayAt);
    const projectPatched = withProjectSchedule(
      birthdayPatched.schedule, character, birthdayAt, timeline,
    );
    const patchedSchedule = birthdayPatched.added || projectPatched.added
      ? projectPatched.schedule
      : day.schedule;
    // 细节由模型生成（一天一次）；旧日程还没细节时在这里补一次
    const detailResult = await fillScheduleDetails({
      dir,
      character,
      profile,
      settings,
      schedule: patchedSchedule,
      timeline,
      date: targetDate,
      context: {
        weather: todayWeather, holiday, term, season, weekend, state: currentState,
      },
      now: current,
      day,
    });
    const scheduleChanged = birthdayPatched.added
      || projectPatched.added
      || detailResult.schedule !== patchedSchedule;
    day.schedule = detailResult.schedule;
    timeline.days[targetDate] = day;
    if (
      scheduleChanged
      || detailResult.attempted
      || weatherChanged || planChanged || weekPlanChanged
    ) {
      safeWriteTimeline(dir, character, timeline);
    }
    return { timeline, generated: false, state: currentState };
  }

  let schedule = null;
  let generated = false;
  let source = 'template';
  const warnings = [];
  const fiveDim = fiveDimProfile(character);
  // 池子按周生成：只看性格 / 职业，不把当天的 energy / focus 固化进一周的池子；
  // 状态对活动的影响留到 sampleDay 每天抽样时再生效。
  const poolCtx = { character, profile: fiveDim };

  const budgetOk = canRunBackground(dir, settings, current);
  const profileOk = isUsableProfile(profile);

  if (lifeSection(settings).enabled === false) {
    warnings.push('生活功能已关闭，使用内置日程');
  } else {
    let pool = readActivityPool(character);
    let poolFrom = 'stored';
    // 过期，或性格/职业改动后合格条目太少 → 视为需要重生成。
    // 另外要求「有基本覆盖面」：至少要有 discovery，且要有 home 或 create；
    // 否则一整天只能靠 chore/selfcare + 本地兜底，会出现「半夜重排书架」这种怪条目。
    const poolStat = activity.poolStats(pool, poolCtx);
    const allowedPoolItems = activity.filterPool(
      pool && Array.isArray(pool.items) ? pool.items : [],
      poolCtx,
    );
    const poolCats = new Set(allowedPoolItems.map((item) => clean(item.category)));
    const poolCovers = poolCats.has('discovery')
      && (poolCats.has('home') || poolCats.has('create'))
      && poolCats.size >= 3;
    const poolAt = pool && pool.generatedAt ? Date.parse(pool.generatedAt) : NaN;
    const poolYoung = Number.isFinite(poolAt) && (current.getTime() - poolAt) < 24 * 3600 * 1000;
    const poolReady = !activity.poolFresh(pool, current)
      && poolStat.allowed >= activity.PARSE_MIN_ITEMS
      && (poolCovers || poolYoung);

    if (!poolReady) {
      const previousPool = pool;
      const avoidTexts = [...new Set([
        ...(previousPool && Array.isArray(previousPool.items) ? previousPool.items : [])
          .map((item) => clean(item && item.text)),
        ...recentSchedules(timeline, targetDate, 14)
          .flatMap((day) => day.schedule.map((row) => clean(row.activity))),
      ].filter(Boolean))].slice(0, 60);
      pool = null;
      if (!budgetOk) {
        warnings.push('后台预算不足，活动池改用本地兜底');
      } else if (!profileOk) {
        warnings.push('模型未配置，活动池改用本地兜底');
      } else {
        try {
          const result = await llm.chat({
            profile,
            messages: activity.buildPoolMessages({
              character, profile: fiveDim, now: current, avoidTexts,
            }),
            // 后台任务失败当日不重试，避免等待与额外计费
            retry: 0,
            // 20–30 条活动 + JSON 开销，留足输出空间，避免截断后整池作废
            maxTokens: 6000,
          });
          recordBackground(dir, result && result.usage, current);
          const parsed = activity.parsePool(result && result.text, { ...poolCtx, avoidTexts });
          if (parsed) {
            pool = {
              generatedAt: localISOString(current),
              week: targetDate,
              items: parsed,
            };
            poolFrom = 'model';
            generated = true;
            writeActivityPool(dir, character, pool);
          } else {
            warnings.push('活动池输出不合格，改用本地兜底');
          }
        } catch (error) {
          warn('生成活动池失败，改用本地兜底', error);
          warnings.push('活动池生成失败，改用本地兜底');
        }
      }
    }

    if (!pool || activity.poolFresh(pool, current)) {
      pool = {
        generatedAt: null,
        week: targetDate,
        items: activity.buildFallbackPool(poolCtx),
      };
      poolFrom = 'fallback';
    }

    if (pool) {
      const recentDays = recentSchedules(timeline, targetDate, 7);
      const sampled = activity.sampleDay({
        pool,
        date: targetDate,
        profile: fiveDim,
        state: currentState,
        context: {
          character,
          weather: todayWeather,
          holiday,
          term,
          season,
          weekend,
          date: targetDate,
        },
        recentDays,
        includeDiscovery: false,
      });
      if (sampled.length >= SCHEDULE_MIN_ITEMS) {
        schedule = sampled.map((item) => ({
          time: item.time,
          activity: item.activity,
          category: item.category,
        }));
        source = poolFrom === 'model' ? 'model' : poolFrom === 'stored' ? 'pool' : 'template';
      } else {
        warnings.push('活动池抽样不足，使用内置日程');
      }
    }
  }

  if (!schedule) {
    schedule = defaultSchedule(character);
    source = 'template';
  }
  schedule = withBirthdaySchedule(schedule, character, birthdayAt).schedule;
  schedule = withProjectSchedule(schedule, character, birthdayAt, timeline).schedule;
  schedule = withWorkAnchor(schedule, character).schedule;
  schedule = withRoutineAnchors(schedule, character).schedule;

  // P10 小意外：不再每天从固定清单里抽，而是让模型结合当天日程 / 天气 / 状态生成 0–1 条。
  // 用确定性概率控制频率（约 30%–70% 的日子），避免天天都有；模型也可以返回空。
  if (
    lifeSection(settings).dailyDiscovery === true
    && schedule.length > 0
    && isUsableProfile(profile)
    && canRunBackground(dir, settings, current)
  ) {
    const openness = Number.isFinite(fiveDim.openness) ? fiveDim.openness : 50;
    const pace = Number.isFinite(fiveDim.pace) ? fiveDim.pace : 50;
    const chance = Math.min(0.7, Math.max(0.3, 0.35 + openness / 300 + pace / 500));
    const roll = calendar.hashString(`${targetDate}|${clean(character && character.id) || 'x'}|discovery`) / 1000003;
    if (roll < chance) {
      try {
        const recent = recentSchedules(timeline, targetDate, 7);
        const recentDiscoveries = recent
          .flatMap((item) => (Array.isArray(item.schedule) ? item.schedule : []))
          .filter((row) => clean(row.category) === 'discovery')
          .map((row) => clean(row.activity))
          .filter(Boolean);
        const result = await llm.chat({
          profile,
          messages: prompt.buildDiscoveryMessages({
            character,
            schedule,
            context: {
              date: targetDate,
              weather: todayWeather,
              holiday,
              term,
              season,
              weekend,
              state: currentState,
            },
            recentDiscoveries,
          }),
          retry: 0,
          maxTokens: 800,
        });
        recordBackground(dir, result && result.usage, current);
        const text = parseDiscoveryLine(result && result.text);
        // 小意外不能是某条日程的延续：和日程原文连续 5 字以上重合就丢掉，
        // 否则会出现「19:35 翻旧照片 → 21:00 翻旧照片时猫趴上来」这种同一件事跨两小时。
        const repeatsSchedule = text && schedule.some((row) => {
          const a = compactForCompare(text);
          const b = compactForCompare(row && row.activity);
          return a.length >= 5 && b.length >= 5 && commonSubstringLength(a, b) >= 5;
        });
        if (text && !repeatsSchedule) {
          const next = insertDiscovery(schedule, text);
          if (next.some((row) => clean(row.activity) === text)) {
            schedule = next;
            source = `${source}+discovery`;
          }
        }
      } catch (error) {
        warn('生成当天小意外失败，跳过', error);
      }
    }
  }

  // P9 日程自检：抽样 + 生日 / 节日 / 项目条目都加完之后，最多调 1 次模型。
  // 预算与主动消息共用同一闸门（canRunBackground）；未配置模型 / 预算不足 / 输出不合格
  // 一律静默跳过，沿用原日程，不影响主流程。
  if (
    lifeSection(settings).scheduleReview !== false
    && schedule.length > 0
    && isUsableProfile(profile)
    && canRunBackground(dir, settings, current)
  ) {
    try {
      const result = await llm.chat({
        profile,
        messages: prompt.buildScheduleReviewMessages({
          character,
          schedule,
          context: {
            date: targetDate,
            weather: todayWeather,
            holiday,
            term,
            season,
            weekend,
            now: current,
          },
        }),
        // 后台任务失败当日不重试，避免等待与额外计费
        retry: 0,
        maxTokens: SCHEDULE_REVIEW_MAX_TOKENS,
      });
      const reviewed = applyScheduleReview(schedule, result && result.text, {
        character, profile: fiveDim, state: currentState,
      });
      if (reviewed) {
        schedule = reviewed;
        // 例如 pool → pool+review、model → model+review
        source = `${source}+review`;
        recordBackground(dir, result && result.usage, current);
      }
    } catch (error) {
      warn('日程自检失败，沿用原日程', error);
    }
  }

  // 具体动作细节交给模型：每条日程一句，避免固定文案反复出现。
  // 失败 / 未配置模型 / 预算不足时留空，事件触发时退回本地文案池。
  const detailResult = await fillScheduleDetails({
    dir,
    character,
    profile,
    settings,
    schedule,
    timeline,
    date: targetDate,
    context: {
      weather: todayWeather, holiday, term, season, weekend, state: currentState,
    },
    now: current,
    day,
  });
  schedule = detailResult.schedule;

  day.schedule = schedule.map((row) => {
    const activityText = i18n.t(row.activity);
    return activityText === row.activity ? row : { ...row, activity: activityText };
  });
  ensureProactivePlan(day, character, settings, targetDate, current, timeline, {
    dir,
    state: currentState,
  });
  timeline.days[targetDate] = {
    ...day,
    schedule,
    events: day.events,
    generatedAt: localISOString(current),
    scheduleSource: source,
    scheduleWarnings: warnings,
  };
  safeWriteTimeline(dir, character, timeline);
  return { timeline, generated, state: currentState };
}

// ---------------------------------------------------------------------------
// 事件模板与推进
// ---------------------------------------------------------------------------

function moodOffset(mood) {
  const value = clean(mood);
  const index = MOODS.indexOf(value);
  if (index >= 0) return index;
  return value ? hashString(value) % EVENT_TEMPLATES.length : 0;
}

/**
 * 本地事件模板：动作 + 环境两段式，至少 20 条。
 * 同一 (mood, seed) 输出稳定；mood 只影响轮转起点。
 * @param {string} [mood]
 * @param {number|string} [seed]
 * @returns {string}
 */
function eventTemplate(mood, seed) {
  const list = EVENT_TEMPLATES;
  const numericSeed = typeof seed === 'number' && Number.isFinite(seed)
    ? Math.trunc(seed)
    : seed === undefined || seed === null
      ? 0
      : hashString(seed);
  const offset = moodOffset(mood);
  const raw = ((numericSeed % list.length) + offset) % list.length;
  return i18n.t(list[raw < 0 ? raw + list.length : raw]);
}

/** 「她做了什么」必须跟着日程项；先取活动本身，再按活动类型补一个具体细节 */
function eventTextFor(item, seed) {
  const activity = clean(item && item.activity);
  if (!activity) return '';
  const base = activity.replace(/[。！？?!]+$/, '');
  // 优先用当天模型生成的细节；没有才退回本地文案池。
  // 「她做了什么」只显示这句细节，不再把日程原句前置——原句常带结果（"手背不再起皮"），
  // 接上过程会变成"先结果、后细化"，读着倒序。
  const generated = clean(item && item.detail);
  const detail = generated || activityDetail(item, seed);
  if (!detail) return i18n.getLanguage() === 'en' ? `${base}.` : `${base}。`;
  const body = detail.replace(/[。！？?!.]+$/, '');
  return i18n.getLanguage() === 'en' ? `${body}.` : `${body}。`;
}

// 具体动作细节库：只补和活动同类的事，避免「练琴」写成「改稿」
const ACTIVITY_DETAIL_GROUPS = [
  { key: 'laundry', match: /(衣服|晾|叠|床单|洗衣|收进来)/ },
  { key: 'shopping', match: /(下单|网购|快递|配送|外卖|便利店|鸡蛋|牛奶|猫粮)/ },
  { key: 'phone', match: /(电话|通话|语音)/ },
  { key: 'chat', match: /(微信|聊天|发消息|视频)/ },
  { key: 'phone_media', match: /(手机|视频|刷|相册|音频)/ },
  { key: 'cat', match: /(猫|橘猫|蓝猫|铲屎|猫砂)/ },
  { key: 'piano', match: /(练琴|弹琴|钢琴|古筝|伴奏|节拍器)/ },
  { key: 'cooking', match: /(做饭|炖|炒|煮|焖|汤|面|蒸|煎)/ },
  { key: 'reading', match: /(书|读|翻两页|小说)/ },
  { key: 'walk', match: /(散步|走|公园|河边|海边|晒太阳|溜达|逛)/ },
  { key: 'cleaning', match: /(收拾|打扫|擦|拖地|扫地|洗碗|洗衣|洗衣服|刷|清理|归位)/ },
  { key: 'stream', match: /(开播|直播|试麦|声卡|镜头|灯光)/ },
  { key: 'plants', match: /(绿植|浇|花|盆栽|叶子)/ },
  { key: 'parcel', match: /(快递|取件|包裹|纸箱)/ },
  { key: 'fitness', match: /(健身|快走|器械|出汗)/ },
];
const ACTIVITY_DETAILS = ACTIVITY_DETAIL_GROUPS.map((group) => ({
  ...group,
  details: content.activityDetails[group.key] || [],
}));

function activityDetail(item, seed) {
  const text = clean(item && item.activity);
  if (!text) return '';
  const key = hashString(`${text}|${seed === undefined ? '' : seed}`);
  for (const group of ACTIVITY_DETAILS) {
    if (group.details.length > 0 && group.match.test(text)) {
      return i18n.t(group.details[key % group.details.length]);
    }
  }
  // 没有同类细节就留空：宁可只显示活动本身，也别塞「做完看了一眼，没觉得哪里不对」
  // 这种放之四海皆准、还会撞车的通用句。
  return '';
}

/** 按日程下标轮转心情（角色 tone 命中时作为起点，否则从「平静」开始） */
function moodFor(character, seed) {
  const life = isPlainObject(character) && isPlainObject(character.life) ? character.life : {};
  const tone = clean(life.tone);
  const base = MOODS.indexOf(tone) >= 0 ? MOODS.indexOf(tone) : 0;
  return MOODS[(seed + base) % MOODS.length];
}

/** 推进日程项对应的项目；返回「本次刚好完成」的项目，未完成 / 无项目返回 null */
function applyProjectProgress(character, item, event, now) {
  if (!isPlainObject(character)) return null;
  const life = isPlainObject(character.life) ? character.life : {};
  const list = projectsEngine.normalizeProjects(life.projects, now);
  if (list.length === 0) return null;

  const target = projectsEngine.findProject(list, item.projectId)
    || projectsEngine.activeProject(list);
  if (!target) return null;

  const result = projectsEngine.advanceProject(list, target.id, 1);
  if (!result.project) return null;

  if (!isPlainObject(character.life)) character.life = {};
  character.life.projects = result.projects;

  event.projectId = result.project.id;
  event.projectTitle = result.project.title;
  event.projectProgress = result.project.progress;
  event.projectTotal = result.project.total;
  const progress = projectsEngine.progressLine(result.project);
  if (progress) event.text = `${event.text}（${progress}）`;
  if (!result.completed) return null;
  event.projectDone = true;
  return result.project;
}

/** 项目完成时写一张 event 记忆卡（同文案已存在则不重复写） */
function writeProjectMemory(dir, character, project, now) {
  const id = character && typeof character.id === 'string' ? character.id : null;
  if (typeof dir !== 'string' || !dir || !id) return null;
  const text = projectsEngine.completionText(project);
  if (!text) return null;
  try {
    const memory = store.readMemory(dir, id);
    const cards = Array.isArray(memory.cards) ? memory.cards.slice() : [];
    if (cards.some((card) => clean(card.text) === text)) return null;
    const stamp = localISOString(now);
    const card = {
      id: `m-${asDate(now).getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'event',
      text,
      tags: ['长期项目'],
      variants: [text],
      importance: 4,
      createdAt: stamp,
      updatedAt: stamp,
      hits: 1,
      sourceMessageId: null,
      embedding: null,
    };
    cards.push(card);
    store.writeMemory(dir, id, { ...memory, cards });
    return card;
  } catch (error) {
    warn('写入项目完成记忆失败', error);
    return null;
  }
}

/**
 * 事件推进（0 成本，不调模型）。
 * 对 now 当天的日程：当前时间 ≥ 日程点、且该日程点尚未触发过，则追加一条事件。
 * 去重依据 events[].scheduleTime；同一时间点的多条日程只触发一次。
 * 前一天的事件留在前一天，不会在跨天后重复触发。
 *
 * P5：category:'project' 的条目触发时推进项目 +1，并把进度写回事件文本；
 * 传入 dir 时通过 store.saveCharacter 落盘，完成时写一条记忆卡 + 当天 events 记一条完成记录。
 *
 * @param {{ timeline?: object, now?: Date|string|number, character?: object, dir?: string }} [input]
 * @returns {{ timeline: object, fired: object[], character: object|null,
 *             completedProjects: object[] }}
 */
function advanceEvents({
  timeline, now, character, dir,
} = {}) {
  const source = isPlainObject(timeline) ? timeline : {};
  const days = isPlainObject(source.days) ? { ...source.days } : {};
  const current = asDate(now);
  const date = dayKey(current);
  const clock = hhmm(current);

  const workingCharacter = isPlainObject(character) ? character : null;
  const day = normalizeDayRecord(days[date]);
  const events = day.events.slice();
  const firedScheduleTimes = new Set(
    events.map((event) => clean(event.scheduleTime)).filter(Boolean),
  );

  const fired = [];
  const completedProjects = [];
  day.schedule.forEach((item, index) => {
    if (clock < item.time) return;
    if (firedScheduleTimes.has(item.time)) return;

    const mood = moodFor(workingCharacter, index);
    const seed = hashString(`${date}:${item.time}`);
    const event = {
      // 事件时间用日程时间（她做这件事的时间），不是补记时间：
      // 应用关了很久再打开时，几条日程会一起补触发，用当前时间会全挤在同一分钟。
      time: item.time,
      firedAt: clock,
      scheduleTime: item.time,
      activity: item.activity,
      category: clean(item.category) || null,
      text: eventTextFor(item, seed) || eventTemplate(mood, seed),
      mood,
      fired: true,
    };
    if (event.category === 'project') {
      const completed = applyProjectProgress(workingCharacter, item, event, current);
      if (completed) completedProjects.push(completed);
    }
    events.push(event);
    firedScheduleTimes.add(item.time);
    fired.push(event);
  });

  // 做项目的进度要落盘，否则下一次 tick 会把进度丢掉
  const projectsChanged = fired.some((event) => typeof event.projectId === 'string');
  if (projectsChanged && workingCharacter && typeof workingCharacter.id === 'string') {
    if (typeof dir === 'string' && dir) {
      try {
        store.saveCharacter(dir, workingCharacter);
      } catch (error) {
        warn('写入项目进度失败', error);
      }
    }
  }

  // 完成：timeline 当天记一条完成记录 + 写一张 event 记忆卡
  for (const project of completedProjects) {
    events.push({
      time: clock,
      activity: `完成项目：${project.title}`,
      category: 'project',
      text: projectsEngine.completionText(project),
      projectId: project.id,
      projectTitle: project.title,
      projectDone: true,
      fired: true,
    });
    writeProjectMemory(dir, workingCharacter, project, current);
  }

  days[date] = { ...day, events };
  return {
    timeline: { ...source, days },
    fired,
    character: workingCharacter,
    completedProjects,
  };
}

// ---------------------------------------------------------------------------
// 主动消息
// ---------------------------------------------------------------------------

/** 事件发生时间（HH:MM）与 now 的分钟差；不合法/跨天返回 null */
function eventMinutesAgo(event, now) {
  if (!isPlainObject(event) || event.fired === false) return null;
  const time = clean(event.time);
  if (!HHMM_PATTERN.test(time)) return null;
  const [hour, minute] = time.split(':').map(Number);
  const diff = minutesOfDay(now) - (hour * 60 + minute);
  return diff;
}

/** 最近一条已触发的事件（用于事件分享的上下文） */
function latestEvent(day) {
  const events = isPlainObject(day) && Array.isArray(day.events) ? day.events : [];
  let latest = null;
  for (const event of events) {
    if (!isPlainObject(event) || event.fired === false) continue;
    if (!latest || clean(event.time) >= clean(latest.time)) latest = event;
  }
  return latest;
}

/** 3 分钟内发生过事件 → 返回该事件；否则 null */
function freshEvent(day, now) {
  const events = isPlainObject(day) && Array.isArray(day.events) ? day.events : [];
  let best = null;
  for (const event of events) {
    const diff = eventMinutesAgo(event, now);
    if (diff === null || diff < 0 || diff > DEFAULT_EVENT_WINDOW_MINUTES) continue;
    if (!best || clean(event.time) > clean(best.time)) best = event;
  }
  return best;
}

function bootEligible(startedAt, now) {
  const start = toDateOrNull(startedAt);
  if (!start) return false; // 冷启动没有启动时间：必须等满 10 分钟，不能猜
  const current = asDate(now);
  const hour = current.getHours();
  if (hour < BOOT_EARLIEST_HOUR || hour >= BOOT_LATEST_HOUR) return false;
  const elapsed = current.getTime() - start.getTime();
  return elapsed >= DEFAULT_BOOT_DELAY_MINUTES * 60000
    && elapsed <= BOOT_WINDOW_MINUTES * 60000;
}

function idleEligible(lastUserAt, now) {
  const last = toDateOrNull(lastUserAt);
  if (!last) return false; // 从没聊过：久未联系不成立（开机问候另有触发）
  return now.getTime() - last.getTime() >= DEFAULT_IDLE_HOURS * 60 * 60000;
}

// ---------------------------------------------------------------------------
// P6：新增触发源（bedtime / holiday / birthday / followup / project / weather）
// ---------------------------------------------------------------------------

/** 昨天的日期键（本地时区，禁止 toISOString 切天） */
function previousDayKey(now) {
  const current = asDate(now);
  const previous = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  previous.setDate(previous.getDate() - 1);
  return dayKey(previous);
}

/** 今天是不是她的生日（persona.birthday 缺失 / 非法时 false） */
function birthdayToday(character, now) {
  const c = isPlainObject(character) ? character : {};
  const personaSrc = isPlainObject(c.persona) ? c.persona : {};
  return persona.isBirthdayToday(personaSrc.birthday, now);
}

/** 今天是否有项目完成记录（advanceEvents 写的 projectDone 事件）；返回最近一条 */
function completedProjectToday(day) {
  const events = isPlainObject(day) && Array.isArray(day.events) ? day.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isPlainObject(event) && event.projectDone === true) return event;
  }
  return null;
}

/** 从完成事件里取项目标题（老数据只有 activity / text） */
function projectTitleOfEvent(event) {
  const src = isPlainObject(event) ? event : {};
  const title = clean(src.projectTitle);
  if (title) return title;
  const activity = clean(src.activity).replace(/^完成项目[：:]\s*/u, '');
  if (activity) return activity;
  const matched = /《[^》]+》/u.exec(clean(src.text));
  return matched ? matched[0] : '';
}

/**
 * 天气突变：昨天晴今天雨，或昨天雨今天晴。
 * @returns {'rain'|'clear'|null} 今天变成了什么
 */
function weatherChangeOf(today, yesterday) {
  const now = isPlainObject(today) ? today : null;
  const before = isPlainObject(yesterday) ? yesterday : null;
  if (!now || !before) return null;
  if (now.isRain === true && before.isClear === true) return 'rain';
  if (now.isClear === true && before.isRain === true) return 'clear';
  return null;
}

/** 只比较「会影响判断」的天气字段，避免缓存里的 at 时间戳变化导致每分钟重写 */
function weatherSignature(weather) {
  if (!isPlainObject(weather)) return '';
  return [
    clean(weather.code),
    weather.isRain === true ? '1' : '0',
    weather.isClear === true ? '1' : '0',
    clean(weather.day),
  ].join('|');
}

/** 昨天是否和用户聊过（最后一条用户消息落在昨天） */
function chattedYesterday(lastUserAt, now) {
  const last = toDateOrNull(lastUserAt);
  if (!last) return false;
  return dayKey(last) === previousDayKey(now);
}

const FOLLOWUP_MAX_KEYWORD = 6;
const FOLLOWUP_BREAK = /[\s，。！？、；：,.!?;:…—~·"'“”‘’（）()【】\[\]《》<>]/u;
// 功能字：把它们当断句符，剩下的片段才像「事」
const FOLLOWUP_FILLER = /[的了着过呢吧啊呀吗嘛哦哈是在有和与跟就又都很也还太挺不没别个些这那哪我你他她它们把被给对从向让使会能要想去来到说把]/u;
const FOLLOWUP_PREFIXES = ['今天', '昨天', '明天', '后天', '最近', '现在', '刚才'];
const FOLLOWUP_STOPWORDS = new Set([
  '今天', '昨天', '明天', '后天', '最近', '现在', '刚才', '等下', '一会儿',
  '这个', '那个', '这些', '那些', '什么', '怎么', '为什么', '怎么样',
  '自己', '事情', '东西', '时候', '地方', '感觉', '觉得', '知道', '可能',
  '应该', '需要', '可以', '还是', '就是', '然后', '因为', '所以', '但是',
  '不过', '其实', '真的', '比较', '有点', '准备', '打算', '开始', '继续',
  '嗯嗯', '嗯', '哦哦', '哦', '哈哈', '嘿嘿', '啊啊', '哎呀', '唉', '诶',
]);

// 收尾 / 寒暄不算「昨天聊过的事」，不能拿它们当回访话题
const FOLLOWUP_CLOSING = /^(晚安|早安|午安|安|睡了|去睡|睡觉|早点休息|休息吧|拜拜|再见|回头聊|改天聊|先这样|在吗|在么|嗯+|哦+|好+|行|可以|没事|哈哈+|早)[~～。.!！?？\s]*$/u;
const FOLLOWUP_CLOSING_ANY = /(晚安|早安|午安|去睡了?|我睡了|早点睡|睡觉|早点休息|休息吧|拜拜|再见|回头聊|改天聊|先这样)/u;
const FOLLOWUP_SMALL_TALK = /^[嗯哦好行可以没事哈啊呀~～。.!！?？\s]+$/u;

/** 这句话是不是在说一件「事」，而不是纯寒暄 / 收尾 */
function isSubstantiveFollowupText(text) {
  const value = clean(text);
  if (!value) return false;
  const length = charLength(value);
  if (length < 4) return false;
  if (FOLLOWUP_SMALL_TALK.test(value)) return false;
  if (length <= 18 && (FOLLOWUP_CLOSING.test(value) || FOLLOWUP_CLOSING_ANY.test(value))) {
    return false;
  }
  return true;
}

/**
 * 从用户消息里取一个「昨天提到的事」的关键词（纯本地，0 模型调用）。
 * 取最后一句，按标点与功能字切片段，挑第一个 2–6 字、不像口头语的片段。
 * 取不到（全程寒暄 / 太短）返回 ''。
 *
 * @param {string} [text]
 * @returns {string}
 */
function followupKeyword(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw || !isSubstantiveFollowupText(raw)) return '';
  const sentences = raw.split(/[。！？!?；;\n]+/u).map((part) => part.trim()).filter(Boolean);
  const lastSentence = sentences.length > 0 ? sentences[sentences.length - 1] : raw;

  const fragments = lastSentence
    .split(FOLLOWUP_BREAK)
    .join(' ')
    .replace(new RegExp(FOLLOWUP_FILLER.source, 'gu'), ' ')
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const rawFragment of fragments) {
    let fragment = rawFragment;
    for (const prefix of FOLLOWUP_PREFIXES) {
      if (fragment.length > prefix.length && fragment.startsWith(prefix)) {
        fragment = fragment.slice(prefix.length);
        break;
      }
    }
    if (fragment.length < 2 || fragment.length > FOLLOWUP_MAX_KEYWORD) continue;
    if (FOLLOWUP_STOPWORDS.has(fragment)) continue;
    if (/^\d+$/u.test(fragment)) continue;
    return fragment;
  }
  return '';
}

/** 取某条用户消息之后、下一条用户消息之前她说的话（回访时要知道自己当时怎么回的） */
function followupReplyText(messages, index) {
  const list = Array.isArray(messages) ? messages : [];
  const parts = [];
  for (let cursor = index + 1; cursor < list.length; cursor += 1) {
    const message = list[cursor];
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') break;
    if (message.role !== 'assistant') continue;
    const text = clean(message.text);
    if (text) parts.push(text);
    if (charLength(parts.join(' ')) >= 80) break;
  }
  return clipOneLine(parts.join(' '), 80);
}

/**
 * 从最近对话里找「昨天最后一件正事」：只扫昨天的用户消息，跳过晚安 / 寒暄，
 * 带上原话和她当时的回复。这样回访不会把「晚安」当成话题，也不会只剩一个
 * 脱离上下文的词。
 *
 * @param {object[]} [messages]
 * @param {Date|string|number} [now]
 * @returns {{ keyword: string, sourceText: string, replyText: string } | null}
 */
function followupTopicFrom(messages, now) {
  const list = Array.isArray(messages) ? messages : [];
  const target = previousDayKey(now);
  let fallback = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message || message.role !== 'user') continue;
    const at = toDateOrNull(message.ts);
    if (!at || dayKey(at) !== target) continue;
    const text = clean(message.text);
    if (!isSubstantiveFollowupText(text)) continue;
    const keyword = followupKeyword(text);
    const topic = {
      keyword: keyword || clipOneLine(text, 12),
      sourceText: text,
      replyText: followupReplyText(list, index),
    };
    // 优先取能抽出具体关键词的那条；都没有就退回最后一条正事
    if (keyword) return topic;
    if (!fallback) fallback = topic;
  }
  return fallback;
}

/** 没有最近对话时（单测 / 旧调用），退回最后一条用户消息，但仍跳过寒暄 */
function followupTopicFromText(text) {
  const value = clean(text);
  if (!isSubstantiveFollowupText(value)) return null;
  const keyword = followupKeyword(value);
  return {
    keyword: keyword || clipOneLine(value, 12),
    sourceText: value,
    replyText: '',
  };
}

/** 静默开始时刻（分钟数）；没配静默时段返回 null */
function quietFromMinutes(settings) {
  const life = lifeSection(settings);
  const from = clean(life.quietFrom);
  if (!HHMM_PATTERN.test(from)) return null;
  return Number(from.slice(0, 2)) * 60 + Number(from.slice(3, 5));
}

/** 距离静默开始还有多少分钟（0 = 正好到点）；没配静默时段返回 null */
function minutesUntilQuiet(settings, now) {
  const start = quietFromMinutes(settings);
  if (start === null) return null;
  const current = minutesOfDay(now);
  return (start - current + 1440) % 1440;
}

/**
 * 睡前触发：静默开始前 30 分钟内，且体力 < 60。
 * 已经在静默时段里由 pickProactive 的最外层 isQuiet 挡掉，这里不重复判断。
 */
function bedtimeEligible(settings, now, state) {
  const diff = minutesUntilQuiet(settings, now);
  if (diff === null) return false;
  if (diff <= 0 || diff > BEDTIME_WINDOW_MINUTES) return false;
  const current = stateEngine.normalizeState(state, now);
  return current.energy < BEDTIME_MAX_ENERGY;
}


/**
 * 挑选主动消息触发源（纯决策，不产生副作用）。
 * 顺序（P6）：生日 → 节日 → 项目完成 → 天气突变 → 隔天回访 → 睡前
 *            → 开机问候 → 事件分享 → 久未联系。
 * 静默时段 / 关闭 / 已达当天上限返回 null；每个触发源各自每天最多一次
 * （day.proactive 记录）。实际频率由 day.proactivePlan 控制：
 * 本周目标次数按性格 / 关系加权，分到日期后可能一天多条，且只落在她当天的空闲时段。
 * P7：表达 ≤30 时跳过 followup 触发源。
 *
 * @param {{ day?: object, now?: Date|string|number, settings?: object, state?: object,
 *           lastUserAt?: Date|string|number|null, startedAt?: Date|string|number|null,
 *           character?: object, lastUserText?: string, recentMessages?: object[],
 *           previousWeather?: object|null }} [input]
 *   character：人物设定；生日触发需要它（缺省时 birthday 不生效）
 *   lastUserText：最近一条用户消息原文（没有 recentMessages 时的回退）
 *   recentMessages：最近对话（followup 从昨天最后一件正事取话题，跳过寒暄）
 *   previousWeather：昨天的天气（state.weather 缓存的昨日副本；缺省时不触发 weather）
 * @returns {{ trigger: string, event?: object, meta?: object } | null}
 */
function pickProactive({
  day, now, settings, lastUserAt, startedAt, state, character, lastUserText, recentMessages,
  previousWeather, allowLifeFallback = false,
} = {}) {
  const life = lifeSection(settings);
  if (life.enabled === false) return null;

  const current = asDate(now);
  if (isQuiet(settings, current)) return null;

  // P3 / spec 2.3：太累就完全不打扰；心情低时每天最多 1 条
  const currentState = stateEngine.normalizeState(state, current);
  if (currentState.energy < 25) return null;
  // 当天有多个 slot 时按 slot 数放开；心情低仍压到每天 1 条
  const dailyLimit = proactiveDayLimit(day, settings, character);
  if (dailyLimit <= 0) return null;
  const limit = currentState.mood < 30
    ? Math.min(dailyLimit, 1)
    : dailyLimit;

  const flags = normalizeProactive(isPlainObject(day) ? day.proactive : null);
  const used = countUsedProactive(flags);
  if (used >= limit) return null;
  // 单条至少隔 3 小时；同一天排了多条时缩到 30 分钟，避免触发源叠在一起
  if (!proactiveGapOk(day, current)) return null;
  // 有当日计划时，只在计划好的空档时间点附近发
  if (isPlainObject(day) && isPlainObject(day.proactivePlan) && !proactiveSlotOpen(day, current)) {
    return null;
  }

  // 表达 ≤30：少而短，不做隔天回访
  const lowExpressiveness = expressivenessOf(character) <= EXPRESSIVE_LOW_CUT;

  for (const trigger of PROACTIVE_PRIORITY) {
    if (flags[trigger]) continue;

    if (trigger === 'birthday') {
      if (birthdayToday(character, current)) return { trigger, meta: {} };
      continue;
    }

    if (trigger === 'holiday') {
      const holiday = calendar.holidayOf(current);
      if (holiday && holiday.name) return { trigger, meta: { holiday: holiday.name } };
      continue;
    }

    if (trigger === 'project') {
      const done = completedProjectToday(day);
      if (done) {
        return { trigger, event: done, meta: { project: projectTitleOfEvent(done) } };
      }
      continue;
    }

    if (trigger === 'weather') {
      const change = weatherChangeOf(currentState.weather, previousWeather);
      if (change) {
        // rainNow 是逐小时数据算出来的「此刻下没下雨」，让模型只在有依据时才说「这会儿」
        const rainNow = isPlainObject(currentState.weather) && typeof currentState.weather.rainNow === 'boolean'
          ? currentState.weather.rainNow
          : null;
        return { trigger, meta: { weather: change, rainNow } };
      }
      continue;
    }

    if (trigger === 'followup') {
      // P7：表达欲低时不主动回访（少而短）
      if (lowExpressiveness) continue;
      // 只在今天还没发过任何主动消息时回访，避免上午刚聊过又来一句
      if (used > 0) continue;
      if (!chattedYesterday(lastUserAt, current)) continue;
      const topic = followupTopicFrom(recentMessages, current)
        || followupTopicFromText(lastUserText);
      if (topic) return { trigger, meta: topic };
      continue;
    }

    if (trigger === 'bedtime') {
      if (bedtimeEligible(settings, current, currentState)) {
        return { trigger, meta: { bedInMinutes: minutesUntilQuiet(settings, current) } };
      }
      continue;
    }

    if (trigger === 'boot') {
      if (bootEligible(startedAt, current)) return { trigger };
      continue;
    }

    if (trigger === 'event') {
      const event = freshEvent(day, current);
      if (event) return { trigger, event };
      continue;
    }

    if (trigger === 'idle') {
      if (idleEligible(lastUserAt, current)) return { trigger };
      continue;
    }

    if (trigger === 'life') {
      // 兜底：计划里的空档已经打开，但生日/节日/项目/天气/回访/睡前/开机/事件/久未联系
      // 一个都不成立（最常见的是从没聊过天、当天也没排到事件）。这时就随口分享一句，
      // 素材用当天最近做完的那件事；没有事件就让它自己说当下的状态。
      // 由调用方显式开启（allowLifeFallback），避免把「不该发」的判定改成永远发。
      if (!allowLifeFallback) return null;
      const latest = latestEvent(day);
      return { trigger, meta: latest ? { recent: latest.text } : {} };
    }
  }
  return null;
}

/** 后台预算是否还够；dir 缺失或读取失败时按「够」处理（失败开放，不让记账问题挡住生活） */
function canRunBackground(dir, settings, now) {
  if (typeof dir !== 'string' || !dir) return true;
  try {
    return usage.canRunBackground(settings, usage.today(dir, now));
  } catch (error) {
    warn('读取后台用量失败，按可用处理', error);
    return true;
  }
}

function recordBackground(dir, usageData, now) {
  if (typeof dir !== 'string' || !dir) return;
  try {
    usage.record(dir, 'background', usageData || {}, now);
  } catch (error) {
    warn('后台用量记账失败', error);
  }
}

/** 取一句话：去围栏/引号/前缀，压空白，超长截到 max（含省略号） */
function clipOneLine(raw, max = MAX_PROACTIVE_CHARS) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0) text = lines[0];
  text = text.replace(/^她\s*[:：]\s*/, '');
  text = text
    .replace(/^["'“”‘’「」『』]+/, '')
    .replace(/["'“”‘’「」『』]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const chars = Array.from(text);
  if (chars.length > max) return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
  return text;
}

/** 比较前去掉标点 / 空白，只比「说的事」本身 */
function compactForCompare(text) {
  return clean(text).replace(/[\s，。！？、；：,.!?;:…—~·"'“”‘’（）()【】\[\]《》<>]+/gu, '');
}

/** 最长公共子串长度（句子都很短，直接 DP） */
function commonSubstringLength(left, right) {
  const a = typeof left === 'string' ? left : '';
  const b = typeof right === 'string' ? right : '';
  if (!a || !b) return 0;
  let previous = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

// 连续 6 个有效字重合，基本就是同一件事换了个说法（普通短句不会这么长）
const REPEATED_CLAIM_CHARS = 6;
const REPEATED_LOOKBACK_DAYS = 3;

/**
 * 天气守门：只有「明确知道此刻没下雨」（rainNow === false）时才拦，
 * 未知（null）不拦，避免误伤。
 */
function weatherRealtimeConflict(text, meta) {
  if (!isPlainObject(meta) || meta.rainNow !== false) return false;
  const value = clean(text);
  if (!value) return false;
  return /(还在下|正在下|一直下|雨没停|雨还没停)/.test(value);
}

/**
 * 这句话是不是把最近说过的事又当新鲜事说了一遍。
 * 只跟「她自己最近 3 天说过的话」比，避免把对方的经历误判成重复；
 * 返回撞上的原句，没撞上返回 ''。
 */
function repeatedRecentClaim(text, messages, now) {
  const candidate = compactForCompare(text);
  if (candidate.length < REPEATED_CLAIM_CHARS) return '';
  const current = asDate(now);
  const cutoff = current.getTime() - REPEATED_LOOKBACK_DAYS * 24 * 60 * 60000;
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message || message.role !== 'assistant') continue;
    const at = toDateOrNull(message.ts);
    if (at && at.getTime() < cutoff) break;
    const previous = compactForCompare(message.text);
    if (!previous) continue;
    if (commonSubstringLength(candidate, previous) >= REPEATED_CLAIM_CHARS) {
      return clean(message.text);
    }
  }
  return '';
}

/** 日记正文：去标题/围栏，合并空行，超过 180 字截断 */
function clipDiary(raw) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  text = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^#+\s*/, '')
    .replace(/^日记\s*[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  if (chars.length > DIARY_MAX_CHARS) {
    return `${chars.slice(0, DIARY_MAX_CHARS - 1).join('')}…`;
  }
  return text;
}

/** 日记是否照抄了当天事件的句子（去标点后连续 10 字重合就算） */
function diaryCopiesEvents(text, events) {
  const candidate = compactForCompare(text);
  if (!candidate) return false;
  return (Array.isArray(events) ? events : []).some((event) => {
    const source = compactForCompare(event && event.text);
    return source.length > 0 && commonSubstringLength(candidate, source) >= 10;
  });
}

function proactiveFallback(trigger, event, now, max = MAX_PROACTIVE_CHARS) {
  const pool = PROACTIVE_FALLBACKS[trigger] || PROACTIVE_FALLBACKS.idle;
  const extra = isPlainObject(event) ? hashString(clean(event.text)) : 0;
  const index = (minutesOfDay(now) + extra) % pool.length;
  const candidate = i18n.t(pool[index]);
  if (timeConflict(candidate, now)) {
    const neutral = PROACTIVE_FALLBACKS.idle;
    return clipOneLine(i18n.t(neutral[(index + 1) % neutral.length]), max);
  }
  return clipOneLine(candidate, max);
}

/** 最近对话（按时间正序）；读失败返回空数组，不让生活引擎因此停摆 */
function readRecentMessages(dir, character, limit = 50) {
  const id = character && typeof character.id === 'string' ? character.id : null;
  if (typeof dir !== 'string' || !dir || !id) return [];
  try {
    return store.readMessages(dir, id, { limit });
  } catch (error) {
    warn('读取最近对话失败', error);
    return [];
  }
}

/** 最近一条用户消息（从已读出的对话里取，避免重复读盘） */
function lastUserTextFrom(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message && message.role === 'user' && typeof message.text === 'string') {
      return message.text;
    }
  }
  return '';
}

/** 最近一条她自己的消息（用于保持地点/动作连续） */
function lastAssistantFrom(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message && message.role === 'assistant' && typeof message.text === 'string') {
      return { text: message.text, ts: message.ts || null };
    }
  }
  return null;
}

/** 回访素材：优先用 pickProactive 带来的原话；缺了就从最近对话补 */
function followupMetaFor(trigger, meta, messages, now) {
  const source = isPlainObject(meta) ? meta : {};
  if (trigger !== 'followup' || clean(source.sourceText)) return source;
  const topic = followupTopicFrom(messages, now);
  if (!topic) return source;
  return {
    ...topic,
    ...source,
    keyword: clean(source.keyword) || topic.keyword,
    sourceText: topic.sourceText,
    replyText: clean(source.replyText) || topic.replyText,
  };
}

/** 最近一条用户消息的原文（用于主动消息提示词） */
function readLastUserText(dir, character) {
  return lastUserTextFrom(readRecentMessages(dir, character));
}

/** 最近一条她自己的消息（用于保持地点/动作连续） */
function readLastAssistant(dir, character) {
  return lastAssistantFrom(readRecentMessages(dir, character));
}

function appendProactiveMessage(dir, character, message) {
  const id = character && typeof character.id === 'string' ? character.id : null;
  if (typeof dir !== 'string' || !dir || !id) return;
  try {
    store.appendMessage(dir, id, message);
  } catch (error) {
    warn('写入主动消息失败，消息未落盘', error);
  }
}

function makeProactiveMessage(text, trigger, now) {
  const current = asDate(now);
  return {
    id: `msg-${current.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    text,
    ts: localISOString(current),
    proactive: true,
    unread: true,
    trigger,
  };
}

/**
 * 生成并投递一条主动消息。
 * 静默时段 / 已关闭 / 已用过该触发源 / 全局上限已满 / 体力过低 → null。
 * 单条字数上限由表达维度决定（≤30：28 字；≥70：40 字；其余 34 字）；
 * 表达 ≤30 时不做 followup。实际频率由每周范围取数后的空闲时段计划控制。
 * 后台预算不足或模型失败 → 仍返回模板兜底消息（不返回 null）。
 * 成功时会把 day.proactive[trigger] 置 true 并写入 chat.jsonl；
 * day 写回 timeline 由调用方负责。
 *
 * @param {{ character?: object, now?: Date|string|number, day?: object, state?: object,
 *           trigger?: string, event?: object, memories?: object[], meta?: object,
 *           lastUserText?: string, recentMessages?: object[], profile?: object,
 *           settings?: object, dir?: string }} [input]
 * @returns {Promise<object|null>}
 */
/** 时段一致性：下午/傍晚不该出现夜间用语，上午之后不该出现开始一天的用语 */
const NIGHT_WORDS = /(今晚|晚安|早点睡|该睡了|该休息了|睡觉吧|夜里|深夜)/u;
const MORNING_WORDS = /(早安|早上好|起床|刚醒|刚睡醒|刚起来|刚开机|新的一天|今天开始|今天刚开始|^早[，,。！!\s])/u;
const DAYTIME_WORDS = /(上午|中午|下午)/u;

function timeConflict(text, now) {
  const hour = asDate(now).getHours();
  const value = typeof text === 'string' ? text : '';
  if (!value) return false;
  if (hour < 17 && NIGHT_WORDS.test(value)) return true;
  if (hour >= 11 && MORNING_WORDS.test(value)) return true;
  // 深夜说“上午/中午/下午”也属于时段错位；“明天下午”这种未来计划不算
  if ((hour >= 22 || hour < 5) && DAYTIME_WORDS.test(value) && !/明天/u.test(value)) return true;
  return false;
}

async function runProactive({
  character, now, day, trigger, event, meta, memories, lastUserText, recentMessages: recentInput,
  profile, settings, dir, state,
} = {}) {
  if (!PROACTIVE_TRIGGERS.includes(trigger)) return null;

  const current = asDate(now);
  const life = lifeSection(settings);
  if (life.enabled === false) return null;
  // 防御性二次检查：调用方可能没先过 pickProactive，静默时段一律不打扰
  if (isQuiet(settings, current)) return null;

  const dayRef = isPlainObject(day) ? day : null;
  const flags = normalizeProactive(dayRef ? dayRef.proactive : null);
  if (flags[trigger]) return null;
  // P7：表达 ≤30 时不发回访；当天上限按计划 slot 数放开
  if (trigger === 'followup' && expressivenessOf(character) <= EXPRESSIVE_LOW_CUT) return null;
  if (countUsedProactive(flags) >= proactiveDayLimit(dayRef, settings, character)) return null;
  // 防御性二次检查：单条不足 3 小时；同一天多条时不足 30 分钟，不重复打扰
  if (!proactiveGapOk(dayRef, current)) return null;
  if (dayRef && isPlainObject(dayRef.proactivePlan) && !proactiveSlotOpen(dayRef, current)) {
    return null;
  }

  // 体力过低时也补一层保护：调用方漏检也不会硬发
  const currentState = stateEngine.normalizeState(state, current);
  if (currentState.energy < 25) return null;

  // P7：单条字数上限由表达维度决定（28 / 34 / 40）
  const maxChars = proactiveMaxChars(character);

  const selectedEvent = isPlainObject(event)
    ? event
    : trigger === 'event'
      ? latestEvent(dayRef)
      : null;
  const recentMessages = Array.isArray(recentInput) && recentInput.length > 0
    ? recentInput
    : readRecentMessages(dir, character);
  const proactiveMeta = followupMetaFor(trigger, meta, recentMessages, current);

  let text = '';
  if (canRunBackground(dir, settings, current) && isUsableProfile(profile)) {
    try {
      const lastAssistant = lastAssistantFrom(recentMessages) || readLastAssistant(dir, character);
      const lastUser = clean(lastUserText)
        || lastUserTextFrom(recentMessages)
        || readLastUserText(dir, character);
      const baseMessages = prompt.buildProactiveMessages({
        character,
        now: current,
        trigger,
        event: selectedEvent,
        memories,
        lastUserText: lastUser,
        lastAssistant,
        recentMessages,
        meta: proactiveMeta,
        maxChars,
      });
      const result = await llm.chat({
        profile,
        messages: baseMessages,
        retry: 0,
        maxTokens: 800,
      });
      let candidate = clipOneLine(result && result.text, maxChars);
      recordBackground(dir, result && result.usage, current);

      const previousPlace = lastAssistant ? prompt.extractPlace(lastAssistant.text) : '';

      // 一致性守门：时段错位 / 地点凭空切换，纠正一次；仍不对就用模板兜底
      const conflicting = candidate && (
        timeConflict(candidate, current) || prompt.placeConflict(candidate, previousPlace)
      );
      if (conflicting) {
        const period = prompt.periodOf(current);
        const fixLines = [`现在是${period}，刚才那句不符合当下的情境。重写一句（≤${maxChars} 字）。`];
        if (timeConflict(candidate, current)) {
          fixLines.push(`现在是${period}，不要写与当前时段矛盾的内容：深夜不要写刚开机、刚醒、早安、今天开始，也不要提上午/中午/下午；白天不要写晚安、准备睡这类话。`);
        }
        if (previousPlace && prompt.placeConflict(candidate, previousPlace)) {
          fixLines.push(`你刚才还在${previousPlace}，不要凭空换地方；要移动就先说清怎么过去的。`);
        }
        fixLines.push('只输出一句话。');
        const retry = await llm.chat({
          profile,
          messages: [
            ...baseMessages,
            { role: 'assistant', content: candidate },
            { role: 'system', content: fixLines.join('') },
          ],
          retry: 0,
          maxTokens: 800,
        });
        recordBackground(dir, retry && retry.usage, current);
        const fixed = clipOneLine(retry && retry.text, maxChars);
        const stillBad = fixed && (
          timeConflict(fixed, current) || prompt.placeConflict(fixed, previousPlace)
        );
        candidate = fixed && !stillBad ? fixed : '';
      }

      // 重复守门：同一件小事不能换个说法再当新发现说一遍
      const repeated = candidate ? repeatedRecentClaim(candidate, recentMessages, current) : '';
      if (repeated) {
        const retry = await llm.chat({
          profile,
          messages: [
            ...baseMessages,
            { role: 'assistant', content: candidate },
            {
              role: 'system',
              content: `你最近已经说过「${clipOneLine(repeated, 30)}」这件事。`
                + '不要换个说法再说一遍，也不要把同一件小事当成新发现；'
                + `说点别的，或只问对方。只输出一句话（≤${maxChars} 字）。`,
            },
          ],
          retry: 0,
          maxTokens: 800,
        });
        recordBackground(dir, retry && retry.usage, current);
        const fixed = clipOneLine(retry && retry.text, maxChars);
        const stillBad = fixed && (
          timeConflict(fixed, current)
          || prompt.placeConflict(fixed, previousPlace)
          || repeatedRecentClaim(fixed, recentMessages, current)
        );
        candidate = fixed && !stillBad ? fixed : '';
      }
      // 天气守门：明确知道此刻已经不下雨时，不能再写「还在下 / 正在下」
      if (candidate && weatherRealtimeConflict(candidate, proactiveMeta)) candidate = '';
      text = candidate;
    } catch (error) {
      warn('生成主动消息失败，使用模板兜底', error);
      text = '';
    }
  }

  if (!text) text = proactiveFallback(trigger, selectedEvent, current, maxChars);
  text = clipOneLine(text, maxChars);
  if (!text) text = clipOneLine(i18n.t(PROACTIVE_FALLBACKS.idle[0]), maxChars);

  if (dayRef) {
    dayRef.proactive = { ...flags, [trigger]: true };
    dayRef.lastProactiveAt = localISOString(current);
    markProactiveSlotSent(dayRef, current);
  }
  const message = makeProactiveMessage(text, trigger, current);
  appendProactiveMessage(dir, character, message);

  // P3：主动说一句也要花点力气（-2 体力），失败不影响消息投递
  // 没传 dir（纯内存调用 / 单测）时没有可写位置，直接跳过
  const characterId = character && typeof character.id === 'string' ? character.id : null;
  if (characterId && typeof dir === 'string' && dir) {
    try {
      const stateSource = isPlainObject(state) ? state : stateEngine.readState(dir, characterId, current);
      const nextState = stateEngine.applyEvent(
        stateEngine.settleDay(stateSource, current),
        { energyCost: 2, now: current },
      );
      stateEngine.writeState(dir, characterId, nextState, current);
    } catch (error) {
      warn('主动消息后更新状态失败', error);
    }
  }

  return message;
}

// ---------------------------------------------------------------------------
// 日记
// ---------------------------------------------------------------------------

/**
 * 写当天日记（100–180 字）。
 * - 已有日记：幂等返回，不调模型；
 * - 预算不足 / 未配置模型：留空返回 null，不调模型；
 * - 模型失败：记 diaryAttempted，当天不再重试（Spec 8.3）。
 * @param {{ dir?: string, character?: object, date?: string, timeline?: object,
 *           profile?: object, settings?: object, recentChat?: object[],
 *           now?: Date|string|number }} [input]
 * @returns {Promise<{ timeline: object, diary: string|null }>}
 */
async function writeDiary({
  dir, character, date, timeline, profile, settings, recentChat, now = new Date(), state,
} = {}) {
  const current = asDate(now);
  const targetDate = typeof date === 'string' && date ? date : dayKey(current);
  const source = isPlainObject(timeline) ? timeline : safeReadTimeline(dir, character);
  const days = isPlainObject(source.days) ? { ...source.days } : {};
  const day = normalizeDayRecord(days[targetDate]);
  const result = (diary) => ({ timeline: { ...source, days }, diary });

  if (day.diary) return result(day.diary);
  if (day.diaryDeleted) return result(null);
  // 失败可以重试（额度/网络恢复后补上），但一天最多 3 次；成功后才不再写
  const diaryTries = Number.isFinite(Number(day.diaryTries)) ? Number(day.diaryTries) : 0;
  if (diaryTries >= 3) return result(null);
  if (lifeSection(settings).enabled === false) return result(null);
  if (!canRunBackground(dir, settings, current) || !isUsableProfile(profile)) {
    return result(null);
  }

  const currentState = isPlainObject(state)
    ? state
    : (typeof dir === 'string' && dir
      ? stateEngine.readState(dir, character && character.id, current)
      : null);
  const baseMessages = prompt.buildDiaryMessages({
    character,
    date: targetDate,
    events: day.events,
    recentChat,
    state: currentState,
  });

  try {
    const response = await llm.chat({
      profile,
      messages: baseMessages,
      retry: 0,
      maxTokens: 3000,
    });
    recordBackground(dir, response && response.usage, current);
    let text = clipDiary(response && response.text);
    // 日记把事件原句照抄过来（连续 10 字重合）→ 重写一次，换成自己的话
    if (text && diaryCopiesEvents(text, day.events)) {
      try {
        const retry = await llm.chat({
          profile,
          messages: [
            ...baseMessages,
            { role: 'assistant', content: text },
            {
              role: 'system',
              content: '这一稿把上面素材里的原句抄进去了。重写：只挑一两件，写当时的感受，'
                + '用自己的话，100–180 字，不要再出现素材里的原句。',
            },
          ],
          retry: 0,
          maxTokens: 3000,
        });
        recordBackground(dir, retry && retry.usage, current);
        const fixed = clipDiary(retry && retry.text);
        if (fixed && !diaryCopiesEvents(fixed, day.events)) text = fixed;
      } catch (error) {
        warn('日记重写失败，沿用初稿', error);
      }
    }
    if (!text) {
      day.diaryAttempted = true;

      day.diaryTries = diaryTries + 1;
      days[targetDate] = day;
      safeWriteTimeline(dir, character, { ...source, days });
      return result(null);
    }
    if (charLength(text) < DIARY_MIN_CHARS) {
      // 模型没按要求写够：按「失败」处理，当天留空且不重试（Spec 8.3）
      warn(`日记偏短（${charLength(text)} 字），当天留空`);
      day.diaryAttempted = true;

      day.diaryTries = diaryTries + 1;
      days[targetDate] = day;
      safeWriteTimeline(dir, character, { ...source, days });
      return result(null);
    }
    day.diary = text;
    day.diaryAt = localISOString(current);
    days[targetDate] = day;
    safeWriteTimeline(dir, character, { ...source, days });
    return { timeline: { ...source, days }, diary: text };
  } catch (error) {
    warn('写日记失败，当天留空且不重试', error);
    day.diaryAttempted = true;

    day.diaryTries = diaryTries + 1;
    days[targetDate] = day;
    safeWriteTimeline(dir, character, { ...source, days });
    return result(null);
  }
}

module.exports = {
  defaultSchedule,
  birthdayScheduleItem,
  withBirthdaySchedule,
  withProjectSchedule,
  withWorkAnchor,
  withRoutineAnchors,
  validateSchedule,
  ensureSchedule,
  advanceEvents,
  pickProactive,
  runProactive,
  eventTemplate,
  eventStateEffect,
  writeDiary,
  diaryCopiesEvents,
  timeConflict,
  scheduleOverlap,
  // 便于其他模块 / 测试复用
  EVENT_TEMPLATES,
  EVENT_STATE_EFFECTS,
  PROACTIVE_FALLBACKS,
  PROACTIVE_TRIGGERS,
  PROACTIVE_PRIORITY,
  followupKeyword,
  MAX_PROACTIVE_CHARS,
  LOW_EXPRESSIVE_CHARS,
  MID_EXPRESSIVE_CHARS,
  proactiveMaxChars,
  proactiveDailyLimit,
  proactiveDayLimit,
  proactiveWeekRange,
  proactiveAffinity,
  proactiveGapOk,
  proactiveSlotMinutesList,
  ensureProactivePlan,
  proactiveSlotOpen,
  eventTextFor,
  weatherRealtimeConflict,
  parseDetailLines,
  recentDetails,
  fillScheduleDetails,
  expressivenessOf,
  DIARY_MIN_CHARS,
  DIARY_MAX_CHARS,
  SCHEDULE_MAX_WITH_BIRTHDAY,
  SCHEDULE_MAX_WITH_PROJECT,
  DEFAULT_BOOT_DELAY_MINUTES,
  DEFAULT_EVENT_WINDOW_MINUTES,
  DEFAULT_IDLE_HOURS,
  BEDTIME_WINDOW_MINUTES,
  BEDTIME_MAX_ENERGY,
};
