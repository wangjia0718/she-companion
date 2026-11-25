'use strict';

// 设置读写：默认值（Spec 5.1）、逐字段校验、原子写、脱敏。
// 只用 Node 标准库；CommonJS。

const paths = require('./paths');
const store = require('./store');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const THEMES = ['warm'];
const LANGUAGES = ['zh', 'en'];
const CAPABILITIES = ['chat', 'embedding'];

const DEFAULT_SETTINGS = {
  version: 1,
  onboarded: false,
  api: {
    profiles: [
      {
        id: 'p1',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        model: 'deepseek-chat',
        temperature: 0.8,
        maxTokens: 1024,
        capabilities: ['chat'],
      },
    ],
    chat: 'p1',
    background: 'p1',
    embedding: null,
  },
  ui: {
    theme: 'warm',
    // 界面与生成内容语言：zh = 中文，en = English（旧配置缺省按中文）
    language: 'zh',
    petScale: 1.0,
    petPos: { x: null, y: null },
    alwaysOnTop: true,
    clickThrough: false,
    autostart: false,
  },
  life: {
    enabled: true,
    quietFrom: '23:30',
    quietTo: '08:00',
    // 每周主动消息次数范围（0–63）；每周在范围内加权取一个数，再随机分到本周若干天
    proactiveWeekMin: 0,
    proactiveWeekMax: 10,
    scheduleHour: 6,
    diaryHour: 21,
    maxBackgroundCallsPerDay: 24,
    useWeather: true,
    // 日程生成后是否让模型自检一次（每天最多 1 次调用，与主动消息共用后台预算）
    scheduleReview: true,
    // 是否让模型结合当天日程生成一件小意外（可返回空；不是每天都有）
    dailyDiscovery: true,
    // 用户发这些内容时，角色不再回复（每行一条，可在设置里改）
    silentEndPhrases: ['安～', '安~'],
  },
  memory: {
    extractEveryTurns: 4,
    extractIdleMinutes: 10,
    shortTermTurns: 12,
    recallTopK: 12,
    vectorEnabled: false,
  },
  // 语音：把她说的话念出来（本地合成，不联网）
  voice: {
    enabled: true,
    // auto = kokoro → piper → 系统语音，逐级回落；也可指定单一引擎
    engine: 'auto',
    // kokoro 的中文音色（zf_* 女 / zm_* 男）
    kokoroVoice: 'zf_xiaoxiao',
    // 系统语音（SAPI）的音色名；空 = 系统默认中文女声
    sapiVoice: '',
    // 语速倍率：0.6 慢 ~ 1.6 快
    rate: 1.0,
    volume: 1.0,
    // 聊天里的回复要不要念
    inChat: true,
    // 桌面小人的主动消息要不要念
    inBubble: true,
    // 自定义 piper 模型路径（空 = 自动找）
    modelPath: '',
  },
  activeCharacterId: null,
};

// 默认值只读，避免任何模块误改全局默认
deepFreeze(DEFAULT_SETTINGS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function describe(value) {
  if (value === undefined) return '未设置';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '数组';
  return typeof value;
}

function section(raw, key, warnings) {
  const value = isPlainObject(raw) ? raw[key] : undefined;
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    warnings.push(`${key} 应为对象（收到 ${describe(value)}），该分区已回落为默认值`);
    return {};
  }
  return value;
}

function readBool(src, key, fallback, label, warnings) {
  const value = src[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    warnings.push(`${label} 应为 true/false（收到 ${describe(value)}），已回落为 ${fallback}`);
    return fallback;
  }
  return value;
}

function readInt(src, key, fallback, min, max, label, warnings) {
  const value = src[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    warnings.push(`${label} 应为 ${min}–${max} 的整数（收到 ${describe(value)}），已回落为 ${fallback}`);
    return fallback;
  }
  return value;
}

function readIntClamped(src, key, fallback, min, max, label, warnings) {
  const value = src[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    warnings.push(`${label} 应为 ${min}–${max} 的整数（收到 ${describe(value)}），已回落为 ${fallback}`);
    return fallback;
  }
  if (value > max) {
    warnings.push(`${label} 最大为 ${max}（收到 ${describe(value)}），已按 ${max} 处理`);
    return max;
  }
  return value;
}

function readNumber(src, key, fallback, min, max, label, warnings) {
  const value = src[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    warnings.push(`${label} 应为 ${min}–${max} 的数字（收到 ${describe(value)}），已回落为 ${fallback}`);
    return fallback;
  }
  return value;
}

function readTime(src, key, fallback, label, warnings) {
  const value = src[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !HHMM.test(value)) {
    warnings.push(`${label} 应为 HH:MM（收到 ${describe(value)}），已回落为 ${fallback}`);
    return fallback;
  }
  return value;
}

/** 可空字符串：缺省/空串都回落到默认（默认通常是 ''），非字符串告警 */
function readOptionalString(src, key, fallback, label, warnings) {
  const value = src[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    warnings.push(`${label} 应为字符串（收到 ${describe(value)}），已回落为默认值`);
    return fallback;
  }
  const text = value.trim();
  return text === '' ? fallback : text;
}

/** 字符串数组：每项去空白、去空行、去重；非法值回落到默认 */
function readStringList(src, key, fallback, label, warnings) {  const value = src[key];
  if (value === undefined) return fallback.slice();
  if (!Array.isArray(value)) {
    warnings.push(`${label} 应为字符串数组（收到 ${describe(value)}），已回落为默认`);
    return fallback.slice();
  }
  const list = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text && !list.includes(text)) list.push(text);
  }
  return list;
}

/** 枚举字符串：只接受白名单内的值，其它回落默认并告警 */
function readEnum(src, key, fallback, allowed, label, warnings) {
  const value = src[key];
  if (value === undefined) return fallback;
  if (typeof value === 'string' && allowed.includes(value)) return value;
  warnings.push(`${label} 只支持 ${allowed.join('/')}（收到 ${describe(value)}），已回落为 ${fallback}`);
  return fallback;
}

function normalizeBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, '');
}

function validateProfile(raw, index, warnings) {
  const label = `api.profiles[${index}]`;
  if (!isPlainObject(raw)) {
    warnings.push(`${label} 不是对象，已忽略`);
    return null;
  }
  const rawId = raw.id;
  const id = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : null;
  if (!id) {
    warnings.push(`${label}.id 缺失，已忽略该配置组`);
    return null;
  }
  const fallbackProfile = DEFAULT_SETTINGS.api.profiles[0];

  const baseUrl = normalizeBaseUrl(raw.baseUrl === undefined ? fallbackProfile.baseUrl : raw.baseUrl);
  const baseUrlOk = /^https?:\/\/[^/\s]+/i.test(baseUrl);
  if (!baseUrlOk) {
    warnings.push(`${label}.baseUrl 应为 http(s) 地址（收到 ${describe(raw.baseUrl)}），已回落为 ${fallbackProfile.baseUrl}`);
  }

  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id;

  let model = fallbackProfile.model;
  if (raw.model !== undefined) {
    if (typeof raw.model === 'string' && raw.model.trim() !== '') {
      model = raw.model.trim();
    } else {
      warnings.push(`${label}.model 应为非空文本（收到 ${describe(raw.model)}），已回落为 ${model}`);
    }
  }

  let capabilities = fallbackProfile.capabilities;
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities)) {
      warnings.push(`${label}.capabilities 应为数组（收到 ${describe(raw.capabilities)}），已回落为 ["chat"]`);
    } else {
      const kept = raw.capabilities.filter((c) => CAPABILITIES.includes(c));
      if (kept.length !== raw.capabilities.length) {
        warnings.push(`${label}.capabilities 含未知能力，仅保留 ${CAPABILITIES.join('/')}`);
      }
      if (kept.length === 0) {
        warnings.push(`${label}.capabilities 为空，已回落为 ["chat"]`);
        capabilities = ['chat'];
      } else {
        capabilities = Array.from(new Set(kept));
      }
    }
  }

  return {
    id,
    name,
    baseUrl: baseUrlOk ? baseUrl : fallbackProfile.baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    model,
    temperature: readNumber(raw, 'temperature', fallbackProfile.temperature, 0, 2, `${label}.temperature`, warnings),
    maxTokens: readInt(raw, 'maxTokens', fallbackProfile.maxTokens, 1, 1000000, `${label}.maxTokens`, warnings),
    capabilities: clone(capabilities),
    userAgent: readUserAgent(raw.userAgent, label, warnings),
    headers: readExtraHeaders(raw.headers, `${label}.headers`, warnings),
  };
}

/** 自定义 User-Agent：单行、≤200 字，非法则返回空串（由 llm.js 用默认值） */
function readUserAgent(raw, label, warnings) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    warnings.push(`${label}.userAgent 应为文本（收到 ${describe(raw)}），已忽略`);
    return '';
  }
  const value = raw.trim();
  if (!value) return '';
  if (/[\r\n\0]/.test(value) || value.length > 200) {
    warnings.push(`${label}.userAgent 含换行或过长，已忽略`);
    return '';
  }
  return value;
}

/** 额外请求头：只接受 字符串→字符串/数字 的扁平对象，键值都禁控制字符 */
function readExtraHeaders(raw, label, warnings) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    warnings.push(`${label} 应为对象（收到 ${describe(raw)}），已忽略`);
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key || '').trim();
    if (!k) continue;
    if (/[\r\n\0]/.test(k) || k.length > 64) {
      warnings.push(`${label} 含非法键名，已忽略`);
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      warnings.push(`${label}.${k} 应为文本或数字，已忽略`);
      continue;
    }
    const v = String(value);
    if (/[\r\n\0]/.test(v) || v.length > 512) {
      warnings.push(`${label}.${k} 含换行或过长，已忽略`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function validateProfiles(rawProfiles, warnings) {
  if (rawProfiles === undefined) return clone(DEFAULT_SETTINGS.api.profiles);
  if (!Array.isArray(rawProfiles)) {
    warnings.push(`api.profiles 应为数组（收到 ${describe(rawProfiles)}），已回落为默认配置组`);
    return clone(DEFAULT_SETTINGS.api.profiles);
  }

  const seen = new Set();
  const profiles = [];
  rawProfiles.forEach((item, index) => {
    const profile = validateProfile(item, index, warnings);
    if (!profile) return;
    if (seen.has(profile.id)) {
      warnings.push(`api.profiles 存在重复 id ${profile.id}，已忽略后者`);
      return;
    }
    seen.add(profile.id);
    profiles.push(profile);
  });

  if (profiles.length === 0) {
    warnings.push('api.profiles 为空，已回落为默认配置组');
    return clone(DEFAULT_SETTINGS.api.profiles);
  }
  return profiles;
}

function pickProfileId(value, profiles, fallbackId, allowNull, label, warnings) {
  if (value === undefined) return fallbackId;
  if (value === null) {
    if (allowNull) return null;
    warnings.push(`${label} 不能为空，已回落为 ${fallbackId}`);
    return fallbackId;
  }
  if (typeof value === 'string' && profiles.some((p) => p.id === value)) return value;
  warnings.push(`${label} 指向不存在的配置组（收到 ${describe(value)}），已回落为 ${fallbackId}`);
  return fallbackId;
}

function validatePetPos(raw, warnings) {
  if (raw === undefined) return clone(DEFAULT_SETTINGS.ui.petPos);
  if (!isPlainObject(raw)) {
    warnings.push(`ui.petPos 应为 {x, y}（收到 ${describe(raw)}），已回落为未定位`);
    return clone(DEFAULT_SETTINGS.ui.petPos);
  }
  const out = { x: null, y: null };
  for (const axis of ['x', 'y']) {
    const value = raw[axis];
    if (value === undefined || value === null) {
      out[axis] = null;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[axis] = value;
    } else {
      warnings.push(`ui.petPos.${axis} 应为数字或 null（收到 ${describe(value)}），已重置为未定位`);
      out[axis] = null;
    }
  }
  return out;
}

/**
 * 逐字段校验并补全默认值。
 * @param {unknown} raw
 * @returns {{ settings: typeof DEFAULT_SETTINGS, warnings: string[] }}
 */
function validateSettings(raw) {
  const warnings = [];
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    warnings.push(`设置内容应为对象（收到 ${describe(raw)}），已全部回落为默认值`);
    raw = {};
  }
  const src = isPlainObject(raw) ? raw : {};

  const apiSrc = section(src, 'api', warnings);
  const uiSrc = section(src, 'ui', warnings);
  const lifeSrc = section(src, 'life', warnings);
  const memSrc = section(src, 'memory', warnings);

  const profiles = validateProfiles(apiSrc.profiles, warnings);
  const firstId = profiles[0].id;

  // 先定 background，chat 缺失/非法时跟随它（其次第一个配置组）
  const background = pickProfileId(apiSrc.background, profiles, firstId, false, 'api.background', warnings);
  const api = {
    profiles,
    chat: pickProfileId(apiSrc.chat, profiles, background, false, 'api.chat', warnings),
    background,
    embedding: pickProfileId(apiSrc.embedding, profiles, null, true, 'api.embedding', warnings),
  };

  const themeRaw = uiSrc.theme;
  let theme = DEFAULT_SETTINGS.ui.theme;
  if (themeRaw !== undefined) {
    if (typeof themeRaw === 'string' && THEMES.includes(themeRaw)) {
      theme = themeRaw;
    } else {
      warnings.push(`ui.theme 只支持 ${THEMES.join('/')}（收到 ${describe(themeRaw)}），已回落为 ${theme}`);
    }
  }

  const ui = {
    theme,
    language: readEnum(uiSrc, 'language', DEFAULT_SETTINGS.ui.language, LANGUAGES, 'ui.language', warnings),
    petScale: readNumber(uiSrc, 'petScale', DEFAULT_SETTINGS.ui.petScale, 0.2, 2.0, 'ui.petScale', warnings),
    petPos: validatePetPos(uiSrc.petPos, warnings),
    alwaysOnTop: readBool(uiSrc, 'alwaysOnTop', DEFAULT_SETTINGS.ui.alwaysOnTop, 'ui.alwaysOnTop', warnings),
    clickThrough: readBool(uiSrc, 'clickThrough', DEFAULT_SETTINGS.ui.clickThrough, 'ui.clickThrough', warnings),
    autostart: readBool(uiSrc, 'autostart', DEFAULT_SETTINGS.ui.autostart, 'ui.autostart', warnings),
  };

  // 旧版是单个 proactivePerWeek（3–5）；没有新范围字段时迁成 0–旧值，保留原来的上限
  const legacyRaw = Number.isInteger(lifeSrc.proactivePerWeek)
    && lifeSrc.proactivePerWeek >= 0
    ? lifeSrc.proactivePerWeek
    : null;
  if (legacyRaw !== null && legacyRaw > 63) {
    warnings.push(`life.proactivePerWeek 最大为 63（收到 ${legacyRaw}），已按 63 处理`);
  }
  const legacyWeek = legacyRaw === null ? null : Math.min(legacyRaw, 63);
  const useLegacyWeek = legacyWeek !== null
    && lifeSrc.proactiveWeekMin === undefined
    && lifeSrc.proactiveWeekMax === undefined;
  const life = {
    enabled: readBool(lifeSrc, 'enabled', DEFAULT_SETTINGS.life.enabled, 'life.enabled', warnings),
    quietFrom: readTime(lifeSrc, 'quietFrom', DEFAULT_SETTINGS.life.quietFrom, 'life.quietFrom', warnings),
    quietTo: readTime(lifeSrc, 'quietTo', DEFAULT_SETTINGS.life.quietTo, 'life.quietTo', warnings),
    proactiveWeekMin: readIntClamped(
      lifeSrc, 'proactiveWeekMin',
      useLegacyWeek ? 0 : DEFAULT_SETTINGS.life.proactiveWeekMin, 0, 63,
      'life.proactiveWeekMin', warnings,
    ),
    proactiveWeekMax: readIntClamped(
      lifeSrc, 'proactiveWeekMax',
      useLegacyWeek ? legacyWeek : DEFAULT_SETTINGS.life.proactiveWeekMax, 0, 63,
      'life.proactiveWeekMax', warnings,
    ),
    scheduleHour: readInt(lifeSrc, 'scheduleHour', DEFAULT_SETTINGS.life.scheduleHour, 0, 23, 'life.scheduleHour', warnings),
    diaryHour: readInt(lifeSrc, 'diaryHour', DEFAULT_SETTINGS.life.diaryHour, 0, 23, 'life.diaryHour', warnings),
    maxBackgroundCallsPerDay: readInt(
      lifeSrc, 'maxBackgroundCallsPerDay', DEFAULT_SETTINGS.life.maxBackgroundCallsPerDay, 0, 500,
      'life.maxBackgroundCallsPerDay', warnings,
    ),
    // P4：是否使用真实天气（Open-Meteo）；关闭则只用季节概率
    useWeather: readBool(lifeSrc, 'useWeather', DEFAULT_SETTINGS.life.useWeather, 'life.useWeather', warnings),
    // 日程生成后让模型自检一次（默认开；每天最多 1 次后台调用）
    scheduleReview: readBool(
      lifeSrc, 'scheduleReview', DEFAULT_SETTINGS.life.scheduleReview, 'life.scheduleReview', warnings,
    ),
    dailyDiscovery: readBool(
      lifeSrc, 'dailyDiscovery', DEFAULT_SETTINGS.life.dailyDiscovery, 'life.dailyDiscovery', warnings,
    ),
    silentEndPhrases: readStringList(
      lifeSrc, 'silentEndPhrases', DEFAULT_SETTINGS.life.silentEndPhrases, 'life.silentEndPhrases', warnings,
    ),
  };
  if (life.proactiveWeekMin > life.proactiveWeekMax) {
    warnings.push('life.proactiveWeekMin 不能大于 life.proactiveWeekMax，已按最大值处理');
    life.proactiveWeekMin = life.proactiveWeekMax;
  }

  const memory = {
    extractEveryTurns: readInt(
      memSrc, 'extractEveryTurns', DEFAULT_SETTINGS.memory.extractEveryTurns, 1, 50, 'memory.extractEveryTurns', warnings,
    ),
    extractIdleMinutes: readInt(
      memSrc, 'extractIdleMinutes', DEFAULT_SETTINGS.memory.extractIdleMinutes, 0, 1440,
      'memory.extractIdleMinutes', warnings,
    ),
    shortTermTurns: readInt(
      memSrc, 'shortTermTurns', DEFAULT_SETTINGS.memory.shortTermTurns, 1, 100, 'memory.shortTermTurns', warnings,
    ),
    recallTopK: readInt(memSrc, 'recallTopK', DEFAULT_SETTINGS.memory.recallTopK, 1, 50, 'memory.recallTopK', warnings),
    vectorEnabled: readBool(
      memSrc, 'vectorEnabled', DEFAULT_SETTINGS.memory.vectorEnabled, 'memory.vectorEnabled', warnings,
    ),
  };

  const voiceSrc = section(src, 'voice', warnings);
  const voice = {
    enabled: readBool(voiceSrc, 'enabled', DEFAULT_SETTINGS.voice.enabled, 'voice.enabled', warnings),
    engine: readEnum(
      voiceSrc, 'engine', DEFAULT_SETTINGS.voice.engine, ['auto', 'kokoro', 'piper', 'sapi'], 'voice.engine', warnings,
    ),
    kokoroVoice: readOptionalString(
      voiceSrc, 'kokoroVoice', DEFAULT_SETTINGS.voice.kokoroVoice, 'voice.kokoroVoice', warnings,
    ),
    sapiVoice: readOptionalString(voiceSrc, 'sapiVoice', DEFAULT_SETTINGS.voice.sapiVoice, 'voice.sapiVoice', warnings),
    rate: readNumber(voiceSrc, 'rate', DEFAULT_SETTINGS.voice.rate, 0.6, 1.6, 'voice.rate', warnings),
    volume: readNumber(voiceSrc, 'volume', DEFAULT_SETTINGS.voice.volume, 0, 1, 'voice.volume', warnings),
    inChat: readBool(voiceSrc, 'inChat', DEFAULT_SETTINGS.voice.inChat, 'voice.inChat', warnings),
    inBubble: readBool(voiceSrc, 'inBubble', DEFAULT_SETTINGS.voice.inBubble, 'voice.inBubble', warnings),
    modelPath: readOptionalString(
      voiceSrc, 'modelPath', DEFAULT_SETTINGS.voice.modelPath, 'voice.modelPath', warnings,
    ),
  };

  const activeCharacterIdRaw = src.activeCharacterId;
  let activeCharacterId = null;
  if (activeCharacterIdRaw !== undefined && activeCharacterIdRaw !== null) {
    if (typeof activeCharacterIdRaw === 'string' && activeCharacterIdRaw.trim() !== '') {
      activeCharacterId = activeCharacterIdRaw.trim();
    } else {
      warnings.push(`activeCharacterId 应为字符串或 null（收到 ${describe(activeCharacterIdRaw)}），已重置为 null`);
    }
  }

  let version = DEFAULT_SETTINGS.version;
  if (src.version !== undefined && src.version !== DEFAULT_SETTINGS.version) {
    warnings.push(`version 应为 ${DEFAULT_SETTINGS.version}（收到 ${describe(src.version)}），已按 ${DEFAULT_SETTINGS.version} 处理`);
  }

  const settings = {
    version,
    onboarded: readBool(src, 'onboarded', DEFAULT_SETTINGS.onboarded, 'onboarded', warnings),
    api,
    ui,
    life,
    memory,
    voice,
    activeCharacterId,
  };

  return { settings, warnings };
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 按 id 合并配置组：patch 里没带 apiKey 字段的保留磁盘上的旧 key，
 * apiKey === '' 才表示用户主动清除。避免「脱敏设置整包回传」时把密钥抹掉。
 */
function mergeKeyedProfiles(existingProfiles, patchProfiles) {
  const byId = new Map();
  for (const profile of Array.isArray(existingProfiles) ? existingProfiles : []) {
    if (isPlainObject(profile) && typeof profile.id === 'string') byId.set(profile.id, profile);
  }
  return patchProfiles.map((item) => {
    if (!isPlainObject(item)) return item;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const previous = byId.get(id);
    const next = { ...item };

    // apiKey：缺字段=不变，显式传空串=清除
    if (next.apiKey === undefined) {
      next.apiKey = previous && typeof previous.apiKey === 'string' ? previous.apiKey : '';
    }

    // headers / userAgent 是「高级配置」，设置页表单不展示。
    // 渲染层回传配置组时若没带这两个字段，必须沿用旧值，否则会被静默清空。
    if (next.headers === undefined) {
      next.headers = previous && isPlainObject(previous.headers) ? previous.headers : {};
    }
    if (next.userAgent === undefined) {
      next.userAgent = previous && typeof previous.userAgent === 'string' ? previous.userAgent : '';
    }
    return next;
  });
}

/**
 * 读取设置；文件缺失或损坏时回落默认值。
 * @param {string} dir 数据目录
 */
function loadSettings(dir) {
  // 读取与损坏恢复统一走 store（主文件 → .bak → *.corrupt-* + 默认值）
  const raw = store.readJSON(paths.settingsFile(dir), {});
  const { settings, warnings } = validateSettings(raw);
  for (const warning of warnings) {
    console.warn(`[config] ${warning}`);
  }
  return settings;
}

/**
 * 合并写入（深合并各分区，数组整体替换；api.profiles 按 id 保留未提供的 apiKey），
 * 写完返回校验后的完整设置。
 * @param {string} dir 数据目录
 * @param {object} patch 局部设置
 */
function saveSettings(dir, patch) {
  const current = loadSettings(dir);
  const safePatch = isPlainObject(patch) ? clone(patch) : {};
  if (isPlainObject(safePatch.api) && Array.isArray(safePatch.api.profiles)) {
    safePatch.api.profiles = mergeKeyedProfiles(current.api.profiles, safePatch.api.profiles);
  }
  const merged = deepMerge(current, safePatch);
  const { settings, warnings } = validateSettings(merged);
  for (const warning of warnings) {
    console.warn(`[config] ${warning}`);
  }
  store.writeJSON(paths.settingsFile(dir), settings);
  return settings;
}

/**
 * 脱敏副本：删除 apiKey，补 hasKey / keyHint（短 key 不暴露原文）。
 * @param {object} settings
 */
function publicSettings(settings) {
  const { settings: clean } = validateSettings(settings);
  const out = clone(clean);
  out.api.profiles = clean.api.profiles.map((profile) => {
    const key = typeof profile.apiKey === 'string' ? profile.apiKey.trim() : '';
    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      capabilities: clone(profile.capabilities),
      hasKey: key.length > 0,
      keyHint: key.length > 8 ? key.slice(-4) : (key.length > 0 ? '****' : ''),
    };
  });
  return out;
}

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  validateSettings,
  publicSettings,
};
