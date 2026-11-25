'use strict';

// 长期项目（P5 / specs/2026-10-27-life-v2-design.md 第 5 节）：读书 / 练琴 / 画画 / 健身。
// 纯逻辑：不读盘、不调模型、不依赖 electron，方便单测。
//
// 约定：
// - 日期归属按本地时区（禁止 toISOString 切天）。
// - 所有函数都不改入参：normalizeProjects / advanceProject 返回新数组。
// - 进度只在 0..total 之间；到 total 即标记 done，不自动回退。
// - 晚间推进时间用「日期 + 项目 id」做种子，同一天同一项目结果稳定（19:00–22:00）。
// - 不替用户创建项目：ensureProjectEntry 恒返回 null，是否开始一个新项目由用户决定。

const KINDS = ['book', 'music', 'drawing', 'fitness', 'other'];
const i18n = require('./i18n');
const KIND_LABELS = {
  book: '读书',
  music: '练琴',
  drawing: '画画',
  fitness: '健身',
  other: '其他',
};

// unit 只接受这几个中文单位；缺省按类型给一个合理的。
const UNITS = ['页', '章', '首', '次', '张'];
const DEFAULT_UNITS = {
  book: '页',
  music: '首',
  drawing: '张',
  fitness: '次',
  other: '次',
};

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PROJECT_START_MINUTES = 19 * 60; // 19:00
const PROJECT_END_MINUTES = 22 * 60; // 22:00
const MAX_PROGRESS = 100000;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function asDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const date = value === undefined || value === null ? new Date() : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function dateKey(date = new Date()) {
  const value = asDate(date);
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function minutesToTime(minutes) {
  const value = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  return `${pad2(Math.floor(value / 60))}:${pad2(value % 60)}`;
}

function hashString(text) {
  let hash = 0;
  for (const ch of String(text)) {
    hash = (hash * 31 + ch.codePointAt(0)) % 1000003;
  }
  return Math.abs(hash);
}

function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value.trim());
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }
  return null;
}

function clampInt(value, min, max, fallback) {
  const number = toInt(value);
  if (number === null) return fallback;
  return Math.max(min, Math.min(max, number));
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

function normalizeProject(raw, index, now) {
  if (!isPlainObject(raw)) return null;
  const title = clean(raw.title);
  if (!title) return null;

  const kindText = clean(raw.kind);
  const kind = KINDS.includes(kindText) ? kindText : 'other';

  const progressRaw = clampInt(raw.progress, 0, MAX_PROGRESS, 0);
  // total 缺失 / 非法（<=0）时按「至少走到当前进度」兜底，避免整条项目作废
  const totalNumber = toInt(raw.total);
  const total = totalNumber !== null && totalNumber >= 1
    ? Math.min(totalNumber, MAX_PROGRESS)
    : Math.max(progressRaw, 1);
  const statusRaw = clean(raw.status);

  let progress = Math.min(progressRaw, total);
  // 明确标成 done 的项目，进度补齐到 total（设置页把「完成」当开关用）
  if (statusRaw === 'done') progress = total;
  const status = statusRaw === 'done' || progress >= total ? 'done' : 'active';

  const startedAt = DATE_KEY_PATTERN.test(clean(raw.startedAt))
    ? clean(raw.startedAt)
    : dateKey(now);

  const unitText = clean(raw.unit);
  const unit = UNITS.includes(unitText) ? unitText : DEFAULT_UNITS[kind];

  return {
    id: clean(raw.id) || `p${index + 1}`,
    title,
    kind,
    progress,
    total,
    startedAt,
    status,
    unit,
  };
}

/**
 * 清洗 life.projects。
 * - 非数组 → []；数组里的非对象 / 无标题条目丢弃；
 * - id 缺失补 `p<序号>`，重复的 id 追加后缀；
 * - progress / total 夹到合法范围，progress > total 时按 total 截断；
 * - status 缺失时按 progress >= total 推断，显式 done 时进度补齐到 total；
 * - unit 不在白名单时按 kind 给默认值。
 *
 * @param {unknown} raw
 * @param {Date|string|number} [now] startedAt 缺失时用它的日期
 * @returns {Array<{id:string,title:string,kind:string,progress:number,total:number,
 *                  startedAt:string,status:string,unit:string}>}
 */
function normalizeProjects(raw, now = new Date()) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const usedIds = new Set();
  raw.forEach((item, index) => {
    const project = normalizeProject(item, index, now);
    if (!project) return;
    let id = project.id;
    while (usedIds.has(id)) id = `${id}-${out.length + 1}`;
    usedIds.add(id);
    out.push({ ...project, id });
  });
  return out;
}

/** 读取 character.life.projects（容错：任意形状都返回数组） */
function projectsOf(character) {
  const life = isPlainObject(character) && isPlainObject(character.life) ? character.life : {};
  return normalizeProjects(life.projects);
}

/**
 * 第一个进行中的项目：按 startedAt 升序（同一天按 id），没有返回 null。
 * @param {unknown} projects
 * @returns {object|null}
 */
function activeProject(projects) {
  const list = normalizeProjects(projects).filter((project) => project.status === 'active');
  if (list.length === 0) return null;
  list.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  return list[0];
}

/** 按 id 找项目（找不到返回 null） */
function findProject(projects, id) {
  const key = clean(id);
  if (!key) return null;
  return normalizeProjects(projects).find((project) => project.id === key) || null;
}

/**
 * 推进一个项目（不改入参）。
 * - 找不到 id → 原样返回，completed=false，project=null；
 * - 已完成的项目不再推进（避免同一天重复记账）；
 * - delta 非正数 / 非法 → 不推进；
 * - progress 到达 total → status 变 done，completed=true。
 *
 * @param {unknown} projects
 * @param {string} id
 * @param {number} [delta]
 * @returns {{ projects: Array<object>, completed: boolean, project: object|null }}
 */
function advanceProject(projects, id, delta = 1) {
  const list = normalizeProjects(projects);
  const key = clean(id);
  const index = list.findIndex((project) => project.id === key);
  if (index < 0) return { projects: list, completed: false, project: null };

  const current = list[index];
  if (current.status === 'done') {
    return { projects: list, completed: false, project: { ...current } };
  }

  const step = Number.isFinite(Number(delta)) ? Math.max(0, Math.floor(Number(delta))) : 0;
  if (step === 0) return { projects: list, completed: false, project: { ...current } };

  const progress = Math.min(current.total, current.progress + step);
  const status = progress >= current.total ? 'done' : 'active';
  const project = { ...current, progress, status };
  const next = list.slice();
  next[index] = project;
  return {
    projects: next,
    completed: status === 'done',
    project,
  };
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/** 取标题里的书名号部分（没有就整体套上），避免「读完读完《X》」这种重复动词 */
function projectRef(title) {
  const text = clean(title);
  const matched = /《[^》]+》/.exec(text);
  if (matched) return matched[0];
  return `《${text}》`;
}

/**
 * 项目一句话（提示词 / 设置页共用）：`「读完《X》」第 3/12 页`。
 * 已完成时给 `「读完《X》」已完成（12/12 页）`。
 * @param {unknown} project
 * @returns {string}
 */
function projectLine(project) {
  const value = normalizeProjects([project])[0];
  if (!value) return '';
  const unit = value.unit ? ` ${value.unit}` : '';
  if (value.status === 'done') {
    return `「${value.title}」已完成（${value.progress}/${value.total}${unit}）`;
  }
  return `「${value.title}」第 ${value.progress}/${value.total}${unit}`;
}

/** 事件文本后的进度短语：`读到第 4/12 页` */
function progressLine(project) {
  const value = normalizeProjects([project])[0];
  if (!value) return '';
  const numbers = `${value.progress}/${value.total} ${value.unit}`;
  switch (value.kind) {
    case 'book':
      return `读到第 ${numbers}`;
    case 'music':
      return `练到第 ${numbers}`;
    case 'drawing':
      return `画到第 ${numbers}`;
    case 'fitness':
      return `练到第 ${numbers}`;
    default:
      return `做到 ${value.progress}/${value.total}`;
  }
}

/** 完成时写进记忆卡的文本：`她读完了《X》` */
function completionText(project) {
  const value = normalizeProjects([project])[0];
  if (!value) return '';
  if (i18n.getLanguage() === 'en') {
    const name = clean(value.title).replace(/^《/, '').replace(/》$/, '');
    const ref = `“${name}”`;
    switch (value.kind) {
      case 'book':
        return `She finished reading ${ref}`;
      case 'music':
        return `She finished practicing ${ref}`;
      case 'drawing':
        return `She finished drawing ${ref}`;
      case 'fitness':
        return `She finished her ${ref} workout`;
      default:
        return `She finished ${ref}`;
    }
  }
  const ref = projectRef(value.title);
  switch (value.kind) {
    case 'book':
      return `她读完了${ref}`;
    case 'music':
      return `她练完了${ref}`;
    case 'drawing':
      return `她画完了${ref}`;
    case 'fitness':
      return `她练完了${ref}`;
    default:
      return `她完成了${ref}`;
  }
}

/** 晚间日程文本：`读完《X》十页` */
function projectActivityText(project) {
  const value = normalizeProjects([project])[0];
  if (!value) return '';
  if (i18n.getLanguage() === 'en') {
    const name = clean(value.title).replace(/^《/, '').replace(/》$/, '');
    const ref = `“${name}”`;
    switch (value.kind) {
      case 'book':
        return `Read ten pages of ${ref}`;
      case 'music':
        return `Practiced ${ref} for half an hour`;
      case 'drawing':
        return `Drew a piece for ${ref}`;
      case 'fitness':
        return `Did a set of ${ref}`;
      default:
        return `Spent some time on ${ref}`;
    }
  }
  const ref = projectRef(value.title);
  switch (value.kind) {
    case 'book':
      return `读完${ref}十页`;
    case 'music':
      return `练${ref}半小时`;
    case 'drawing':
      return `画${ref}一张`;
    case 'fitness':
      return `练${ref}一组`;
    default:
      return `花点时间做${ref}`;
  }
}

// ---------------------------------------------------------------------------
// 日程
// ---------------------------------------------------------------------------

/**
 * 生成一条晚间项目活动：时间在 19:00–22:00 之间抖动，用日期做种子，
 * 同一天同一项目多次调用结果一致。
 *
 * @param {unknown} project
 * @param {Date|string|number} [now]
 * @returns {{ time: string, activity: string, category: 'project' } | null}
 */
function projectActivity(project, now = new Date()) {
  const value = normalizeProjects([project], now)[0];
  if (!value) return null;
  const date = dateKey(now);
  const span = PROJECT_END_MINUTES - PROJECT_START_MINUTES;
  const offset = hashString(`${date}|${value.id}|project`) % (span + 1);
  return {
    time: minutesToTime(PROJECT_START_MINUTES + offset),
    activity: projectActivityText(value),
    category: 'project',
  };
}

/**
 * 没有项目时是否补一个默认项目：不补，返回 null。
 * 项目是用户的长期意愿（读哪本书、练哪首曲子），替用户决定反而会生成她不认的事。
 * 保留这个函数是为了让调用方的意图显式化，也方便日后改成「按人设推荐」。
 * @param {object} [character]
 * @returns {null}
 */
function ensureProjectEntry(character) { // eslint-disable-line no-unused-vars
  return null;
}

module.exports = {
  KINDS,
  KIND_LABELS,
  UNITS,
  DEFAULT_UNITS,
  normalizeProjects,
  projectsOf,
  activeProject,
  findProject,
  advanceProject,
  projectLine,
  progressLine,
  completionText,
  projectActivity,
  projectActivityText,
  ensureProjectEntry,
  // 便于测试复用
  PROJECT_START_MINUTES,
  PROJECT_END_MINUTES,
};
