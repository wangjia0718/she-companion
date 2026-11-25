'use strict';

// 天气（P4）：全部用 mock global.fetch，不联网。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const weather = require('../src/main/weather');
const stateEngine = require('../src/main/state');

const NOW = new Date(2026, 9, 27, 9, 0, 0, 0);
const TODAY = '2026-10-27';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-weather-'));
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

/** 临时替换 global.fetch，测试结束自动还原 */
function mockFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return handler(String(url), options);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

// ---------------------------------------------------------------------------
// fetchWeather
// ---------------------------------------------------------------------------

test('fetchWeather：雨天解析（geocoding + forecast）', async (t) => {
  const calls = mockFetch(t, (url) => {
    if (url.includes('geocoding-api')) {
      return jsonResponse({ results: [{ latitude: 30.28, longitude: 120.15 }] });
    }
    return jsonResponse({ current: { temperature_2m: 18.5, weather_code: 61 } });
  });

  const value = await weather.fetchWeather({ city: '西湖区', now: NOW });
  assert.ok(value);
  assert.equal(value.source, 'open-meteo');
  assert.equal(value.code, 'rain');
  assert.equal(value.label, '雨');
  assert.equal(value.isRain, true);
  assert.equal(value.isClear, false);
  assert.equal(value.tempC, 18.5);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('name=%E8%A5%BF%E6%B9%96%E5%8C%BA'));
  assert.ok(calls[1].includes('current=temperature_2m,weather_code'));
  assert.ok(calls[1].includes('latitude=30.28'));
});

test('fetchWeather：晴天解析，内置城市表命中时不请求 geocoding', async (t) => {
  const calls = mockFetch(t, (url) => {
    assert.ok(url.includes('api.open-meteo.com'), '不应请求 geocoding');
    return jsonResponse({ current: { temperature_2m: 26.4, weather_code: 0 } });
  });

  const value = await weather.fetchWeather({ city: '上海', now: NOW });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('latitude=31.2304'));
  assert.ok(calls[0].includes('longitude=121.4737'));
  assert.equal(value.code, 'clear');
  assert.equal(value.isClear, true);
  assert.equal(value.isRain, false);
  assert.equal(value.tempC, 26.4);
});

test('fetchWeather：请求超时返回 null，不会一直等', async (t) => {
  mockFetch(t, () => new Promise(() => {}));
  const started = Date.now();
  const value = await weather.fetchWeather({ city: '上海', now: NOW, timeoutMs: 80 });
  const elapsed = Date.now() - started;
  assert.equal(value, null);
  assert.ok(elapsed < 1500, `超时后应立即返回，实际 ${elapsed}ms`);
});

test('fetchWeather：非 200 返回 null', async (t) => {
  mockFetch(t, () => jsonResponse({ current: null }, 500));
  assert.equal(await weather.fetchWeather({ city: '上海', now: NOW }), null);

  // geocoding 非 200
  mockFetch(t, () => jsonResponse({ results: [] }, 429));
  assert.equal(await weather.fetchWeather({ city: '某个没听过的地方', now: NOW }), null);
});

test('fetchWeather：geocoding 没有坐标返回 null，且不再请求 forecast', async (t) => {
  const calls = mockFetch(t, () => jsonResponse({ results: [] }));
  assert.equal(await weather.fetchWeather({ city: '某个没听过的地方', now: NOW }), null);
  assert.equal(calls.length, 1);
});

test('fetchWeather：网络异常 / 空城市返回 null，不抛错', async (t) => {
  mockFetch(t, () => {
    throw new Error('network down');
  });
  assert.equal(await weather.fetchWeather({ city: '上海', now: NOW }), null);
  assert.equal(await weather.fetchWeather({ city: '', now: NOW }), null);
});

test('fetchWeather：rainNow 跟随 current 观测值（缓存 1 小时内够新）', async (t) => {
  mockFetch(t, () => jsonResponse({ current: { temperature_2m: 15, weather_code: 61 } }));
  const value = await weather.fetchWeather({ city: '上海', now: NOW });
  assert.equal(value.isRain, true);
  assert.equal(value.rainNow, true);
});

test('fetchWeather：晴天时 rainNow 为 false', async (t) => {
  mockFetch(t, () => jsonResponse({ current: { temperature_2m: 22, weather_code: 0 } }));
  const value = await weather.fetchWeather({ city: '上海', now: NOW });
  assert.equal(value.isClear, true);
  assert.equal(value.rainNow, false);
});

test('weatherCodeInfo：主要天气码映射', () => {
  assert.equal(weather.weatherCodeInfo(0).code, 'clear');
  assert.equal(weather.weatherCodeInfo(3).code, 'cloudy');
  assert.equal(weather.weatherCodeInfo(45).code, 'fog');
  assert.equal(weather.weatherCodeInfo(63).code, 'rain');
  assert.equal(weather.weatherCodeInfo(75).code, 'snow');
  assert.equal(weather.weatherCodeInfo(81).code, 'shower');
  assert.equal(weather.weatherCodeInfo(95).code, 'thunder');
  assert.equal(weather.weatherCodeInfo(81).isRain, true);
  assert.equal(weather.weatherCodeInfo(75).isClear, false);
});

// ---------------------------------------------------------------------------
// weatherForDay
// ---------------------------------------------------------------------------

test('weatherForDay：当天已有 open-meteo 缓存且未过期时直接复用，不重复请求', async (t) => {
  const dir = tempDir();
  const cached = {
    code: 'rain', isRain: true, isClear: false, rainNow: true, tempC: 16,
    source: 'open-meteo', day: TODAY, at: weather.localISOString(NOW),
  };
  stateEngine.writeState(dir, 'char-w', { weather: cached }, NOW);
  const calls = mockFetch(t, () => {
    throw new Error('不应发起请求');
  });

  const value = await weather.weatherForDay({
    dir, characterId: 'char-w', city: '上海', now: NOW,
  });
  assert.deepEqual(value, cached);
  assert.equal(calls.length, 0);
});

test('weatherForDay：缓存超过 1 小时会重新抓，避免拿凌晨的天气说晚上', async (t) => {
  const dir = tempDir();
  const stale = {
    code: 'rain', isRain: true, isClear: false, rainNow: true, tempC: 16,
    source: 'open-meteo', day: TODAY, at: '2026-10-27T00:00:00+08:00',
  };
  stateEngine.writeState(dir, 'char-w', { weather: stale }, NOW);
  const calls = mockFetch(t, () => jsonResponse({
    current: { temperature_2m: 15, weather_code: 3 },
    hourly: {
      time: [`${TODAY}T09:00`, `${TODAY}T10:00`],
      weather_code: [3, 3],
    },
  }));

  const value = await weather.weatherForDay({
    dir, characterId: 'char-w', city: '上海', now: NOW,
  });
  assert.equal(calls.length, 1, '过期缓存应触发一次请求');
  assert.equal(value.code, 'cloudy');
  assert.equal(value.rainNow, false);
});

test('weatherForDay：重抓失败时保留当天已有真实天气，不用季节概率盖掉', async (t) => {
  const dir = tempDir();
  const stale = {
    code: 'rain', isRain: true, isClear: false, rainNow: true, tempC: 16,
    source: 'open-meteo', day: TODAY, at: '2026-10-27T00:00:00+08:00',
  };
  stateEngine.writeState(dir, 'char-w', { weather: stale }, NOW);
  mockFetch(t, () => {
    throw new Error('network down');
  });

  const value = await weather.weatherForDay({
    dir, characterId: 'char-w', city: '上海', now: NOW,
  });
  assert.deepEqual(value, stale);
});

test('weatherForDay：请求失败退回季节概率并写入 state.weather', async (t) => {
  const dir = tempDir();
  mockFetch(t, () => {
    throw new Error('network down');
  });

  const value = await weather.weatherForDay({
    dir, characterId: 'char-w', city: '上海', now: NOW,
  });
  assert.equal(value.source, 'seasonal');
  assert.equal(value.day, TODAY);
  assert.equal(value.city, '上海');
  assert.ok(['clear', 'cloudy', 'rain', 'snow'].includes(value.code));

  const stored = stateEngine.readState(dir, 'char-w', NOW);
  assert.equal(stored.weather.source, 'seasonal');
  assert.equal(stored.weather.day, TODAY);
});

test('weatherForDay：成功获取后写缓存，第二次不再请求', async (t) => {
  const dir = tempDir();
  let calls = 0;
  mockFetch(t, () => {
    calls += 1;
    return jsonResponse({ current: { temperature_2m: 20, weather_code: 3 } });
  });

  const first = await weather.weatherForDay({
    dir, characterId: 'char-w', city: '上海', now: NOW,
  });
  assert.equal(first.source, 'open-meteo');
  assert.equal(first.code, 'cloudy');
  assert.equal(calls, 1);

  const second = await weather.weatherForDay({
    dir, characterId: 'char-w', city: '上海', now: NOW,
  });
  assert.deepEqual(second, first);
  assert.equal(calls, 1, '当天缓存命中后不应再请求');
});
