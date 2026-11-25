'use strict';

// 静态内容集中在这里：代码只保留匹配规则、时序和状态逻辑。
// 打包版会优先读取 <安装目录>/data/content/*.json；没有或格式不合格时回退到内置 JSON。
// 这样改文案只要改 data/content 下的 JSON、重启即可，不需要重新打包。

const fs = require('node:fs');
const path = require('node:path');

const bundled = {
  activityDetails: require('./activity-details.json'),
  categoryDetails: require('./category-details.json'),
  eventTemplates: require('./event-templates.json'),
  proactiveFallbacks: require('./proactive-fallbacks.json'),
  fallbackEntries: require('./fallback-entries.json'),
  homeDiscoveries: require('./home-discoveries.json'),
  defaultSchedule: require('./default-schedule.json'),
};

const overrideDir = typeof process.env.SHE_CONTENT_DIR === 'string'
  ? process.env.SHE_CONTENT_DIR.trim()
  : '';

function readOverride(name) {
  if (!overrideDir) return null;
  const file = path.join(overrideDir, name);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(`[content] 读取 ${name} 失败，使用内置版本：${error && error.message ? error.message : error}`);
    return null;
  }
}

function isStringArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

function isDetailsMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lists = Object.values(value);
  return lists.length > 0 && lists.every(isStringArray);
}

function isProactiveFallbacks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lists = Object.values(value);
  return lists.length > 0 && lists.every(isStringArray);
}

function isFallbackEntries(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => item && typeof item === 'object'
      && typeof item.category === 'string'
      && typeof item.text === 'string'
      && item.text.trim() !== '');
}

function isHomeDiscoveries(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => item && typeof item === 'object'
      && typeof item.text === 'string'
      && item.text.trim() !== '');
}

function isDefaultSchedule(value) {
  return !!value
    && typeof value === 'object'
    && !!value.zh
    && typeof value.zh === 'object'
    && Array.isArray(value.en)
    && value.en.length === 5
    && value.en.every((item) => typeof item === 'string' && item.trim() !== '');
}

function pick(name, fallback, check) {
  const value = readOverride(name);
  if (value === null) return fallback;
  if (check(value)) return value;
  console.warn(`[content] ${name} 结构不合法，使用内置版本`);
  return fallback;
}

module.exports = {
  activityDetails: pick('activity-details.json', bundled.activityDetails, isDetailsMap),
  categoryDetails: pick('category-details.json', bundled.categoryDetails, isDetailsMap),
  eventTemplates: pick('event-templates.json', bundled.eventTemplates, isStringArray),
  proactiveFallbacks: pick('proactive-fallbacks.json', bundled.proactiveFallbacks, isProactiveFallbacks),
  fallbackEntries: pick('fallback-entries.json', bundled.fallbackEntries, isFallbackEntries),
  homeDiscoveries: pick('home-discoveries.json', bundled.homeDiscoveries, isHomeDiscoveries),
  defaultSchedule: pick('default-schedule.json', bundled.defaultSchedule, isDefaultSchedule),
};
