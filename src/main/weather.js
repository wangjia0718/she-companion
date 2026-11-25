'use strict';

// 天气（P4 / specs/2026-10-27-life-v2-design.md 第 4 节）。
// - Open-Meteo：免费、无 key，直连不走代理；总超时默认 3 秒。
// - 先查坐标：内置常见城市表优先，命中就不再请求 geocoding。
// - 任何失败（超时 / 非 200 / JSON 异常 / 无坐标）都返回 null，由调用方退回季节概率。
// - weatherForDay 负责当日缓存：state.weather 已是当天 open-meteo 结果就直接复用。

const stateEngine = require('./state');
const calendar = require('./calendar');

const DEFAULT_TIMEOUT_MS = 3000;
// 天气缓存有效期：一小时内复用，超过就重抓（否则凌晨抓的"小雨"会被当成晚上还在下）
const WEATHER_TTL_MS = 60 * 60 * 1000;
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// 常见城市兜底（经纬度取市中心附近，足够判断晴雨）。
const CITY_COORDS = {
  上海: { latitude: 31.2304, longitude: 121.4737 },
  北京: { latitude: 39.9042, longitude: 116.4074 },
  杭州: { latitude: 30.2741, longitude: 120.1551 },
  成都: { latitude: 30.5728, longitude: 104.0668 },
  广州: { latitude: 23.1291, longitude: 113.2644 },
  深圳: { latitude: 22.5431, longitude: 114.0579 },
  南京: { latitude: 32.0603, longitude: 118.7969 },
  武汉: { latitude: 30.5928, longitude: 114.3055 },
  西安: { latitude: 34.3416, longitude: 108.9398 },
  重庆: { latitude: 29.563, longitude: 106.5516 },
};

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
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function dayKey(date = new Date()) {
  const value = asDate(date);
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

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

/** 城市名归一化：去掉「市 / 省」后缀，便于命中内置表 */
function normalizeCityName(city) {
  return clean(city).replace(/[市省]$/u, '').trim();
}

/** 内置城市表查找：先精确匹配，再按包含关系兜底 */
function builtinCoords(city) {
  const name = normalizeCityName(city);
  if (!name) return null;
  if (CITY_COORDS[name]) return { ...CITY_COORDS[name] };
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    if (name.includes(key) || key.includes(name)) return { ...coords };
  }
  return null;
}

/**
 * WMO weather_code → 归一化类别。
 * 0 晴；1–3 多云；45/48 雾；51–67 雨；71–77 雪；80–82 阵雨；95+ 雷雨。
 */
function weatherCodeInfo(rawCode) {
  const code = Number(rawCode);
  if (!Number.isFinite(code)) return { code: 'cloudy', label: '多云', isRain: false, isClear: false };
  if (code === 0) return { code: 'clear', label: '晴', isRain: false, isClear: true };
  if (code >= 1 && code <= 3) return { code: 'cloudy', label: '多云', isRain: false, isClear: false };
  if (code === 45 || code === 48) return { code: 'fog', label: '雾', isRain: false, isClear: false };
  if (code >= 51 && code <= 57) return { code: 'rain', label: '小雨', isRain: true, isClear: false };
  if (code >= 61 && code <= 67) return { code: 'rain', label: '雨', isRain: true, isClear: false };
  if (code >= 71 && code <= 77) return { code: 'snow', label: '雪', isRain: false, isClear: false };
  if (code >= 80 && code <= 82) return { code: 'shower', label: '阵雨', isRain: true, isClear: false };
  if (code === 85 || code === 86) return { code: 'snow', label: '阵雪', isRain: false, isClear: false };
  if (code >= 95) return { code: 'thunder', label: '雷雨', isRain: true, isClear: false };
  return { code: 'cloudy', label: '多云', isRain: false, isClear: false };
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  return null;
}

/**
 * 给 promise 套总超时：超时即 reject，并在 onTimeout 里 abort 请求。
 * 用「先挂 then」的写法，超时后请求再失败也不会变成 unhandledRejection。
 */
function raceTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (typeof onTimeout === 'function') {
        try {
          onTimeout();
        } catch {
          /* abort 失败不影响超时结果 */
        }
      }
      reject(new Error('timeout'));
    }, Math.max(1, Math.round(ms)));
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function requestJson(url, doFetch, controller, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('timeout');
  const response = await raceTimeout(
    Promise.resolve().then(() => doFetch(url, controller ? { signal: controller.signal } : {})),
    remaining,
    () => controller && controller.abort(),
  );
  if (!response) throw new Error('empty response');
  if (response.ok === false) {
    const error = new Error(`http ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const left = deadline - Date.now();
  if (left <= 0) throw new Error('timeout');
  return raceTimeout(
    Promise.resolve().then(() => response.json()),
    left,
    () => controller && controller.abort(),
  );
}

/**
 * 查一次天气；失败一律 null。
 * @param {{ city?: string, now?: Date|string|number, timeoutMs?: number,
 *           fetchImpl?: Function }} [input]
 * @returns {Promise<{ isRain: boolean, isClear: boolean, tempC: number|null,
 *                     code: string, label: string, source: 'open-meteo' } | null>}
 */
async function fetchWeather({
  city, now = new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl,
} = {}) {
  const name = clean(city);
  if (!name) return null;
  const doFetch = resolveFetch(fetchImpl);
  if (!doFetch) return null;

  const current = asDate(now);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + budget;

  try {
    let coords = builtinCoords(name);
    if (!coords) {
      const geoUrl = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=zh`;
      const geo = await requestJson(geoUrl, doFetch, controller, deadline);
      const first = geo && Array.isArray(geo.results) ? geo.results[0] : null;
      const latitude = first ? Number(first.latitude) : NaN;
      const longitude = first ? Number(first.longitude) : NaN;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      coords = { latitude, longitude };
    }

    const url = `${FORECAST_URL}?latitude=${coords.latitude}&longitude=${coords.longitude}`
      + '&current=temperature_2m,weather_code&timezone=auto';
    const payload = await requestJson(url, doFetch, controller, deadline);
    const observed = payload && isPlainObject(payload.current) ? payload.current : null;
    if (!observed) return null;

    const info = weatherCodeInfo(observed.weather_code);
    const rawTemp = Number(observed.temperature_2m);
    const tempC = Number.isFinite(rawTemp) ? Math.round(rawTemp * 10) / 10 : null;
    return {
      isRain: info.isRain,
      isClear: info.isClear,
      // 「此刻在下吗」直接用 current 的观测值：缓存只有 1 小时，够新。
      // 不要再拿 hourly 的预报去覆盖它（会和观测打架，反而更容易说错）。
      rainNow: info.isRain,
      tempC,
      code: info.code,
      label: info.label,
      source: 'open-meteo',
      at: localISOString(current),
    };
  } catch {
    return null;
  }
}

/**
 * 当天天气（优先复用 state.weather 缓存）。
 * - 当天已是 open-meteo 结果 → 直接返回，不请求；
 * - 否则尝试 fetchWeather；失败 / 城市为空 → 季节概率，并写回 state 缓存。
 * @param {{ dir?: string, characterId?: string, city?: string,
 *           now?: Date|string|number }} [input]
 * @returns {Promise<object>}
 */
async function weatherForDay({
  dir, characterId, city, now = new Date(),
} = {}) {
  const current = asDate(now);
  const today = dayKey(current);
  const id = clean(characterId);
  const hasStore = typeof dir === 'string' && dir !== '' && id !== '';

  let source = stateEngine.normalizeState({}, current);
  if (hasStore) {
    try {
      source = stateEngine.readState(dir, id, current);
    } catch {
      source = stateEngine.normalizeState({}, current);
    }
  }

  const cached = isPlainObject(source.weather) ? source.weather : null;
  const cachedAt = cached ? Date.parse(cached.at) : NaN;
  const fresh = Number.isFinite(cachedAt) && (current.getTime() - cachedAt) < WEATHER_TTL_MS;
  // 当天且没过期才复用；过期就重新抓，避免拿凌晨的数据说晚上的天气
  if (cached && cached.day === today && cached.source === 'open-meteo' && fresh) return cached;

  let weather = null;
  if (clean(city)) {
    weather = await fetchWeather({ city, now: current });
  }
  if (!weather) {
    // 抓失败时：当天已有真实天气就继续用旧值（宁可旧一点，也别用季节概率盖掉真实数据）
    if (cached && cached.day === today && cached.source === 'open-meteo') return cached;
    weather = calendar.seasonalWeather(current, id || clean(city));
  }

  const value = {
    ...weather,
    day: today,
    city: clean(city) || null,
    at: localISOString(current),
  };

  if (hasStore) {
    try {
      stateEngine.writeState(dir, id, { ...source, weather: value }, current);
    } catch (error) {
      console.warn(`[weather] 写入天气缓存失败：${error && error.message ? error.message : error}`);
    }
  }
  return value;
}

module.exports = {
  fetchWeather,
  weatherForDay,
  weatherCodeInfo,
  builtinCoords,
  CITY_COORDS,
  DEFAULT_TIMEOUT_MS,
  WEATHER_TTL_MS,
  GEOCODE_URL,
  FORECAST_URL,
  // 便于其他模块 / 测试复用
  dayKey,
  localISOString,
};
