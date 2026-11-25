'use strict';

// 活动池与每日抽样（P2 / specs/2026-10-27-life-v2-design.md 第 1、2.2、2.3、3 节）。
// 纯逻辑：不读盘、不调模型、不依赖 electron，方便单测。
//
// 约定：
// - 活动准入是「硬过滤」：不符合 2.2 的条目直接丢弃，不做加权。
// - 每日抽样 0 次模型调用；同一天同一角色多次调用结果一致（用日期 + 角色 id 做种子）。
// - 兜底池完全本地生成，严格按允许集合与职业构造（自由职业不会出现通勤/开会，
//   内向不会出现聚会/人群密集）。
// - 返回的日程项形如 { time: 'HH:MM', activity: '活动原文', category }，
//   活动文本原样保留，不改写。

const promptModule = require('./prompt');
const calendar = require('./calendar');
const content = require('./content');

const CATEGORIES = [
  'work', 'chore', 'selfcare', 'home',
  'solo_out', 'crowd', 'social', 'visit',
  'create', 'discovery',
];

const CATEGORY_LABELS = {
  work: '工作（通勤/开会/打卡）',
  chore: '家务',
  selfcare: '照顾自己',
  home: '待在家',
  solo_out: '独自出门',
  crowd: '人群密集处',
  social: '聚会/多人场合',
  visit: '见朋友亲戚',
  create: '创作/赶稿',
  discovery: '小发现/小意外',
};

const OCCUPATION_KINDS = {
  employed: [
    '上班', '在职', '公司', '企业', '单位', '职员', '员工', '上班族', '白领',
    '教师', '老师', '教授', '医生', '护士', '会计', '律师', '公务员',
    '程序员', '工程师', '销售', '店长', '店员', '前台', '行政', '人事',
    '运营', '银行', '事业单位', '国企', '外企', '主管', '经理', '总监',
    '秘书', '技师', '厨师', '司机', '保安', '工人', '技术员',
  ],
  freelance: [
    '自由职业', '自由撰稿', '自由插画', '自由设计', '自由摄影', '自由画家',
    '自由音乐', '自由开发者', '自由译者', '自由人', '自由艺术家',
    '独立开发者', '独立设计师', '独立插画师', '独立撰稿', '独立创作', '自由',
  ],
  creative: [
    '设计', '插画', '画师', '画家', '艺术', '作家', '写作', '撰稿', '文案',
    '编剧', '摄影', '音乐', '作曲', '导演', '动画', '创意', '手作', '陶艺',
    '漫画', '剪辑', '策展', '编辑', '记者', '画画', '绘画', '小说', '散文',
    '诗歌', '写歌',
  ],
  student: ['学生', '大学生', '研究生', '博士生', '硕士', '高中生', '在读', '念书', '读书'],
  none: [
    '无职业', '待业', '无业', '暂无职业', '失业', '全职在家', '家庭主妇',
    '退休', '家里蹲', '没有工作',
  ],
};

const CREATIVE_RE = new RegExp(`(${OCCUPATION_KINDS.creative.join('|')})`);

// 文本兜底：模型偶尔会把「通勤/聚会」写进 home 之类的类别里。
// 类别不可用时，命中这些词的条目一并丢弃（对应验收 2/3/4 的「日程里不出现」）。
const CONFLICT_WORDS = {
  work: /(通勤|打卡|开会|坐班|上班)/,
  social: /(聚会|饭局|团建|派对)/,
  create: /(赶稿|截稿|交稿|改稿|画稿)/,
};

const TIME_SLOTS = {
  morning: { start: 6 * 60, end: 11 * 60 },
  midday: { start: 11 * 60, end: 18 * 60 },
  evening: { start: 18 * 60, end: 23 * 60 },
};

// 时段可用类型。social / visit 在 spec 里没有明确归入某个时段，
// 这里放进「午」（午饭聚会、下午串门），否则这两类永远排不进日程。
const PERIOD_CATEGORIES = {
  morning: ['home', 'chore', 'selfcare'],
  midday: ['work', 'create', 'solo_out', 'crowd', 'social', 'visit'],
  evening: ['home', 'create', 'discovery'],
};

// 时间基准（分钟）。19:30 留给生日条目：抖动后正好压在 19:30 的会统一 +5 分钟。
const BASE_TIMES = {
  morning: 8 * 60,
  middayFirst: 11 * 60 + 30,
  middaySecond: 15 * 60,
  evening: 18 * 60 + 45,
  discovery: 21 * 60,
};

const JITTER_MINUTES = 25;
const POOL_MIN_ITEMS = 12;
const POOL_MAX_ITEMS = 20;
const POOL_TARGET_ITEMS = 18;
const PARSE_MIN_ITEMS = 6;
const DAY_MIN_ITEMS = 3;
const DAY_MAX_ITEMS = 5;
const RECENT_DAYS = 7;
const VISIT_WINDOW_DAYS = 30;
const VISIT_MAX_PER_WINDOW = 2;
const SOLO_OUT_MAX_PER_WEEK = 3;

// P7：规律 / 节奏两个维度真正作用到日程上（spec 2 五维）。
// - 规律 ≥70：时间贴固定锚点（08:00 / 12:30 / 15:30 / 19:30），抖动只有 ±10 分钟；
// - 规律 ≤30：抖动放大到 ±45 分钟，体现「计划常改、作息不固定」；
// - 中间：±25 分钟（原来的行为）。
const STRUCTURE_HIGH_CUT = 70;
const STRUCTURE_LOW_CUT = 30;
const HIGH_STRUCTURE_JITTER = 10;
const LOW_STRUCTURE_JITTER = 45;
const HIGH_STRUCTURE_ANCHORS = {
  morning: 8 * 60,
  midday: 12 * 60 + 30,
  afternoon: 15 * 60 + 30,
  evening: 19 * 60 + 30,
};
// 生日条目固定 19:30，日程时间撞上就往后错 5 分钟
const BIRTHDAY_MINUTES = 19 * 60 + 30;
const BIRTHDAY_SHIFT_MINUTES = 5;
// 高规律时几个晚间条目共用 19:30 锚点，用互不重叠的小窗口错开，
// 避免同一分钟塞进三件事（都仍在锚点 ±10 分钟内）。
const HIGH_STRUCTURE_WINDOWS = {
  evening: [1, 5],
  discovery: [6, 10],
  bonus: [-9, -5],
};

// 节奏：每天条数。低节奏少而稀，高节奏排满 5 条，并允许追加 1 条「顺路」活动。
const PACE_HIGH_CUT = 70;
const PACE_LOW_CUT = 30;
const DAY_TARGET_LOW = 3;
const DAY_TARGET_MID = 4;
const DAY_TARGET_HIGH = 5;
// 高节奏的「顺路」条目只在这两类里挑（都是无门槛的日常小事）
const BONUS_CATEGORIES = ['discovery', 'selfcare'];

// 地点连续性（P8）：日程不是一堆互不相干的碎片，人得「来去有路径」。
// - 20:00 之后只排室内：晚上不会出现「去小店」「路边看猫」这种户外条目；
// - 居家（室内 home/chore/selfcare）之后不立刻外出：要出门至少间隔 120 分钟；
// - 外出 → 室内永远允许（回家不需要间隔）。
const EVENING_INDOOR_FROM = 20 * 60;
const LEAVE_HOME_MIN_GAP = 120;
const HOME_INDOOR_CATEGORIES = ['home', 'chore', 'selfcare'];
// 修剪后不足 3 条时优先补这两类（室内、无门槛）
const INDOOR_SUPPLEMENT_CATEGORIES = ['home', 'selfcare'];

// P4：天气 / 节日权重（spec 第 4 节）
const OUTDOOR_CATEGORIES = ['solo_out', 'crowd', 'visit'];
const RAIN_OUTDOOR_WEIGHT = 0.3;
const RAIN_INDOOR_WEIGHT = 1.2;
const CLEAR_WEEKEND_EMPLOYED_SOLO_OUT_WEIGHT = 1.4;
const CLEAR_FREELANCE_SOLO_OUT_WEIGHT = 1.2;
// 节日条目固定在这两个时间点，避开生日 19:30；晚间时段允许 home/create/discovery
const FESTIVAL_TIMES = { evening: '19:00', midday: '12:00' };
const FESTIVAL_EVENING_CATEGORIES = ['home', 'create', 'discovery'];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }
  const text = clean(value);
  return text ? [text] : [];
}

/** 角色明确排除的活动词（life.forbiddenActivities），用于过滤活动池 */
function forbiddenActivityWords(character) {
  const life = isPlainObject(character && character.life) ? character.life : {};
  return asList(life.forbiddenActivities).filter(Boolean);
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampInt(value, min, max, fallback) {
  const number = toNumber(value);
  if (number === null) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateKey(date = new Date()) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(date);
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function localDateFromKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(key));
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateOrNull(value) {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hashString(text) {
  let hash = 0;
  for (const ch of String(text)) {
    hash = (hash * 31 + ch.codePointAt(0)) % 1000003;
  }
  return Math.abs(hash);
}

/** 抽样上下文里的天气：缺字段时按「无影响」处理 */
function normalizeWeatherContext(input) {
  const src = isPlainObject(input) ? input : {};
  const code = clean(src.code);
  const isRain = src.isRain === true || ['rain', 'shower', 'thunder'].includes(code);
  const isSnow = code === 'snow';
  const isClear = src.isClear === true || code === 'clear';
  return { code, isRain, isSnow, isWet: isRain || isSnow, isClear };
}

/** 抽样上下文里的节日：接受 { name, kind } 或纯名字 */
function normalizeHolidayContext(input) {
  if (typeof input === 'string') return clean(input) ? { name: clean(input), kind: 'solar' } : null;
  if (!isPlainObject(input)) return null;
  const name = clean(input.name);
  if (!name) return null;
  return { name, kind: input.kind === 'lunar' ? 'lunar' : 'solar' };
}

function isWeekendDate(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** 活动文本归一化（去标点空白），用于「最近 7 天出现过」判断 */
function normalizeText(text) {
  return String(text == null ? '' : text).replace(/[\s，。、,.;；:：!！?？"'“”‘’（）()\-—…]/gu, '');
}

function minutesToTime(minutes) {
  const value = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  return `${pad2(Math.floor(value / 60))}:${pad2(value % 60)}`;
}

/** 'HH:MM' → 分钟；格式不对返回 null */
function timeToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clean(text));
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 条目的地点属性：只有显式 indoor === true 才算室内 */
function isIndoorItem(item) {
  return Boolean(item) && item.indoor === true;
}

/**
 * 地点连续性修剪（P8）。rows 必须已按时间升序排好。
 * - time >= 20:00 的条目必须是室内，否则剔除；
 * - 上一条是「室内 home/chore/selfcare」时，下一条户外要求间隔 ≥120 分钟且 <20:00；
 * - 户外 → 室内永远允许。
 *
 * @param {Array<{time?: string, category?: string, indoor?: boolean}>} rows
 * @param {(row: object) => boolean} [indoorOf] 取地点属性的方法；缺省读 row.indoor
 * @returns {Array<object>} 保留的条目（保持原顺序）
 */
/** 需要「离开家」的措辞（室内目的地也算：去小店/书店仍然要出门） */
const AWAY_WORDS = /(出门|走去|走到|去趟|去了|去那|逛街|散步|跑步|路过|路上|外面|门外|路边|街上|街头|巷口|公园|书店|便利店|超市|菜市场|商场|市集|咖啡馆|咖啡店|小店|展览|看展|影院|电影院|餐厅|饭馆|串门|拜访|公司|办公室|地铁|公交|楼下|街角)/u;
const AT_HOME_WORDS = /(家里|在家|床头|书架|阳台|厨房|窗边|沙发|被窝|房间|桌上|衣柜|冰箱|浴室|地毯|毯子|地板|窗台)/u;

/**
 * 这条活动是否需要出门。
 * 不能只看 indoor：模型会把「去小店」标成 indoor（店里确实是室内），
 * 但那是「离家」，晚间/居家后都不该出现。
 */
function isAwayItem(item) {
  const raw = item && (item.text || item.activity);
  const text = clean(raw).replace(/(不想|懒得出门|没出门|不出门)/gu, '');
  const atHome = AT_HOME_WORDS.test(text);
  const awayWord = AWAY_WORDS.test(text);
  if (atHome && !awayWord) return false;
  if (awayWord) return true;
  const category = clean(item && item.category);
  if (['solo_out', 'crowd', 'social', 'visit', 'work'].includes(category)) return true;
  if (item && item.indoor === false) return true;
  return false;
}

function pruneScheduleByLocation(rows) {
  const list = Array.isArray(rows) ? rows.filter(isPlainObject) : [];
  const kept = [];
  for (const row of list) {
    const away = isAwayItem(row);
    const minutes = timeToMinutes(row.time);

    // 1) 20:00 之后只留「不出门」的活动（在家做什么都行）
    if (minutes !== null && minutes >= EVENING_INDOOR_FROM && away) continue;

    // 2) 已经在家待着，之后要出门：至少隔 2 小时，且必须在天黑前
    if (away) {
      const previous = kept.length > 0 ? kept[kept.length - 1] : null;
      if (previous && !isAwayItem(previous)) {
        const previousMinutes = timeToMinutes(previous.time);
        const gap = minutes !== null && previousMinutes !== null ? minutes - previousMinutes : 0;
        const enoughGap = gap >= LEAVE_HOME_MIN_GAP && minutes < EVENING_INDOOR_FROM;
        if (!enoughGap) continue;
      }
    }

    // 3) 从外面回家永远允许
    kept.push(row);
  }
  return kept;
}

/**
 * 「顺路」条目的候选过滤：沿用前一条的地点属性（规则 4）。
 * - 前一条室内 → 顺路只能室内；
 * - 前一条户外 → 室内 / 户外都可以，但 20:00 后仍只留室内（规则 1）。
 *
 * @param {Array<object>} candidates
 * @param {{ previousIndoor?: boolean, minutes?: number }} [previous]
 * @returns {Array<object>}
 */
function bonusCandidatesForContinuity(candidates, { previousIndoor, minutes } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const mustStayHome = previousIndoor === true
    || (Number.isFinite(minutes) && minutes >= EVENING_INDOOR_FROM);
  if (!mustStayHome) return list;
  return list.filter((item) => !isAwayItem(item));
}

/**
 * 作息窗口：角色声明「常在 20:00–23:30 活动」时，
 * 把 18:00 之后的条目整体挪进窗口，保证「她说自己睡得晚」和日程一致。
 */
function applyActiveWindow(rows, activeFrom, activeTo) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const from = Number.isFinite(activeFrom) ? activeFrom : null;
  const to = Number.isFinite(activeTo) ? activeTo : 23 * 60 + 30;
  if (!from) return list;
  const eveningCut = 18 * 60;
  let cursor = from;
  for (const row of list) {
    const minutes = timeToMinutes(row.time);
    if (minutes === null || minutes < eveningCut) continue;
    if (minutes >= from) continue;
    const next = Math.min(Math.max(from, cursor), to - 10);
    row.time = minutesToTime(next);
    cursor = next + 15;
  }
  list.sort((a, b) => a.time.localeCompare(b.time));
  return list;
}

function localISOString(date = new Date()) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
    + `T${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

// ---------------------------------------------------------------------------
// 职业 / 五维
// ---------------------------------------------------------------------------

function occupationText(character) {
  const life = isPlainObject(character) && isPlainObject(character.life) ? character.life : {};
  return clean(life.occupation);
}

function occupationKind(character) {
  const text = occupationText(character);
  if (!text) return 'none';

  const has = (kind) => OCCUPATION_KINDS[kind].some((word) => text.includes(word));
  if (has('none')) return 'none';
  if (has('student')) return 'student';
  if (has('freelance')) return 'freelance';
  if (has('employed')) return 'employed';
  if (has('creative')) return 'creative';
  return 'none';
}

/** 职业或爱好是否含创作属性（create 的准入依据） */
function hasCreative(character) {
  const c = isPlainObject(character) ? character : {};
  const life = isPlainObject(c.life) ? c.life : {};
  const persona = isPlainObject(c.persona) ? c.persona : {};
  const texts = [
    occupationText(c),
    ...asList(life.hobbies),
    ...asList(persona.likes),
  ].filter(Boolean);
  return texts.some((text) => CREATIVE_RE.test(text));
}

function normalizeProfile(input, character) {
  const src = isPlainObject(input) ? input : {};
  const inner = isPlainObject(character)
    && isPlainObject(character.persona)
    && isPlainObject(character.persona.inner)
    && isPlainObject(character.persona.inner.profile)
    ? character.persona.inner.profile
    : {};
  const pickValue = (key) => {
    const value = src[key] !== undefined ? src[key] : inner[key];
    return clampInt(value, 0, 100, 50);
  };
  return {
    social: pickValue('social'),
    structure: pickValue('structure'),
    openness: pickValue('openness'),
    pace: pickValue('pace'),
    expressiveness: pickValue('expressiveness'),
  };
}

function normalizeState(input) {
  const src = isPlainObject(input) ? input : {};
  return {
    mood: clampInt(src.mood, 0, 100, 60),
    energy: clampInt(src.energy, 0, 100, 60),
    focus: clampInt(src.focus, 0, 100, 60),
  };
}

// ---------------------------------------------------------------------------
// 准入
// ---------------------------------------------------------------------------

/**
 * 允许的活动类型（spec 2.2 + 2.3 硬约束）。
 * 返回数组，按 CATEGORIES 顺序排列。
 * @param {{ character?: object, profile?: object, state?: object }} [ctx]
 * @returns {string[]}
 */
function allowedCategories({ character, profile, state } = {}) {
  const p = normalizeProfile(profile, character);
  const s = normalizeState(state);
  const kind = occupationKind(character);
  const creative = hasCreative(character);

  const allowed = new Set(['home', 'chore', 'selfcare', 'discovery']);

  // 2.2
  if (p.social >= 70 && p.openness >= 60) allowed.add('social');
  if (p.social >= 55) allowed.add('visit');
  if (p.social >= 60) allowed.add('crowd');
  if (p.openness >= 45) allowed.add('solo_out');
  if (kind === 'employed') allowed.add('work');
  if (creative) allowed.add('create');

  // 2.3 状态影响
  if (s.energy < 30) {
    allowed.delete('social');
    allowed.delete('crowd');
    allowed.delete('solo_out');
  }
  if (s.focus < 40) allowed.delete('create');

  return CATEGORIES.filter((category) => allowed.has(category));
}

function needsSatisfied(item, { character, profile }) {
  const p = normalizeProfile(profile, character);
  const kind = occupationKind(character);
  const needs = isPlainObject(item.needs) ? item.needs : {};

  const socialMin = clampInt(needs.socialMin, 0, 100, 0);
  if (p.social < socialMin) return false;
  const opennessMin = clampInt(needs.opennessMin, 0, 100, 0);
  if (p.openness < opennessMin) return false;

  const occupation = needs.occupation;
  if (occupation !== undefined && occupation !== null && occupation !== '') {
    const list = Array.isArray(occupation) ? occupation : [occupation];
    const wanted = list.map((entry) => clean(entry)).filter(Boolean);
    if (wanted.length > 0) {
      const matched = wanted.some((entry) => entry === kind || (entry === 'creative' && hasCreative(character)));
      if (!matched) return false;
    }
  }
  return true;
}

/**
 * 逐条过硬约束：category 在允许集合内，且 needs 满足。
 * @param {Array<object>} items
 * @param {{ character?: object, profile?: object, state?: object }} [ctx]
 * @returns {Array<object>}
 */
function filterPool(items, ctx = {}) {
  const list = Array.isArray(items) ? items : [];
  const allowed = new Set(allowedCategories(ctx));
  const forbidden = forbiddenActivityWords(ctx.character);
  const out = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const category = clean(item.category);
    if (!CATEGORIES.includes(category) || !allowed.has(category)) continue;
    const text = clean(item.text);
    if (!text) continue;
    // 角色明确排除的活动（如画画、图书馆）一律丢弃
    if (forbidden.some((word) => text.includes(word))) continue;
    // solo_out 必须是真的「一个人出门」，显式标成 false 的丢弃
    if (category === 'solo_out' && item.solo === false) continue;
    // 类别不可用时，文本里也不许出现该类活动的关键字
    let conflicted = false;
    for (const [blocked, pattern] of Object.entries(CONFLICT_WORDS)) {
      if (!allowed.has(blocked) && pattern.test(text)) {
        conflicted = true;
        break;
      }
    }
    if (conflicted) continue;
    if (!needsSatisfied(item, ctx)) continue;
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 兜底池（不调模型）
// ---------------------------------------------------------------------------

// 静态素材：每条都自带 needs，兜底池同样要过 filterPool。
const FALLBACK_ENTRIES = content.fallbackEntries;

function normalizeFallbackEntry(entry, index) {
  const item = isPlainObject(entry) ? entry : {};
  return {
    id: `a${index + 1}`,
    category: item.category,
    text: item.text,
    solo: item.solo === true,
    indoor: item.indoor === true,
    energyCost: clampInt(item.energyCost, 0, 100, 10),
    needs: {
      socialMin: clampInt(item.needs && item.needs.socialMin, 0, 100, 0),
      opennessMin: clampInt(item.needs && item.needs.opennessMin, 0, 100, 0),
      occupation: item.needs && item.needs.occupation ? item.needs.occupation : null,
    },
  };
}

let localDiscoveryCache = null;

/** 兜底 discovery 素材：模型池里漏掉 discovery 时，用它保证「每天 1 条小意外」 */
function localDiscoveryItems() {
  if (localDiscoveryCache) return localDiscoveryCache;
  localDiscoveryCache = FALLBACK_ENTRIES
    .filter((entry) => entry.category === 'discovery')
    .map((entry, index) => normalizeFallbackEntry(entry, index));
  return localDiscoveryCache;
}

let localIndoorHomeCache = null;

/** 兜底室内居家素材：修剪后不足 3 条时用来补室内 home / selfcare */
/** 家里的「小意外」：不需要出门，晚上也能排 */
const HOME_DISCOVERIES = content.homeDiscoveries;

function localIndoorHomeItems() {
  if (localIndoorHomeCache) return localIndoorHomeCache;
  localIndoorHomeCache = FALLBACK_ENTRIES
    .filter((entry) => INDOOR_SUPPLEMENT_CATEGORIES.includes(entry.category) && entry.indoor === true)
    .map((entry, index) => normalizeFallbackEntry(entry, index));
  return localIndoorHomeCache;
}

/**
 * 本地兜底池：12–20 条，严格按允许集合 / 职业生成；不调用模型。
 * @param {{ character?: object, profile?: object, state?: object }} [input]
 * @returns {Array<object>}
 */
function buildFallbackPool({ character, profile, state } = {}) {
  const ctx = { character, profile, state };
  const allowed = allowedCategories(ctx);
  const allowedSet = new Set(allowed);

  // 每个类别按角色 id 旋转起点，避免所有角色拿到完全相同的顺序
  const seedBase = clean(character && character.id) || clean(character && character.name) || 'pool';
  const groups = new Map();
  for (const category of allowed) {
    const entries = FALLBACK_ENTRIES
      .filter((entry) => entry.category === category)
      .map((entry, index) => normalizeFallbackEntry(entry, index))
      .filter((entry) => allowedSet.has(entry.category) && needsSatisfied(entry, ctx));
    if (entries.length === 0) continue;
    const offset = hashString(`${seedBase}|${category}`) % entries.length;
    groups.set(category, entries.slice(offset).concat(entries.slice(0, offset)));
  }

  const picked = [];
  const used = new Set();
  const target = Math.max(POOL_MIN_ITEMS, Math.min(POOL_MAX_ITEMS, POOL_TARGET_ITEMS));
  const take = (entry) => {
    if (!entry) return false;
    const key = normalizeText(entry.text);
    if (!key || used.has(key)) return false;
    used.add(key);
    picked.push(entry);
    return true;
  };

  // 先按最低配额铺底：discovery 每天都要抽 1 条，给足备选，避免天天同一件小意外。
  const baseQuota = {
    discovery: 5, home: 3, chore: 2, selfcare: 2,
  };
  for (const category of allowed) {
    const list = groups.get(category) || [];
    const quota = baseQuota[category] || 0;
    for (let index = 0; index < quota && index < list.length; index += 1) {
      if (picked.length >= target) break;
      take(list[index]);
    }
    if (picked.length >= target) break;
  }

  // 再轮转补齐到目标条数
  let round = 0;
  while (picked.length < target && round < 40) {
    let added = false;
    for (const category of allowed) {
      if (picked.length >= target) break;
      const list = groups.get(category);
      if (!list) continue;
      if (take(list[round])) added = true;
    }
    if (!added) break;
    round += 1;
  }

  return picked.map((entry, index) => ({ ...entry, id: `a${index + 1}` }));
}

// ---------------------------------------------------------------------------
// 模型提示词与解析
// ---------------------------------------------------------------------------

function forbiddenLines(ctx) {
  const allowed = new Set(allowedCategories(ctx));
  const p = normalizeProfile(ctx && ctx.profile, ctx && ctx.character);
  const s = normalizeState(ctx && ctx.state);
  const kind = occupationKind(ctx && ctx.character);
  const lines = [];
  for (const category of CATEGORIES) {
    if (allowed.has(category)) continue;
    const label = CATEGORY_LABELS[category] || category;
    if (category === 'work') {
      lines.push(`${label}：她的职业是「${kind === 'none' ? '无固定职业' : kind}」，不要出现通勤、开会、打卡、坐班。`);
    } else if (category === 'create') {
      lines.push(`${label}：她的职业和爱好都不带创作属性，不要出现赶稿、画画、写作、剪片。`);
    } else if (category === 'social' || category === 'crowd') {
      lines.push(`${label}：社交 ${p.social} / 开放 ${p.openness}，不要出现聚会、饭局、演出、团建、商场、市集、夜市。`);
    } else if (category === 'visit') {
      lines.push(`${label}：社交 ${p.social}，不要出现见朋友、走亲戚、串门。`);
    } else if (category === 'solo_out') {
      lines.push(`${label}：开放 ${p.openness}${s.energy < 30 ? '（且今天精力低）' : ''}，不要出现独自出门、逛街、看电影、去咖啡馆。`);
    } else {
      lines.push(`${label}：不要出现。`);
    }
  }
  if (s.energy < 30) lines.push('今天精力很低：不要排需要长时间在外或消耗大的活动。');
  if (s.focus < 40) lines.push('今天注意力很低：不要排需要长时间专注的创作。');
  return lines;
}

/**
 * 活动池提示词：只输出 JSON 数组，20–30 条，并显式列出禁止类型。
 * @param {{ character?: object, profile?: object, now?: Date|string|number, state?: object }} [input]
 * @returns {Array<{role: string, content: string}>}
 */
function buildPoolMessages({ character, profile, now, state, avoidTexts } = {}) {
  const c = isPlainObject(character) ? character : {};
  const name = clean(c.name) || '她';
  const ctx = { character: c, profile, state };
  const allowed = allowedCategories(ctx);
  const p = normalizeProfile(profile, c);

  const system = [
    `你在为「${name}」整理一份未来一周的活动池。`,
    '只输出 JSON 数组，不要解释、Markdown 或代码围栏。',
    '元素格式：{"category":"...","text":"做什么（只写项目名）","solo":true|false,"indoor":true|false,"energyCost":0-30,"needs":{"socialMin":0,"opennessMin":0}}。',
    '共 20–24 条；category 只能从下面允许的类型里选，每条 text 都要是不同的事，不要重复。',
    'text 只写「做什么」，4–12 个字，像清单条目：洗床单、泡脚、取快递、练琴、给猫铲屎。',
    '不要写过程、结果、感受、时间和地点细节；不要写「洗衣机停了把床单晾上，袜子在架边」这种，具体细节会另外生成。',
    '不要再写「然后 / 接着 / 最后 / 醒来」这类串联词，一条里只放一个动作。',
    '不要复用最近两周出现过的具体句子或意象；同一个活动要换角度、换细节，不要反复写同一种说法。',
    `允许的类型：${allowed.join('、')}。`,
    '每条要贴合她的城市、住处、职业、爱好与作息；不要排得太满，也不要写成任务清单。',
    '只写普通的一天里真会做的事，不要写「上班打卡」这类和她身份不符的内容。',
    '她能出门的理由只有：扔垃圾、取快递、在小区或附近公园走走、去便利店买点急用的东西。不要写去菜场、菜市场、超市挑菜买菜——她的菜和日用品都在手机上下单，等人送到快递柜。',
    '不要发明这些：专门坐车去某个地方再回来、在外面闲坐一下午、报班/参加活动、她记录里没出现过的爱好。',
    '不要写「为了出门而出门」的活动。',
    'needs 用来说明这条活动的门槛：socialMin / opennessMin 写 0–100 的整数，没有门槛就写 0。',
  ].join('\n');

  const hobbyText = asList(c.life && c.life.hobbies).join('、');
  const healthText = asList(c.life && c.life.health).join('；');
  const bannedActivities = forbiddenActivityWords(c);
  const avoid = (Array.isArray(avoidTexts) ? avoidTexts : [])
    .map((text) => clean(text).slice(0, 40))
    .filter(Boolean)
    .slice(0, 30);
  const user = [
    `角色：${promptModule.characterBrief(c)}`,
    `五维：社交 ${p.social} / 规律 ${p.structure} / 开放 ${p.openness} / 节奏 ${p.pace} / 表达 ${p.expressiveness}`,
    `职业类型：${occupationKind(c)}${hasCreative(c) ? '（含创作属性）' : '（不含创作属性）'}`,
    hobbyText ? `爱好：${hobbyText}` : '',
    healthText ? `身体情况：${healthText}（别写她做不动、会加重身体负担的活动）` : '',
    `允许的类型：${allowed.map((category) => CATEGORY_LABELS[category] || category).join('；')}`,
    '禁止出现的类型（严格不要出现，出现即作废）：',
    ...forbiddenLines(ctx).map((line) => `- ${line}`),
    bannedActivities.length > 0
      ? `绝对不要出现这些活动（她的生活里没有）：${bannedActivities.join('、')}。`
      : '',
    avoid.length > 0
      ? `【最近出现过，不要复用这些具体句子/意象】\n${avoid.map((text) => `- ${text}`).join('\n')}`
      : '',
    now ? `生成时间：${dateKey(toDateOrNull(now) || new Date())}` : '',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: promptModule.withLanguage(system) },
    { role: 'user', content: user },
  ];
}

/** 从模型输出里取数组：容忍 ```json 围栏、前后解释文字、{items:[...]} 包装 */
/** 从被截断/带噪声的文本里抢救出完整的顶层对象（模型 max_tokens 截断时会用到） */
function salvageObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* 跳过坏对象 */ }
          start = -1;
        }
      }
    }
  }
  return out;
}

function extractArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (isPlainObject(raw)) {
    if (Array.isArray(raw.items)) return raw.items;
    if (Array.isArray(raw.pool)) return raw.pool;
    return null;
  }
  if (typeof raw !== 'string') return null;

  let text = raw.trim();
  if (!text) return null;
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(value)) return value;
    } catch {
      // 落到下面的对象包装解析
    }
  }

  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try {
      const value = JSON.parse(text.slice(objStart, objEnd + 1));
      if (isPlainObject(value)) {
        if (Array.isArray(value.items)) return value.items;
        if (Array.isArray(value.pool)) return value.pool;
      }
    } catch {
      // 落到下面的抢救解析
    }
  }

  // 被 max_tokens 截断（数组没闭合）时，抢救出完整的对象
  const salvaged = salvageObjects(start !== -1 ? text.slice(start) : text);
  if (salvaged.length > 0) return salvaged;

  return null;
}

function defaultIndoor(category) {
  return ['home', 'chore', 'selfcare', 'create', 'work', 'visit', 'social'].includes(category);
}

function defaultSolo(category) {
  return ['home', 'chore', 'selfcare', 'solo_out', 'create', 'discovery', 'work'].includes(category);
}

/**
 * 解析模型输出的活动池。
 * 逐条过允许集合 / needs 过滤，补默认字段并去重；解析失败或合格条目 < 6 返回 null。
 * @param {unknown} text
 * @param {{ character?: object, profile?: object, state?: object }} [ctx]
 * @returns {Array<object>|null}
 */
function parsePool(text, ctx = {}) {
  const raw = extractArray(text);
  if (!raw) return null;

  const normalized = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const category = clean(entry.category);
    if (!CATEGORIES.includes(category)) continue;
    const activityText = clean(entry.text);
    if (!activityText) continue;
    // 池子只放「做什么」：太长、带句号、串联两个动作的一律不要，细节留给生成时写
    if (Array.from(activityText).length > 20) continue;
    if (/[。；]/.test(activityText)) continue;
    if (/(然后|接着|紧接着|最后|醒来)/.test(activityText)) continue;
    // 出门要有目的：专门坐车出去再回来、闲坐一下午这类，一律不要
    if (/(坐.{0,4}(站|路)|坐公交|坐地铁|专门去|再去.{0,8}回来|闲坐一下午)/.test(activityText)) continue;

    const needsSrc = isPlainObject(entry.needs) ? entry.needs : {};
    normalized.push({
      id: clean(entry.id) || `a${normalized.length + 1}`,
      category,
      text: activityText,
      solo: typeof entry.solo === 'boolean' ? entry.solo : defaultSolo(category),
      indoor: typeof entry.indoor === 'boolean' ? entry.indoor : defaultIndoor(category),
      energyCost: clampInt(entry.energyCost, 0, 100, 10),
      needs: {
        socialMin: clampInt(needsSrc.socialMin, 0, 100, 0),
        opennessMin: clampInt(needsSrc.opennessMin, 0, 100, 0),
        occupation: typeof needsSrc.occupation === 'string' && needsSrc.occupation.trim()
          ? needsSrc.occupation.trim()
          : null,
      },
    });
  }

  const filtered = filterPool(normalized, ctx);
  const avoid = new Set(
    (Array.isArray(ctx.avoidTexts) ? ctx.avoidTexts : [])
      .map((text) => normalizeText(text))
      .filter(Boolean),
  );
  const seen = new Set();
  const items = [];
  for (const item of filtered) {
    const key = normalizeText(item.text);
    if (!key || seen.has(key) || avoid.has(key)) continue;
    seen.add(key);
    items.push({ ...item, id: `a${items.length + 1}` });
  }

  if (items.length < PARSE_MIN_ITEMS) return null;
  return items;
}

// ---------------------------------------------------------------------------
// 每日抽样
// ---------------------------------------------------------------------------

/** recentDays: [{ date, schedule: [{time, activity, category?}] }] */
function normalizeRecentDays(recentDays) {
  const list = Array.isArray(recentDays) ? recentDays : [];
  const out = [];
  for (const day of list) {
    if (!isPlainObject(day)) continue;
    const date = clean(day.date);
    const schedule = Array.isArray(day.schedule) ? day.schedule.filter(isPlainObject) : [];
    const rows = schedule
      .map((row) => ({ activity: clean(row.activity), category: clean(row.category) }))
      .filter((row) => row.activity || row.category);
    if (rows.length > 0) out.push({ date, rows });
  }
  return out;
}

function daysBetween(fromKey, toKey) {
  const from = localDateFromKey(fromKey);
  const to = localDateFromKey(toKey);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function countRecentByCategory(recent, date, windowDays, textIndex, category) {
  let count = 0;
  for (const day of recent) {
    const gap = day.date ? daysBetween(day.date, date) : null;
    if (gap !== null && (gap <= 0 || gap > windowDays)) continue;
    for (const row of day.rows) {
      const rowCategory = row.category || textIndex.get(normalizeText(row.activity)) || '';
      if (rowCategory === category) count += 1;
    }
  }
  return count;
}

/**
 * 规律维度 → 时间抖动配置。
 * 高规律改用固定锚点（anchored: true），其余按维度放大 / 保持抖动。
 * @param {unknown} structure
 * @returns {{ jitter: number, anchored: boolean }}
 */
function structureTiming(structure) {
  const value = clampInt(structure, 0, 100, 50);
  if (value >= STRUCTURE_HIGH_CUT) return { jitter: HIGH_STRUCTURE_JITTER, anchored: true };
  if (value <= STRUCTURE_LOW_CUT) return { jitter: LOW_STRUCTURE_JITTER, anchored: false };
  return { jitter: JITTER_MINUTES, anchored: false };
}

/** 高规律时每个时段对应的固定锚点（分钟） */
function anchorMinutesForSlot(slot) {
  const key = clean(slot);
  if (key.startsWith('morning')) return HIGH_STRUCTURE_ANCHORS.morning;
  if (key.startsWith('midday-solo_out') || key.startsWith('midday-1')) {
    return HIGH_STRUCTURE_ANCHORS.midday;
  }
  if (key.startsWith('midday-2')) return HIGH_STRUCTURE_ANCHORS.afternoon;
  // 晚 / discovery / 兜底补位条目都落在晚间锚点上
  return HIGH_STRUCTURE_ANCHORS.evening;
}

/** 时间正好压在生日 19:30 时往后错 5 分钟，别把生日条目挤掉 */
function avoidBirthdayMinutes(minutes) {
  const rounded = Math.round(minutes);
  return rounded === BIRTHDAY_MINUTES ? rounded + BIRTHDAY_SHIFT_MINUTES : rounded;
}

/** 高规律时某个时段相对锚点的偏移窗口（分钟），默认 ±10 */
function anchoredOffsetWindow(slot) {
  const key = clean(slot);
  if (key.startsWith('discovery')) return HIGH_STRUCTURE_WINDOWS.discovery;
  if (key.startsWith('bonus')) return HIGH_STRUCTURE_WINDOWS.bonus;
  if (key.startsWith('evening') || key.startsWith('extra-')) return HIGH_STRUCTURE_WINDOWS.evening;
  return [-HIGH_STRUCTURE_JITTER, HIGH_STRUCTURE_JITTER];
}

/**
 * 按规律维度抖动时间。
 * 种子只依赖日期 + slot，所以同一天同一角色结果可复现。
 * @param {string} dateText
 * @param {string} slot
 * @param {number} baseMinutes
 * @param {{ jitter?: number, anchored?: boolean }} [timing]
 * @returns {string} 'HH:MM'
 */
function jitteredTime(dateText, slot, baseMinutes, timing) {
  const config = isPlainObject(timing) && Number.isFinite(timing.jitter)
    ? timing
    : structureTiming(50);
  let base = baseMinutes;
  let low = -config.jitter;
  let high = config.jitter;
  if (config.anchored) {
    base = anchorMinutesForSlot(slot);
    [low, high] = anchoredOffsetWindow(slot);
  }
  const span = high - low + 1;
  const offset = low + (hashString(`${dateText}|${slot}|jitter`) % span);
  return minutesToTime(avoidBirthdayMinutes(base + offset));
}

function weightedPick(candidates, seedText, weightOf) {
  if (candidates.length === 0) return null;
  const list = candidates
    .slice()
    .sort((a, b) => normalizeText(a.text).localeCompare(normalizeText(b.text)));
  let total = 0;
  const weighted = list.map((item) => {
    const weight = Math.max(0, weightOf(item));
    total += weight;
    return { item, weight };
  });
  if (total <= 0) return list[0];
  const roll = (hashString(seedText) % 100000) / 100000 * total;
  let acc = 0;
  for (const entry of weighted) {
    acc += entry.weight;
    if (roll < acc) return entry.item;
  }
  return weighted[weighted.length - 1].item;
}

/**
 * 每日抽样（0 模型调用）。
 * 3–5 条（另有高节奏时 1 条「顺路」）：早（home/chore/selfcare）+ 午（work/create/solo_out/crowd/social/visit）
 * + 晚（home/create）+ 1 条 discovery；时间按日期抖动，同日结果稳定。
 *
 * P7 五维落地：
 * - 规律 ≥70 → 时间贴固定锚点 08:00 / 12:30 / 15:30 / 19:30，抖动 ±10 分钟；
 *   规律 ≤30 → 抖动 ±45 分钟；其余 ±25 分钟。
 * - 节奏 ≥70 → 5 条（+ 满足条件时 1 条顺路 discovery/selfcare）；≤30 → 固定 3 条；其余 4 条。
 *   条数只决定「排几个时段」，allowedCategories 与周/月配额始终先生效。
 *
 * P8 地点连续性（排序落位后统一修剪一次）：
 * - 20:00 之后只排室内；户外候选直接剔除，条数可降到 3；
 * - 室内 home/chore/selfcare 之后外出要求间隔 ≥120 分钟且 <20:00；
 * - 外出 → 室内永远允许；
 * - 顺路条目沿用前一条的地点属性；discovery 晚间优先室内变体；
 * - 修剪后不足 3 条时只补室内 home/selfcare（本地素材兜底），硬约束优先级不变。
 *
 * P9 相邻类别：同一天相邻两条 category 不能相同（下午第二条 / 晚间 / 顺路 / 补位都排除上一条的类别）；
 * discovery 例外——允许与上一条同类，但一天最多 1 条普通 + 1 条顺路，顺路优先 selfcare，
 * 两类都撞时放弃顺路。
 *
 * P4：context 可带 { weather, holiday, term, season, weekend }。
 * - 晴 + 周末 + 受雇 → solo_out ×1.4；晴 + 自由职业 → solo_out ×1.2；
 * - 雨 / 雪 → 户外类 ×0.3，home/create ×1.2；
 * - 节日 → 额外插入一条节日活动（不占 discovery 名额，最多多 1 条）；
 * - 节气 → 只改措辞（给一条居家活动加「立冬，」这样的前缀），不改变类别。
 * 所有加权都在过滤之后，低 social 仍然拿不到聚会。
 *
 * @param {{ pool?: object|Array, date?: string, profile?: object, state?: object,
 *           context?: object, recentDays?: object[] }} [input]
 * @returns {Array<{time:string, activity:string, category:string}>}
 */
function sampleDay({
  pool, date, profile, state, context, recentDays, includeDiscovery = true,
} = {}) {
  const ctxCharacter = isPlainObject(context) && isPlainObject(context.character)
    ? context.character
    : isPlainObject(context) && context.id ? context : undefined;
  const ctxProfile = profile !== undefined ? profile : context && context.profile;
  const ctxState = state !== undefined ? state : context && context.state;
  const ctx = { character: ctxCharacter, profile: ctxProfile, state: ctxState };

  const rawItems = Array.isArray(pool) ? pool : isPlainObject(pool) && Array.isArray(pool.items) ? pool.items : [];
  const items = filterPool(rawItems, ctx);
  if (items.length === 0) return [];

  // 禁忌词 + 明确不喜欢的内容：主池、本地兜底、补位都按同一套拦，
  // 否则「沙发」「听歌」会从 fallback-entries 里漏回来。
  const bannedWords = [
    ...forbiddenActivityWords(ctxCharacter),
    ...asList(ctxCharacter && ctxCharacter.life && ctxCharacter.life.avoidTopics),
  ].map((word) => clean(word)).filter(Boolean);
  const isBannedText = (text) => {
    const value = clean(text);
    if (!value) return false;
    return bannedWords.some((word) => value.includes(word));
  };

  const dateText = clean(date) || dateKey(new Date());
  const seedBase = `${dateText}|${clean(ctxCharacter && ctxCharacter.id) || 'x'}`;
  const prof = normalizeProfile(ctxProfile, ctxCharacter);
  const st = normalizeState(ctxState);
  const timing = structureTiming(prof.structure);
  const rawCount = isPlainObject(ctxCharacter) && isPlainObject(ctxCharacter.life)
    ? ctxCharacter.life.scheduleCount
    : null;
  const overrideCount = clampInt(rawCount, DAY_TARGET_LOW, DAY_TARGET_HIGH, null);
  const targetCount = overrideCount !== null
    ? overrideCount
    : prof.pace >= PACE_HIGH_CUT
      ? DAY_TARGET_HIGH
      : prof.pace <= PACE_LOW_CUT
        ? DAY_TARGET_LOW
        : DAY_TARGET_MID;

  const weather = normalizeWeatherContext(context && context.weather);
  const holiday = normalizeHolidayContext(context && context.holiday);
  const term = clean(context && context.term);
  const occupation = occupationKind(ctxCharacter);
  const dateObject = localDateFromKey(dateText);
  const weekend = isPlainObject(context) && typeof context.weekend === 'boolean'
    ? context.weekend
    : dateObject
      ? isWeekendDate(dateObject)
      : false;

  const textIndex = new Map();
  // 作息：角色声明自己常在某个时段活动时，把晚间/小意外往后挪进那个时段
  const lifeCfg = isPlainObject(ctxCharacter && ctxCharacter.life) ? ctxCharacter.life : {};
  const activeFrom = timeToMinutes(clean(lifeCfg.activeFrom));
  const activeTo = timeToMinutes(clean(lifeCfg.activeTo)) || 23 * 60 + 30;
  const lateShift = Number.isFinite(activeFrom) && activeFrom > BASE_TIMES.evening
    ? activeFrom - BASE_TIMES.evening
    : 0;
  const T = lateShift > 0
    ? {
      ...BASE_TIMES,
      evening: Math.min(BASE_TIMES.evening + lateShift, activeTo - 45),
      discovery: Math.min(BASE_TIMES.discovery + lateShift, activeTo - 15),
    }
    : BASE_TIMES;
  for (const item of rawItems) {
    if (!isPlainObject(item)) continue;
    const key = normalizeText(item.text);
    if (key) textIndex.set(key, clean(item.category));  }

  const recent = normalizeRecentDays(recentDays);
  const recentTexts = new Set();
  for (const day of recent) {
    const gap = day.date ? daysBetween(day.date, dateText) : null;
    if (gap !== null && (gap <= 0 || gap > RECENT_DAYS)) continue;
    for (const row of day.rows) {
      const key = normalizeText(row.activity);
      if (key) recentTexts.add(key);
    }
  }

  // 近 7 天出现过的活动优先排除；某类实在没有新条目时再放开，避免把日程排空
  const freshOnly = (list) => list.filter((item) => !recentTexts.has(normalizeText(item.text)));
  const freshOrAll = (list) => {
    const fresh = freshOnly(list);
    return fresh.length > 0 ? fresh : list;
  };

  const soloOutCount = countRecentByCategory(recent, dateText, RECENT_DAYS, textIndex, 'solo_out');
  const visitCount = countRecentByCategory(recent, dateText, VISIT_WINDOW_DAYS, textIndex, 'visit');
  const socialWindow = prof.social >= 85 ? 7 : 14;
  const socialCount = countRecentByCategory(recent, dateText, socialWindow, textIndex, 'social');

  const excluded = new Set();
  if (soloOutCount >= SOLO_OUT_MAX_PER_WEEK) excluded.add('solo_out');
  if (visitCount >= VISIT_MAX_PER_WINDOW) excluded.add('visit');
  if (socialCount >= 1) excluded.add('social');

  const used = new Set();
  const picked = [];

  const weightOf = (item) => {
    const key = normalizeText(item.text);
    let weight = 1;
    if (recentTexts.has(key)) weight *= 0.2;
    if (item.category === 'solo_out' && soloOutCount === 0) weight *= 1.5;
    if (st.energy < 50) {
      const cost = clampInt(item.energyCost, 0, 100, 10);
      weight *= 1 / (1 + cost / 50);
    }

    // P4：天气加权（只调权重，不绕过硬约束）
    if (weather.isClear && item.category === 'solo_out') {
      if (occupation === 'employed' && weekend) {
        weight *= CLEAR_WEEKEND_EMPLOYED_SOLO_OUT_WEIGHT;
      } else if (occupation === 'freelance') {
        weight *= CLEAR_FREELANCE_SOLO_OUT_WEIGHT;
      }
    }
    if (weather.isWet) {
      if (OUTDOOR_CATEGORIES.includes(item.category)) weight *= RAIN_OUTDOOR_WEIGHT;
      if (item.category === 'home' || item.category === 'create') weight *= RAIN_INDOOR_WEIGHT;
    }
    return weight;
  };

  // 同一天最多一条的类型：出门 / 人群 / 聚会 / 串门，避免一天排两次独自出门
  const singlePerDay = new Set(['solo_out', 'crowd', 'social', 'visit']);

  const candidatesFor = (categories) => freshOrAll(items.filter((item) => {
    if (!categories.includes(item.category)) return false;
    if (excluded.has(item.category)) return false;
    if (singlePerDay.has(item.category) && picked.some((row) => row.category === item.category)) {
      return false;
    }
    const key = normalizeText(item.text);
    return key && !used.has(key);
  }));

  // 相邻类别去重：同一天相邻两条不能同类别（12:04 与 14:43 都是「创作」且内容雷同）。
  // 抽样本身就按时段顺序落位，所以「上一条」= 已挑好的最后一条。
  // discovery 是例外：它本来就是小意外，允许与上一条同类，
  // 但一天最多 1 条普通 + 1 条顺路（顺路优先 selfcare，见下面的 bonus 段）。
  const previousPicked = () => (picked.length > 0 ? picked[picked.length - 1] : null);
  const pickedCountOf = (category) => picked.reduce(
    (sum, row) => sum + (row.category === category ? 1 : 0),
    0,
  );
  const adjacentAllowed = (item) => {
    const previous = previousPicked();
    if (!previous || !previous.category) return true;
    if (previous.category !== item.category) return true;
    if (item.category === 'discovery') return pickedCountOf('discovery') < 2;
    return false;
  };

  // 地点属性跟着行对象走（WeakMap 不污染对外的 schedule 结构）
  const indoorOf = new WeakMap();
  const isIndoorRow = (row) => indoorOf.get(row) === true;

  // 时段词与槽位不匹配的条目直接排除（"半夜爬起来"不能排在中午）；
  // 同时默认排除与上一条同类别（allowSameAsPrevious 只在「顺路」段按显式偏好打开）。
  const pickInto = (categories, slot, baseMinutes, overrideCandidates, options = {}) => {
    const source = Array.isArray(overrideCandidates)
      ? overrideCandidates
      : candidatesFor(categories);
    const candidates = freshOrAll(source)
      .filter((item) => !isBannedText(item.text))
      .filter((item) => textTimeFits(item.text, baseMinutes))
      .filter((item) => options.allowSameAsPrevious === true || adjacentAllowed(item));
    const candidate = weightedPick(candidates, `${seedBase}|${slot}`, weightOf);
    if (!candidate) return null;
    const key = normalizeText(candidate.text);
    used.add(key);
    const row = {
      time: jitteredTime(dateText, slot, baseMinutes, timing),
      activity: candidate.text,
      category: candidate.category,
    };
    indoorOf.set(row, isIndoorItem(candidate));
    picked.push(row);
    return row;
  };

  // 早：最早的条目不能早于角色的活跃窗口（例如她 09:00 才起床，就不该排 07:39）
  const morningFloor = Number.isFinite(activeFrom) ? activeFrom : 0;
  pickInto(PERIOD_CATEGORIES.morning, 'morning', Math.max(T.morning, morningFloor));

  // 午：1 条。若最近 7 天一次都没出过门，优先补一条 solo_out（保证「每周 1–3 次」的下限）
  const needSoloOut = soloOutCount === 0 && !excluded.has('solo_out');
  const middayPicked = needSoloOut
    ? pickInto(['solo_out'], 'midday-solo_out', T.middayFirst)
    : null;
  if (!middayPicked) {
    pickInto(PERIOD_CATEGORIES.midday, 'midday-1', BASE_TIMES.middayFirst);
  }
  // 下午第二条只给高节奏：低节奏 / 中间档的空缺由下面的 evening 决定
  if (targetCount >= DAY_TARGET_HIGH) {
    pickInto(PERIOD_CATEGORIES.midday, 'midday-2', T.middaySecond);
  }

  // 晚（不含 discovery，discovery 单独一条）；低节奏时整天只留 3 条，晚间的这条省掉
  if (targetCount >= DAY_TARGET_MID) {
    pickInto(['home', 'create'], 'evening', BASE_TIMES.evening);
  }

  // 每天 1 条 discovery（模型池漏了这条时用本地素材补，discovery 无门槛）。
  // 规则 5：discovery 固定在 21:00 前后（晚间），优先选室内变体；
  // 池里只有户外变体时，用本地室内素材补；实在没有才留下户外，交给后面的修剪剔除。
  if (includeDiscovery !== false) {
    const discoveryMinutes = BASE_TIMES.discovery;
    // 关键：不是「室内」优先，而是「不用出门」优先——去小店也标 indoor，但仍要出门
    const preferHomeDiscovery = (list) => list.filter((item) => !isAwayItem(item));
    const homeDiscoveryItems = () => {
      const all = HOME_DISCOVERIES.map((entry, index) => ({
        id: `home-discovery-${index}`,
        category: entry.category,
        text: entry.text,
        indoor: true,
        solo: true,
      })).filter((item) => !used.has(normalizeText(item.text)));
      return freshOrAll(all);
    };
    let discoveryCandidates = candidatesFor(['discovery']);
    if (discoveryMinutes >= EVENING_INDOOR_FROM) {
      const homeFromPool = freshOnly(preferHomeDiscovery(discoveryCandidates));
      if (homeFromPool.length > 0) {
        discoveryCandidates = homeFromPool;
      } else {
        const homeFromLocalAll = preferHomeDiscovery(localDiscoveryItems())
          .filter((item) => !used.has(normalizeText(item.text)));
        const homeFromLocal = freshOnly(homeFromLocalAll);
        const homeFromReserve = homeDiscoveryItems();
        const homeFromReserveFresh = freshOnly(homeFromReserve);
        if (homeFromLocal.length > 0) {
          discoveryCandidates = homeFromLocal;
        } else if (homeFromReserveFresh.length > 0) {
          discoveryCandidates = homeFromReserveFresh;
        } else if (homeFromLocalAll.length > 0) {
          discoveryCandidates = homeFromLocalAll;
        } else {
          discoveryCandidates = homeFromReserve;
        }
      }
    } else if (discoveryCandidates.length === 0) {
      discoveryCandidates = localDiscoveryItems()
        .filter((item) => !used.has(normalizeText(item.text)));
    }
    pickInto(['discovery'], 'discovery', BASE_TIMES.discovery, discoveryCandidates);
  }
  // 高节奏：5 条排满后，再补 1 条「顺路」的 discovery / selfcare。
  // 只在这两类里挑，且同样要过 allowedCategories 与去重（类别配额仍先生效）。
  // 规则 4：顺路沿用前一条的地点属性（前一条室内 → 顺路只能室内）。
  // 规则 7（相邻类别）：顺路优先 selfcare（上一条通常就是 21:00 的 discovery，
  // 再挑 discovery 会连成两条）；上一条本身就是 selfcare 时改挑 discovery；
  // 两类都撞、或当天已经有 discovery 时放弃顺路，宁可不加也不重复。
  let bonusAdded = false;
  if (prof.pace >= PACE_HIGH_CUT && picked.length >= DAY_MAX_ITEMS) {
    const allowedSet = new Set(allowedCategories(ctx));
    const bonusMinutes = BASE_TIMES.discovery + 15;
    const previous = previousPicked();
    const previousCategory = clean(previous && previous.category);
    const hasDiscovery = pickedCountOf('discovery') > 0;
    const bonusCandidates = bonusCandidatesForContinuity(
      candidatesFor(BONUS_CATEGORIES).filter((item) => allowedSet.has(item.category)),
      { previousIndoor: previous ? isIndoorRow(previous) : false, minutes: bonusMinutes },
    );
    const preference = previousCategory === 'selfcare'
      ? (hasDiscovery ? [] : ['discovery'])
      : ['selfcare', 'discovery'];
    for (const category of preference) {
      if (category === 'discovery' && hasDiscovery) continue;
      const attempt = pickInto(
        [category], 'bonus', bonusMinutes, bonusCandidates, { allowSameAsPrevious: true },
      );
      if (attempt) {
        bonusAdded = true;
        break;
      }
    }
  }

  // P4：节日 → 额外插入一条节日活动（不占 discovery 名额；同样过了 filterPool 硬约束）
  let festivalAdded = false;
  if (holiday) {
    const festivalItems = calendar.festivalActivities(ctxCharacter, prof, {
      date: dateText,
      holiday,
      weather,
      term,
      season: clean(context && context.season),
      state: ctxState,
    });
    const candidate = festivalItems[0];
    if (candidate) {
      const key = normalizeText(candidate.text);
      if (key && !used.has(key)) {
        const preferred = FESTIVAL_EVENING_CATEGORIES.includes(candidate.category)
          ? FESTIVAL_TIMES.evening
          : FESTIVAL_TIMES.midday;
        const fallback = preferred === FESTIVAL_TIMES.evening
          ? FESTIVAL_TIMES.midday
          : FESTIVAL_TIMES.evening;
        const time = picked.some((row) => row.time === preferred) ? fallback : preferred;
        used.add(key);
        const row = {
          time,
          activity: candidate.text,
          category: candidate.category,
          festival: holiday.name,
        };
        indoorOf.set(row, isIndoorItem(candidate));
        picked.push(row);
        festivalAdded = true;
      }
    }
  }

  picked.sort((a, b) => a.time.localeCompare(b.time));

  // 早于活跃窗口的条目往后挪（只挪时间，不换内容）：09:00 起床就不该有 07:39 的事
  if (morningFloor > 0) {
    for (const row of picked) {
      const minutes = timeToMinutes(row.time);
      if (minutes === null || minutes >= morningFloor) continue;
      row.time = minutesToTime(morningFloor + (minutes % 25));
    }
    picked.sort((a, b) => a.time.localeCompare(b.time));
  }

  // 规则 1–3：抽完、排好之后统一做一次地点连续性修剪
  const scheduled = pruneContradictions(pruneScheduleByLocation(picked), ctx);

  // 规则 6：修剪后不足 3 条才补救（优先补室内 home / selfcare，仍只新增、不乱序）
  if (scheduled.length < DAY_MIN_ITEMS) {
    const allowedSet = new Set(allowedCategories(ctx));
    const fromPool = items.filter((item) => (
      INDOOR_SUPPLEMENT_CATEGORIES.includes(item.category)
      && isIndoorItem(item)
      && allowedSet.has(item.category)
      && !isBannedText(item.text)
      && !used.has(normalizeText(item.text))
    ));
    const takenKeys = new Set(fromPool.map((item) => normalizeText(item.text)));
    const supplements = fromPool.concat(
      localIndoorHomeItems()
        .filter((item) => allowedSet.has(item.category))
        .filter((item) => !isBannedText(item.text))
        .filter((item) => !takenKeys.has(normalizeText(item.text)))
        .filter((item) => !used.has(normalizeText(item.text))),
    );

    let cursor = scheduled.length > 0
      ? (timeToMinutes(scheduled[scheduled.length - 1].time) ?? EVENING_INDOOR_FROM)
      : EVENING_INDOOR_FROM;
    // 补位要摊开：优先塞进离已有日程最远的空档，而不是「上一条 +20 分钟」挤成一团。
    // 21:00 的 discovery 档只留给小意外；普通补位最多放到 21:30，太晚了不适合做家务。
    const slotBases = [Math.max(T.morning, morningFloor), T.middayFirst, T.middaySecond, T.evening]
      .filter((minutes) => Number.isFinite(minutes));
    const LATEST_SUPPLEMENT = 21 * 60 + 30;
    const takenMinutes = () => scheduled
      .map((row) => timeToMinutes(row.time))
      .filter((minutes) => Number.isFinite(minutes));
    /** 这条文案能落在哪些空档（含前后 45 分钟的微调），再按「离已有日程最远」挑 */
    const slotOptionsFor = (category, text) => {
      const bases = (category === 'discovery' ? slotBases.concat([T.discovery]) : slotBases)
        .filter((minutes) => Number.isFinite(minutes) && minutes <= LATEST_SUPPLEMENT);
      const options = new Set();
      for (const base of bases) {
        for (const delta of [0, -15, 15, -30, 30, -45, 45]) {
          const minutes = base + delta;
          if (minutes > 0 && minutes <= LATEST_SUPPLEMENT && textTimeFits(text, minutes)) {
            options.add(minutes);
          }
        }
      }
      return Array.from(options);
    };
    while (scheduled.length < DAY_MIN_ITEMS && supplements.length > 0) {
      // 相邻类别：补位也尽量避开上一条的类别（两条都撞时再退让，条数优先）
      const lastCategory = scheduled.length > 0 ? clean(scheduled[scheduled.length - 1].category) : '';
      const adjacent = supplements.filter((item) => item.category !== lastCategory);
      const pool = adjacent.length > 0 ? adjacent : supplements;
      // 先挑一条，再看它能不能找到合法时段；放不了就换下一条（例如「泡脚」不能排到下午）
      let candidate = null;
      let slot = null;
      const remaining = pool.slice();
      while (remaining.length > 0) {
        const pick = weightedPick(remaining, `${seedBase}|indoor-fill-${scheduled.length}`, weightOf);
        if (!pick) break;
        const options = slotOptionsFor(pick.category, pick.text);
        if (options.length > 0) {
          const taken = takenMinutes();
          slot = options.reduce((best, minutes) => {
            const gap = taken.length === 0
              ? Number.POSITIVE_INFINITY
              : Math.min(...taken.map((value) => Math.abs(value - minutes)));
            return gap > best.gap ? { minutes, gap } : best;
          }, { minutes: options[0], gap: -1 }).minutes;
          candidate = pick;
          break;
        }
        remaining.splice(remaining.indexOf(pick), 1);
      }
      if (!candidate) break;
      supplements.splice(supplements.indexOf(candidate), 1);
      cursor = slot !== null ? slot : Math.min(cursor + 120, 23 * 60 + 50);
      used.add(normalizeText(candidate.text));
      const row = {
        time: minutesToTime(avoidBirthdayMinutes(cursor)),
        activity: candidate.text,
        category: candidate.category,
      };
      indoorOf.set(row, true);
      scheduled.push(row);
    }
  }

  // P4：节气 / 换季只改措辞，不改变类别（挑第一条居家活动加前缀）
  if (term) {
    const target = scheduled.find((row) => ['home', 'chore', 'selfcare'].includes(row.category));
    if (target && !clean(target.activity).startsWith(term)) {
      target.activity = `${term}，${target.activity}`;
    }
  }

  // 作息窗口：把 18:00 之后的活动挪进她的活跃时段（例如 20:00–23:30）
  const inWindow = applyActiveWindow(scheduled, activeFrom, activeTo);

  // 收尾规则：带「关灯 / 睡觉 / 梳头 / 洗漱」这类动作的条目必须是当天最后一件
  const fixed = enforceWindDownLast(inWindow);

  // 节日 / 顺路条目各额外占 1 个位置，不挤掉当天的 3–5 条常规活动
  return fixed.slice(0, DAY_MAX_ITEMS + (festivalAdded ? 1 : 0) + (bonusAdded ? 1 : 0));
}

/** 「今天不出门」类声明：一旦当天已经出过门，就自相矛盾 */
const STAY_HOME_CLAIM = /(不想出门|懒得出门|不想出去|待在家里|窝在家|没出门|不出门)/u;

const CLEAR_WORDS = /(晴天|放晴|太阳很好|大太阳)/u;
const GLOOMY_WORDS = /(阴天|下雨|下雪|雨天|雪天)/u;

/**
 * 语义一致性修剪：
 * 1. 当天已经出过门，后面不能再出现「不想出门 / 窝在家」这类声明；
 * 2. 文案里的天气要和当天实际天气相符（晴 vs 阴/雨）。
 */
function pruneContradictions(rows, context = {}) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const weather = context && context.weather ? context.weather : null;
  const kept = [];
  let wentOut = false;
  for (const row of list) {
    const text = clean(row && (row.activity || row.text));
    if (wentOut && STAY_HOME_CLAIM.test(text)) continue;
    if (weather) {
      if (weather.isClear === true && GLOOMY_WORDS.test(text) && !CLEAR_WORDS.test(text)) continue;
      if (weather.isRain === true && CLEAR_WORDS.test(text)) continue;
    }
    kept.push(row);
    if (isAwayItem(row)) wentOut = true;
  }
  return kept;
}

/** 「准备睡觉」类动作：出现当天最后一条之后就不该再做别的 */
const WIND_DOWN_WORDS = /(睡前|准备睡|关灯|熄灯|睡觉|睡下|上床|入眠|洗漱|刷牙|梳头|护肤|卸妆|铺床|关窗|放下手机)/u;

/** 文案里的时段词 → 允许落位的时间范围（分钟，支持跨零点） */
const TEXT_TIME_RULES = [
  // 睡前类必须先判：否则「睡前把衣服搭好，省得早上找」会被「早上」误判成早间活动
  { re: /(睡前|准备睡|睡下|上床|关灯|熄灯)/u, from: 21 * 60, to: 23 * 60 + 59 },
  // 泡脚 / 泡澡是晚间的事，别排到上午（她自己也习惯晚上洗脚）
  { re: /(泡脚|泡澡)/u, from: 19 * 60, to: 23 * 60 + 59 },
  // 打盹只在中午到下午：傍晚睡一觉会顶掉晚上的觉
  { re: /(眯一会儿|眯一觉|眯二十分钟|小睡|午睡|打个盹|回笼觉)/u, from: 11 * 60, to: 15 * 60 + 30 },
  { re: /(清晨|一大早|早上)/u, from: 5 * 60, to: 10 * 60 },
  { re: /(上午)/u, from: 8 * 60, to: 12 * 60 },
  { re: /(中午|正午|午饭)/u, from: 11 * 60, to: 14 * 60 },
  { re: /(下午)/u, from: 13 * 60, to: 18 * 60 },
  { re: /(傍晚|黄昏|夕阳)/u, from: 16 * 60, to: 20 * 60 },
  { re: /(关门前|打烊前|收摊|末班车|下班后)/u, from: 18 * 60, to: 23 * 60 + 59 },
  { re: /(晚饭|晚上|夜里)/u, from: 18 * 60, to: 23 * 60 + 59 },
  { re: /(半夜|深夜|凌晨)/u, from: 22 * 60, to: 2 * 60 },
];

/**
 * 文案里的时段词是否和槽位时间相符。
 * 例：「半夜想到一个构图」只能排在 22:00 之后或 02:00 之前。
 */
function textTimeFits(text, minutes) {
  const value = clean(text);
  if (!Number.isFinite(minutes)) return true;
  for (const rule of TEXT_TIME_RULES) {
    if (!rule.re.test(value)) continue;
    if (rule.from <= rule.to) return minutes >= rule.from && minutes <= rule.to;
    return minutes >= rule.from || minutes <= rule.to;
  }
  return true;
}

function isWindDown(row) {
  return WIND_DOWN_WORDS.test(clean(row && (row.activity || row.text)));
}

/**
 * 把最后一条「睡前动作」挪到日程末尾（与末尾条目互换时间），
 * 避免出现「关灯了又去翻书」这种时间线倒错。
 */
function enforceWindDownLast(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (list.length < 2) return list;
  list.sort((a, b) => a.time.localeCompare(b.time));

  let index = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isWindDown(list[i])) { index = i; break; }
  }
  if (index === -1 || index === list.length - 1) return list;

  const last = list[list.length - 1];
  const bed = list[index];
  const tmp = bed.time;
  bed.time = last.time;
  last.time = tmp;
  list.sort((a, b) => a.time.localeCompare(b.time));
  return list;
}

// ---------------------------------------------------------------------------
// 池子状态
// ---------------------------------------------------------------------------

/**
 * 池子是否需要重生成：缺失 / 空 / generatedAt 缺失 / 超过 days 天。
 * @param {unknown} pool
 * @param {Date|string|number} [now]
 * @param {number} [days]
 * @returns {boolean}
 */
function poolFresh(pool, now = new Date(), days = 7) {
  const src = isPlainObject(pool) ? pool : {};
  const items = Array.isArray(src.items) ? src.items : [];
  if (items.length === 0) return true;

  const at = toDateOrNull(src.generatedAt) || localDateFromKey(clean(src.week));
  if (!at) return true;

  const current = toDateOrNull(now) || new Date();
  const maxAge = (Number.isFinite(days) && days > 0 ? days : 7) * 86400000;
  return current.getTime() - at.getTime() >= maxAge;
}

/**
 * 池子统计（设置页展示用）。
 * @param {unknown} pool
 * @param {{ character?: object, profile?: object, state?: object }} [ctx]
 * @returns {{ total: number, allowed: number, dropped: number }}
 */
function poolStats(pool, ctx = {}) {
  const src = isPlainObject(pool) ? pool : {};
  const items = Array.isArray(src.items) ? src.items : [];
  const allowed = filterPool(items, ctx).length;
  return {
    total: items.length,
    allowed,
    dropped: items.length - allowed,
  };
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  OCCUPATION_KINDS,
  PERIOD_CATEGORIES,
  occupationKind,
  hasCreative,
  allowedCategories,
  filterPool,
  buildFallbackPool,
  buildPoolMessages,
  parsePool,
  sampleDay,
  // 地点连续性（P8）：导出以便单测直接喂具体时间
  pruneScheduleByLocation,
  enforceWindDownLast,
  pruneContradictions,
  textTimeFits,
  isWindDown,
  bonusCandidatesForContinuity,
  poolFresh,
  poolStats,
  // 便于其他模块 / 测试复用
  normalizeText,
  localISOString,
  structureTiming,
  HIGH_STRUCTURE_ANCHORS,
  EVENING_INDOOR_FROM,
  LEAVE_HOME_MIN_GAP,
  POOL_MIN_ITEMS,
  POOL_MAX_ITEMS,
  PARSE_MIN_ITEMS,
  DAY_MIN_ITEMS,
  DAY_MAX_ITEMS,
  DAY_TARGET_LOW,
  DAY_TARGET_MID,
  DAY_TARGET_HIGH,
};
