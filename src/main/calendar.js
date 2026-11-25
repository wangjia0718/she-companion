'use strict';

// 节日 / 节气 / 季节 / 季节概率天气（P4 / specs/2026-10-27-life-v2-design.md 第 4 节）。
// 数据随项目走（data/holidays.json），不联网、不做运行时农历转换。
// 纯函数：同一日期 / 同一种子结果稳定，方便单测与「同日结果一致」。

const HOLIDAYS = require('../../data/holidays.json');
const i18n = require('./i18n');

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const FESTIVAL_CATEGORIES = ['home', 'discovery', 'selfcare', 'create', 'solo_out'];

// 季节概率（百分比）：冬天下雪、夏天多雨，春天雨多一些。
// 同一 (日期, seed) 的抽取结果固定，避免同一天反复刷新天气。
const SEASONAL_ODDS = {
  春: [['clear', 35], ['cloudy', 35], ['rain', 30]],
  夏: [['clear', 35], ['cloudy', 30], ['rain', 35]],
  秋: [['clear', 45], ['cloudy', 33], ['rain', 22]],
  冬: [['clear', 40], ['cloudy', 40], ['rain', 10], ['snow', 10]],
};

// 节日专属活动素材：全部是普通一天里真会做的事，category 只用无门槛 / 低门槛类型。
// solo_out 带 opennessMin，过 activity.filterPool 时会被低开放度的角色挡掉。
const FESTIVAL_ACTIVITIES = {
  元旦: [
    {
      category: 'home', text: '元旦，把新日历挂上，旧的那页撕下来夹进书里', solo: true, indoor: true, energyCost: 4,
    },
    {
      category: 'discovery', text: '元旦，街上比平时安静，出门走了一小圈', solo: true, indoor: false, energyCost: 6,
    },
  ],
  情人节: [
    {
      category: 'home', text: '情人节，给自己买了支花，插在喝空的玻璃瓶里', solo: true, indoor: true, energyCost: 3,
    },
    {
      category: 'discovery', text: '情人节，路边花店排队，站在旁边看了一会儿', solo: true, indoor: false, energyCost: 4,
    },
  ],
  妇女节: [
    {
      category: 'selfcare', text: '妇女节，给自己订了一小束花，摆在桌上', solo: true, indoor: true, energyCost: 2,
    },
    {
      category: 'home', text: '妇女节，煮了碗甜的，慢慢吃完', solo: true, indoor: true, energyCost: 6,
    },
  ],
  劳动节: [
    {
      category: 'home', text: '劳动节，把家里收拾了一遍，算是给自己放了个假', solo: true, indoor: true, energyCost: 16,
    },
    {
      category: 'discovery', text: '劳动节，楼下比平时热闹，出去转了转', solo: true, indoor: false, energyCost: 8,
    },
  ],
  儿童节: [
    {
      category: 'home', text: '儿童节，买了小时候爱吃的那种糖', solo: true, indoor: true, energyCost: 3,
    },
    {
      category: 'discovery', text: '儿童节，看小区里的孩子追跑，站着看了会儿', solo: true, indoor: false, energyCost: 3,
    },
  ],
  国庆: [
    {
      category: 'solo_out', text: '国庆，街上挂满了旗子，一个人走了很久', solo: true, indoor: false, energyCost: 12, needs: { opennessMin: 45 },
    },
    {
      category: 'home', text: '国庆，外面人多，索性待在家里把窗帘洗了', solo: true, indoor: true, energyCost: 14,
    },
  ],
  平安夜: [
    {
      category: 'home', text: '平安夜，在窗边坐了会儿，楼下的灯亮到很晚', solo: true, indoor: true, energyCost: 3,
    },
    {
      category: 'create', text: '平安夜，随手画了张小卡片，没送给谁', solo: true, indoor: true, energyCost: 8, needs: { occupation: 'creative' },
    },
  ],
  圣诞: [
    {
      category: 'home', text: '圣诞，煮了杯热红酒，屋里都是香料味', solo: true, indoor: true, energyCost: 6,
    },
    {
      category: 'discovery', text: '圣诞，便利店的店员戴了顶红帽子', solo: true, indoor: false, energyCost: 3,
    },
  ],
  春节: [
    {
      category: 'home', text: '春节，包了饺子，馅儿调得有点咸', solo: true, indoor: true, energyCost: 14,
    },
    {
      category: 'discovery', text: '春节，窗外零星有鞭炮声，站在窗边听了一会儿', solo: true, indoor: true, energyCost: 3,
    },
  ],
  元宵: [
    {
      category: 'home', text: '元宵，煮了汤圆，芝麻馅的烫了嘴', solo: true, indoor: true, energyCost: 6,
    },
    {
      category: 'discovery', text: '元宵，楼下有人放小烟花，抬头看了一会儿', solo: true, indoor: false, energyCost: 3,
    },
  ],
  端午: [
    {
      category: 'home', text: '端午，包了粽子，糯米泡了一整个上午', solo: true, indoor: true, energyCost: 14,
    },
    {
      category: 'discovery', text: '端午，楼下飘着粽叶味，站了一会儿才上楼', solo: true, indoor: false, energyCost: 3,
    },
  ],
  中秋: [
    {
      category: 'home', text: '中秋，切了块月饼，配着茶慢慢吃完', solo: true, indoor: true, energyCost: 4,
    },
    {
      category: 'discovery', text: '中秋，月亮很圆，站在阳台上看了会儿', solo: true, indoor: false, energyCost: 2,
    },
  ],
};

const GENERIC_FESTIVAL = [
  {
    category: 'home', text: '今天过节，给自己煮了点好吃的', solo: true, indoor: true, energyCost: 8,
  },
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function hashString(text) {
  let hash = 0;
  for (const ch of String(text)) {
    hash = (hash * 31 + ch.codePointAt(0)) % 1000003;
  }
  return Math.abs(hash);
}

/** 任意日期输入 → { year, month, day, key, mmdd }；非法返回 null */
function dateParts(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getFullYear();
    const month = value.getMonth() + 1;
    const day = value.getDate();
    return { year, month, day, key: `${year}-${pad2(month)}-${pad2(day)}`, mmdd: `${pad2(month)}-${pad2(day)}` };
  }
  if (typeof value === 'number' && Number.isFinite(value)) return dateParts(new Date(value));
  if (typeof value === 'string') {
    const m = DAY_KEY_PATTERN.exec(value.trim());
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const probe = new Date(year, month - 1, day);
    if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
      return null;
    }
    return { year, month, day, key: `${year}-${pad2(month)}-${pad2(day)}`, mmdd: `${pad2(month)}-${pad2(day)}` };
  }
  return null;
}

/**
 * 阳历 / 农历节日。
 * @param {Date|string} date
 * @returns {{ name: string, kind: 'solar'|'lunar' } | null}
 */
function holidayOf(date) {
  const parts = dateParts(date);
  if (!parts) return null;

  for (const entry of Array.isArray(HOLIDAYS.solar) ? HOLIDAYS.solar : []) {
    if (!isPlainObject(entry)) continue;
    if (Number(entry.month) === parts.month && Number(entry.day) === parts.day) {
      return { name: clean(entry.name) || '节日', kind: 'solar' };
    }
  }

  const lunar = isPlainObject(HOLIDAYS.lunar) ? HOLIDAYS.lunar[String(parts.year)] : null;
  if (isPlainObject(lunar)) {
    const name = clean(lunar[parts.mmdd]);
    if (name) return { name, kind: 'lunar' };
  }
  return null;
}

/**
 * 24 节气名；年份不在表内或当天不是节气返回 null。
 * @param {Date|string} date
 * @returns {string|null}
 */
function solarTermOf(date) {
  const parts = dateParts(date);
  if (!parts) return null;
  const terms = isPlainObject(HOLIDAYS.terms) ? HOLIDAYS.terms[String(parts.year)] : null;
  if (!Array.isArray(terms)) return null;
  for (const entry of terms) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    if (clean(entry[1]) === parts.mmdd) return clean(entry[0]) || null;
  }
  return null;
}

/**
 * 季节（按月份，气象季节）：3–5 春、6–8 夏、9–11 秋、12–2 冬。
 * @param {Date|string} date
 * @returns {'春'|'夏'|'秋'|'冬'}
 */
function seasonOf(date) {
  const parts = dateParts(date);
  const month = parts ? parts.month : new Date().getMonth() + 1;
  if (month >= 3 && month <= 5) return '春';
  if (month >= 6 && month <= 8) return '夏';
  if (month >= 9 && month <= 11) return '秋';
  return '冬';
}

function seasonalCode(date, seed) {
  const parts = dateParts(date);
  const season = seasonOf(date);
  const table = SEASONAL_ODDS[season] || SEASONAL_ODDS['春'];
  const roll = hashString(`${parts ? parts.key : ''}|${clean(seed) || 'default'}|seasonal-weather`) % 100;
  let acc = 0;
  for (const [code, weight] of table) {
    acc += weight;
    if (roll < acc) return code;
  }
  return table[table.length - 1][0];
}

/**
 * 无网络时的季节概率天气（同一天 + 同一种子结果稳定）。
 * @param {Date|string} date
 * @param {string|number} [seed] 一般传角色 id
 * @returns {{ code: 'clear'|'cloudy'|'rain'|'snow', isRain: boolean, isClear: boolean,
 *             source: 'seasonal' }}
 */
function seasonalWeather(date, seed) {
  const code = seasonalCode(date, seed);
  return {
    code,
    isRain: code === 'rain',
    isClear: code === 'clear',
    source: 'seasonal',
  };
}

function normalizeHoliday(input) {
  if (typeof input === 'string') {
    const name = clean(input);
    return name ? { name, kind: 'solar' } : null;
  }
  if (!isPlainObject(input)) return null;
  const name = clean(input.name);
  if (!name) return null;
  const kind = input.kind === 'lunar' ? 'lunar' : 'solar';
  return { name, kind };
}

function normalizeFestivalEntry(entry) {
  const item = isPlainObject(entry) ? entry : {};
  const category = clean(item.category);
  if (!FESTIVAL_CATEGORIES.includes(category)) return null;
  const text = clean(item.text);
  if (!text) return null;
  const needs = isPlainObject(item.needs) ? item.needs : {};
  return {
    category,
    text: i18n.t(text),
    solo: item.solo !== false,
    indoor: item.indoor !== false,
    energyCost: Number.isFinite(Number(item.energyCost)) ? Math.max(0, Math.round(Number(item.energyCost))) : 8,
    needs: {
      socialMin: Number.isFinite(Number(needs.socialMin)) ? Number(needs.socialMin) : 0,
      opennessMin: Number.isFinite(Number(needs.opennessMin)) ? Number(needs.opennessMin) : 0,
      occupation: clean(needs.occupation) || null,
    },
  };
}

/**
 * 节日当天可用的 1–2 条活动；全部先过 activity.filterPool 的硬约束。
 * 低开放度 / 低社交的角色拿不到出门类节日活动，只会留下居家条目。
 *
 * @param {object} [character]
 * @param {object} [profile] 五维；缺省时 activity 会从 character.persona.inner.profile 取
 * @param {{ date?: Date|string, holiday?: object|string, weather?: object, term?: string,
 *           season?: string, state?: object }} [ctx]
 * @returns {Array<object>}
 */
function festivalActivities(character, profile, ctx = {}) {
  const context = isPlainObject(ctx) ? ctx : {};
  const holiday = normalizeHoliday(context.holiday) || holidayOf(context.date);
  if (!holiday) return [];

  const source = FESTIVAL_ACTIVITIES[holiday.name] || GENERIC_FESTIVAL;
  const candidates = source.map(normalizeFestivalEntry).filter(Boolean);
  if (candidates.length === 0) return [];

  // 延迟 require，避免与 activity.js 形成加载期循环依赖。
  const activity = require('./activity');
  const filtered = activity.filterPool(candidates, {
    character,
    profile,
    state: context.state,
  });
  if (filtered.length === 0) return [];

  const parts = dateParts(context.date);
  const more = filtered.length >= 2
    && hashString(`${holiday.name}|${parts ? parts.key : ''}|count`) % 2 === 0;
  return filtered.slice(0, more ? 2 : 1).map((item) => ({ ...item, festival: holiday.name }));
}

module.exports = {
  holidayOf,
  solarTermOf,
  seasonOf,
  seasonalWeather,
  festivalActivities,
  normalizeHoliday,
  // 便于其他模块 / 测试复用
  SEASONAL_ODDS,
  FESTIVAL_ACTIVITIES,
  dateParts,
  hashString,
};
