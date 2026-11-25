'use strict';

// 生日与五维性格（P1 / specs/2026-10-27-life-v2-design.md 第 1、2、7 节）。
// 只做纯函数：不读盘、不调模型、不依赖 electron，方便单测。
//
// 约定：
// - 五维一律 0–100 的整数；越界 / NaN / 非数字统一夹取或回落 50。
// - 星座只作为「生成依据」：可以存进 persona.inner.zodiac，但绝不进入聊天提示词。
//   autoTraits 产出的句子、sanitizeInner 收下的 traits / boundaries 都会剔除星座词。
// - 生日按阳历（公历）解释；2/29 在平年按 2/28 过。

const PROFILE_KEYS = ['social', 'structure', 'openness', 'pace', 'expressiveness'];

const PROFILE_LABELS = {
  social: '社交',
  structure: '规律',
  openness: '开放',
  pace: '节奏',
  expressiveness: '表达',
};

const PROFILE_DEFAULT = 50;
const PROFILE_MIN = 0;
const PROFILE_MAX = 100;

// 12 星座 → 五维基准（取合理区间中值；每个星座各不相同）
const ZODIAC_TABLE = {
  水瓶座: { social: 45, structure: 35, openness: 85, pace: 60, expressiveness: 50 },
  双鱼座: { social: 40, structure: 30, openness: 80, pace: 35, expressiveness: 65 },
  白羊座: { social: 70, structure: 45, openness: 70, pace: 80, expressiveness: 75 },
  金牛座: { social: 40, structure: 75, openness: 40, pace: 25, expressiveness: 35 },
  双子座: { social: 65, structure: 35, openness: 75, pace: 75, expressiveness: 80 },
  巨蟹座: { social: 45, structure: 60, openness: 45, pace: 35, expressiveness: 45 },
  狮子座: { social: 75, structure: 55, openness: 60, pace: 60, expressiveness: 85 },
  处女座: { social: 35, structure: 85, openness: 45, pace: 50, expressiveness: 40 },
  天秤座: { social: 70, structure: 55, openness: 65, pace: 50, expressiveness: 60 },
  天蝎座: { social: 30, structure: 65, openness: 55, pace: 45, expressiveness: 30 },
  射手座: { social: 60, structure: 25, openness: 90, pace: 85, expressiveness: 70 },
  摩羯座: { social: 35, structure: 90, openness: 40, pace: 40, expressiveness: 30 },
};

const ZODIAC_NAMES = Object.keys(ZODIAC_TABLE);

// 每月「换星座」的起始日：当天及之后属于本月星座，之前属于上个月星座（摩羯座跨年）
const ZODIAC_CUTOFFS = [
  [1, 20, '水瓶座'],
  [2, 19, '双鱼座'],
  [3, 21, '白羊座'],
  [4, 20, '金牛座'],
  [5, 21, '双子座'],
  [6, 22, '巨蟹座'],
  [7, 23, '狮子座'],
  [8, 23, '处女座'],
  [9, 23, '天秤座'],
  [10, 24, '天蝎座'],
  [11, 23, '射手座'],
  [12, 22, '摩羯座'],
];

// 每月最长天数（2 月按 29 算：生日允许 2/29）
const MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// 星座 / 生肖类词：只用于过滤，不允许出现在 traits、boundaries、人格提示词里
const ZODIAC_WORDS = [
  '星座', '星盘', '占星', '十二宫', '生肖', '运势',
  '水瓶', '双鱼', '白羊', '金牛', '双子', '巨蟹',
  '狮子', '处女', '天秤', '天蝎', '射手', '摩羯',
];

const CREATIVE_RE = /(设计|插画|画师|画家|艺术|作家|写作|撰稿|文案|编剧|摄影|音乐|作曲|导演|动画|创意|手作|陶艺|漫画|剪辑|策展)/;
const FREELANCE_RE = /(自由职业|自由撰稿|自由插画|自由设计|自由摄影|自由画家|自由音乐|自由开发者|自由译者|自由人)/;

// ---------- 小工具 ----------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampProfileValue(value) {
  const number = toNumber(value);
  if (number === null) return PROFILE_DEFAULT;
  return Math.max(PROFILE_MIN, Math.min(PROFILE_MAX, Math.round(number)));
}

function hashOf(text) {
  let hash = 0;
  for (const ch of String(text)) {
    hash = (hash * 31 + ch.codePointAt(0)) % 1000003;
  }
  return Math.abs(hash);
}

function pick(list, seed) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list[hashOf(seed) % list.length];
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

function asTextList(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  const out = [];
  for (const item of list) {
    const text = clean(item);
    if (text) out.push(text);
  }
  return unique(out);
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 文本里是否含星座 / 生肖类词 */
function hasZodiacWord(text) {
  const value = clean(text).toLowerCase();
  if (!value) return false;
  if (value.includes('zodiac') || value.includes('horoscope')) return true;
  return ZODIAC_WORDS.some((word) => value.includes(word));
}

function stripZodiacWords(list) {
  return asTextList(list).filter((text) => !hasZodiacWord(text));
}

// ---------- 生日 / 星座 ----------

/**
 * 阳历（月, 日）→ 星座名。非法输入返回空串（不抛错）。
 * @param {number|string} month 1–12
 * @param {number|string} day 1–31
 * @returns {string}
 */
function zodiacOf(month, day) {
  const m = toNumber(month);
  const d = toNumber(day);
  if (!Number.isInteger(m) || !Number.isInteger(d)) return '';
  if (m < 1 || m > 12) return '';
  if (d < 1 || d > MAX_DAYS[m - 1]) return '';

  const cutoff = ZODIAC_CUTOFFS[m - 1];
  if (d >= cutoff[1]) return cutoff[2];
  const previous = ZODIAC_CUTOFFS[(m + 10) % 12];
  return previous[2];
}

/**
 * 生日是否合法：年可空（1900–2100），月 1–12，日按当月天数（2 月按 29 算）。
 * @param {{ year?: number|string|null, month?: number|string, day?: number|string }} birthday
 * @returns {boolean}
 */
function birthdayValid(birthday) {
  const src = isPlainObject(birthday) ? birthday : {};
  const month = toNumber(src.month);
  const day = toNumber(src.day);
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > MAX_DAYS[month - 1]) return false;

  const rawYear = src.year;
  if (rawYear === undefined || rawYear === null || rawYear === '') return true;
  const year = toNumber(rawYear);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return false;
  return true;
}

function asDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * 今天是不是她的生日（按本地时区的月/日比较）。
 * 2/29 生日在平年按 2/28 过。
 * @param {object} birthday
 * @param {Date|string|number} [now]
 * @returns {boolean}
 */
function isBirthdayToday(birthday, now = new Date()) {
  if (!birthdayValid(birthday)) return false;
  const date = asDate(now);
  const month = toNumber(birthday.month);
  const day = toNumber(birthday.day);
  const todayMonth = date.getMonth() + 1;
  const todayDay = date.getDate();

  if (todayMonth === month && todayDay === day) return true;
  if (
    month === 2
    && day === 29
    && todayMonth === 2
    && todayDay === 28
    && !isLeapYear(date.getFullYear())
  ) {
    return true;
  }
  return false;
}

// ---------- 五维 ----------

function hasPet(life) {
  const src = isPlainObject(life) ? life : {};
  if (src.hasPet === true) return true;
  if (typeof src.pet === 'string' && src.pet.trim() !== '') return true;
  const pets = src.pets;
  if (typeof pets === 'string' && pets.trim() !== '') return true;
  if (Array.isArray(pets) && pets.some((item) => typeof item === 'string' && item.trim() !== '')) {
    return true;
  }
  return false;
}

function occupationOf(life) {
  return clean(isPlainObject(life) ? life.occupation : '');
}

/**
 * 自动算五维：星座基准 + 职业 / 宠物修正，最后夹到 0–100。
 * 自由职业 structure −10；创意职业 openness +10；有宠物 social +5。
 * @param {{ birthday?: object, life?: object }} [input]
 * @returns {{ social: number, structure: number, openness: number, pace: number, expressiveness: number }}
 */
function autoProfile({ birthday, life } = {}) {
  const birth = isPlainObject(birthday) ? birthday : {};
  const zodiac = zodiacOf(birth.month, birth.day);
  const base = zodiac ? ZODIAC_TABLE[zodiac] : null;
  const profile = {};
  for (const key of PROFILE_KEYS) {
    profile[key] = base ? base[key] : PROFILE_DEFAULT;
  }

  const occupation = occupationOf(life);
  if (occupation) {
    if (FREELANCE_RE.test(occupation) || occupation.includes('自由')) profile.structure -= 10;
    if (CREATIVE_RE.test(occupation)) profile.openness += 10;
  }
  if (hasPet(life)) profile.social += 5;

  for (const key of PROFILE_KEYS) profile[key] = clampProfileValue(profile[key]);
  return profile;
}

/** 五维 → 「社交38/规律62/开放71/节奏45/表达55」，供日程提示词约束使用 */
function profileSummary(profile) {
  const src = isPlainObject(profile) ? profile : {};
  return PROFILE_KEYS
    .map((key) => `${PROFILE_LABELS[key]}${clampProfileValue(src[key])}`)
    .join('/');
}

// ---------- 内在设定 ----------

const LOW_CUT = 38;
const HIGH_CUT = 62;

const TRAIT_POOLS = {
  social: {
    low: [
      '不喜欢人多的地方，聚会到一半就想回家',
      '人一多就不太开口，更愿意跟一个人慢慢聊',
      '周末更想一个人待着，被约出门会先犹豫一下',
    ],
    mid: [
      '跟熟人话多，跟不熟的人要缓一缓',
      '偶尔想热闹，更多时候觉得待着就挺好',
    ],
    high: [
      '喜欢约人一起吃饭，一个人待久了会主动找人说话',
      '在人多的地方反而来劲，聊起来就停不住',
      '乐意认识新朋友，路上遇到熟人都要聊两句',
    ],
  },
  structure: {
    low: [
      '作息不太固定，常常临时改计划',
      '东西随手放，要用的时候再翻一遍',
      '想到什么就先做，计划常常只写一半',
    ],
    mid: [
      '大致有个作息，但周末会乱掉',
      '要紧的事会记下来，琐事随缘',
    ],
    high: [
      '答应的事会记很久，到点就去做',
      '每天差不多的时间起床，东西都放在固定的地方',
      '出门前会把要做的事列一遍，做完才安心',
    ],
  },
  openness: {
    low: [
      '不太愿意试没吃过的东西，点菜总点那几样',
      '习惯走同一条路，换条街会有点不自在',
      '对新出的东西要先观望一阵才肯用',
    ],
    mid: [
      '愿意试新东西，但还是会挑熟悉的',
      '陌生的地方会先看看，再决定要不要进去',
    ],
    high: [
      '看到没去过的小店会想进去看看',
      '新东西上手很快，愿意先试了再说',
      '喜欢换着花样来，同一件事不想天天一样',
    ],
  },
  pace: {
    low: [
      '走路慢，喜欢在路上停一停',
      '做事不赶，一件一件慢慢来',
      '说话也慢，经常停下来想下一句',
    ],
    mid: [
      '不忙的时候慢，赶时间也能快起来',
      '做事有自己的速度，不太受别人催',
    ],
    high: [
      '做事快，闲下来反而有点难受',
      '想到就去做，等不了太久',
      '说话也快，一句话接一句话',
    ],
  },
  expressiveness: {
    low: [
      '心里想得多，说出来的少',
      '不太主动讲自己的事，要问才说',
      '高兴或不高兴都藏着，不太让人看出来',
    ],
    mid: [
      '有话会说，但不会一次说完',
      '情绪看得出来，只是不常说出口',
    ],
    high: [
      '高兴或不高兴都写在脸上',
      '想到什么就直接说，不太绕弯子',
      '愿意讲自己的事，也爱问对方的事',
    ],
  },
};

// 极端值补的第二句（让 5 维特别偏的时候多 1–3 条），仍按方向区分
const EXTRA_POOLS = {
  social: {
    low: ['人多的场合会找靠边的位置站着', '一个人的时候反而更放松'],
    high: ['一安静下来就想找人说话', '喜欢把朋友凑到一起'],
  },
  structure: {
    low: ['临时改安排也不太介意', '常常做到一半又去做别的'],
    high: ['计划被打乱会有点不舒服', '东西都有它固定的位置'],
  },
  openness: {
    low: ['菜单上没吃过的会先跳过', '习惯把熟悉的事重复做'],
    high: ['看到新的做法会想学一下', '愿意为了新鲜感绕远路'],
  },
  pace: {
    low: ['事情堆着也不急着赶', '吃饭也慢，常常最后一个放下筷子'],
    high: ['事情堆着就坐不住', '赶时间的时候会一路小跑'],
  },
  expressiveness: {
    low: ['被问起近况只说「还行」', '不高兴的时候更不说话'],
    high: ['开心的时候会说个不停', '情绪上来了当场就说'],
  },
};

function bucketOf(value) {
  if (value < LOW_CUT) return 'low';
  if (value > HIGH_CUT) return 'high';
  return 'mid';
}

/**
 * 按五维挑 5–8 条具体行为描述（不是星座词）。
 * 每个维度先出 1 条；越偏的维度最多再补 3 条，总数不超过 8。
 * @param {{ zodiac?: string, profile?: object, life?: object }} [input]
 * @returns {string[]}
 */
function autoTraits({ zodiac, profile, life } = {}) {
  const normalized = {};
  for (const key of PROFILE_KEYS) {
    normalized[key] = clampProfileValue(isPlainObject(profile) ? profile[key] : undefined);
  }
  const seedBase = clean(zodiac) || 'inner';

  const traits = [];
  const extremes = [];
  for (const key of PROFILE_KEYS) {
    const bucket = bucketOf(normalized[key]);
    const pool = TRAIT_POOLS[key][bucket];
    const line = pick(pool, `${seedBase}|${key}|${bucket}`);
    if (line) traits.push(line);
    extremes.push({ key, bucket, distance: Math.abs(normalized[key] - PROFILE_DEFAULT) });
  }

  extremes.sort((a, b) => b.distance - a.distance || PROFILE_KEYS.indexOf(a.key) - PROFILE_KEYS.indexOf(b.key));
  for (const item of extremes) {
    if (traits.length >= 8) break;
    if (item.distance < 20) break;
    if (item.bucket === 'mid') continue;
    const extra = pick(EXTRA_POOLS[item.key][item.bucket], `${seedBase}|${item.key}|extra`);
    if (extra) traits.push(extra);
  }

  // life 只做兜底素材：有宠物且句子里还没提到，补一条日常
  if (traits.length < 5 && hasPet(life)) traits.push('回家第一件事是先看看家里的宠物');

  const out = unique(traits.filter((text) => !hasZodiacWord(text)));
  return out.slice(0, 8);
}

const DEFAULT_INNER_BOUNDARIES = ['不编造没发生过的事', '不主动提自己的生日'];

/**
 * 规范化 persona.inner：非法值一律回落，不抛错。
 * @param {unknown} raw
 * @returns {{ zodiac: string, profile: object, traits: string[], boundaries: string[],
 *             generatedAt: string|null, source: 'auto'|'manual' }}
 */
function sanitizeInner(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const zodiac = typeof src.zodiac === 'string' && ZODIAC_TABLE[src.zodiac] ? src.zodiac : '';

  const rawProfile = isPlainObject(src.profile) ? src.profile : {};
  const profile = {};
  for (const key of PROFILE_KEYS) profile[key] = clampProfileValue(rawProfile[key]);

  const generatedAt = typeof src.generatedAt === 'string' && src.generatedAt.trim() !== ''
    ? src.generatedAt.trim()
    : null;

  return {
    zodiac,
    profile,
    traits: stripZodiacWords(src.traits).slice(0, 12),
    boundaries: stripZodiacWords(src.boundaries).slice(0, 8),
    generatedAt,
    source: src.source === 'manual' ? 'manual' : 'auto',
  };
}

module.exports = {
  PROFILE_KEYS,
  PROFILE_LABELS,
  PROFILE_DEFAULT,
  ZODIAC_TABLE,
  ZODIAC_NAMES,
  DEFAULT_INNER_BOUNDARIES,
  zodiacOf,
  autoProfile,
  autoTraits,
  sanitizeInner,
  birthdayValid,
  isBirthdayToday,
  profileSummary,
  hasZodiacWord,
  hasPet,
};
