'use strict';

// IPC 通道表（单一入口）：createHandlers(deps) 是纯函数，便于用内存 deps 测试；
// register(ipcMain, handlers) 只负责把表挂到 ipcMain。
// 主进程独占状态与副作用：这里不 require electron，窗口操作一律经 deps.windows。
// 只用 Node 标准库；CommonJS。

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const config = require('./config');
const store = require('./store');
const prompt = require('./prompt');
const persona = require('./persona');
const memory = require('./memory');
const usage = require('./usage');
const life = require('./life');
const stateModule = require('./state');
const calendar = require('./calendar');
const paths = require('./paths');
const geometry = require('./geometry');
const assets = require('./assets');
const notifications = require('./notifications');
const i18n = require('./i18n');

// 通道清单（必须与 preload 白名单、计划 Task 9 完全一致）
const CHANNELS = [
  'settings:get',
  'settings:save',
  'settings:setKey',
  'settings:testProfile',
  'settings:setAutostart',

  'characters:list',
  'characters:create',
  'characters:save',
  'characters:delete',
  'characters:setActive',
  'characters:importFrame',
  'characters:frames',
  'characters:generateInner',
  'characters:saveInner',

  'chat:send',
  'chat:stop',
  'chat:history',
  'chat:clear',
  'chat:markRead',

  'memory:list',
  'memory:add',
  'memory:update',
  'memory:delete',

  'timeline:get',
  'timeline:deleteDiary',
  'state:get',

  'usage:today',

  'pet:getState',
  'pet:cursorInside',
  'pet:move',
  'pet:scale',
  'pet:setIgnore',
  'pet:bubbleDismissed',
  'tts:speak',
  'tts:stop',
  'tts:status',
  'window:open',
  'tray:unread',
  'tray:popupHover',

  'data:openDataDir',
  'data:export',
  'dialog:pickImage',

  'app:quit',
];

// 主进程 → 渲染进程的广播事件（preload 只放行这些）
const EVENTS = [
  'chat:delta', 'chat:done', 'chat:replace', 'chat:error', 'chat:select', 'chat:refresh',
  'pet:bubble', 'state:changed', 'tray:update', 'tts:halt',
];

const FRAME_KEYS = ['idle', 'happy', 'sad', 'think', 'angry', 'sleepy'];
const WINDOW_TARGETS = new Set(['pet', 'chat', 'settings']);

const EXTRACT_BACKOFF_MS = 10 * 60 * 1000;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad2(value) {
  return String(value).padStart(2, '0');
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

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** YYYY-MM-DD，且必须是真实存在的日期（排除 2026-02-31 这类） */
function isDayKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function messageId(prefix = 'msg') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 导出文件夹后缀：本地时间 yyyymmdd-HHMM（不要用 toISOString，会按 UTC 跨天） */
function exportStamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}`
  );
}

/** 递归复制目录（只用 Node 标准库；目标目录不存在时自动创建） */
function copyTree(fsMod, source, target) {
  fsMod.mkdirSync(target, { recursive: true });
  for (const entry of fsMod.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(fsMod, from, to);
    else if (entry.isFile()) fsMod.copyFileSync(from, to);
  }
  return target;
}

/** 真实路径；目标还不存在（或解析失败）时退回 resolve，保证比较始终有值 */
function realOrResolve(value) {
  const abs = path.resolve(String(value));
  try {
    return fs.realpathSync.native(abs);
  } catch (error) {
    return abs;
  }
}

/** 路径比较前统一：Windows 磁盘不区分大小写，必须 toLowerCase 后再比 */
function comparablePath(value) {
  const real = realOrResolve(value);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** child 是否等于 parent 或位于 parent 里面（入参必须已经 comparablePath） */
function isSameOrInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** 脱敏副本：保留 settings 的全部字段，只把每个配置组的 apiKey 置空 */
function sanitizeSettingsData(value) {
  if (!isPlainObject(value)) return null;
  const clean = JSON.parse(JSON.stringify(value));
  const api = isPlainObject(clean.api) ? clean.api : null;
  if (api && Array.isArray(api.profiles)) {
    api.profiles = api.profiles.map((profile) => (
      isPlainObject(profile) ? { ...profile, apiKey: '' } : profile
    ));
  }
  return clean;
}

/**
 * 把导出目录里的 settings.json / settings.json.bak 换成脱敏版（原始 data/ 不动）。
 * 解析不了的 settings 直接删掉：宁可不带，也不能把可能含 Key 的原文导出去。
 */
function sanitizeExportedSettings(fsMod, dest) {
  for (const name of ['settings.json', 'settings.json.bak']) {
    const file = path.join(dest, name);
    let text;
    try {
      if (!fsMod.existsSync(file)) continue;
      text = fsMod.readFileSync(file, 'utf8');
    } catch (error) {
      continue;
    }
    if (typeof text === 'string' && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let clean = null;
    try {
      clean = sanitizeSettingsData(JSON.parse(text));
    } catch (error) {
      clean = null;
    }
    if (!clean) {
      try {
        fsMod.rmSync(file, { force: true });
      } catch (error) {
        /* 删不掉就忽略，不会把内容写回去 */
      }
      continue;
    }
    fsMod.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  }
}

function requireText(value, label = '内容') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

/** 模型输出 → { traits, boundaries }；解析不出可用结构返回 null */
function parseInnerPayload(raw) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let value;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return null;
  }
  if (!isPlainObject(value)) return null;

  const traits = persona.sanitizeInner({ traits: value.traits }).traits;
  if (traits.length < 5) return null;
  const boundaries = persona.sanitizeInner({ boundaries: value.boundaries }).boundaries;
  return { traits: traits.slice(0, 8), boundaries };
}

/** 有 baseUrl 与 model 才值得调模型（和 life.js 的判断保持一致） */
function usableProfile(profile) {
  return isPlainObject(profile)
    && typeof profile.baseUrl === 'string'
    && /^https?:\/\//i.test(profile.baseUrl.trim())
    && typeof profile.model === 'string'
    && profile.model.trim() !== '';
}

function payloadOf(payload) {
  return isPlainObject(payload) ? payload : {};
}

function throwUnknownChannel(channel) {
  throw new Error(`unknown channel: ${channel}`);
}

/**
 * 判断 IPC 来源是否属于本应用渲染目录（只认 file:// 且真实路径在 src/renderer/ 下）。
 * 导出便于测试；register 里对每个 invoke 都做校验。
 */
function isAppRendererUrl(rawUrl, rendererDir = RENDERER_DIR) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('file:')) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return false;
  parsed.search = '';
  parsed.hash = '';
  let target;
  try {
    target = path.resolve(fileURLToPath(parsed));
  } catch {
    return false;
  }
  const root = path.resolve(rendererDir);
  return target === root || target.startsWith(root + path.sep);
}

function assertSender(event, rendererDir = RENDERER_DIR) {
  const frame = event && event.senderFrame;
  if (!frame || typeof frame.url !== 'string' || !isAppRendererUrl(frame.url, rendererDir)) {
    throw new Error('IPC 来源不在应用渲染目录，已拒绝');
  }
}

/**
 * 统一分发：未知通道直接抛 unknown channel（renderer 侧也有一份白名单，双保险）。
 * @param {Record<string, Function>} handlers
 * @param {string} channel
 * @param {unknown} event
 * @param {unknown} payload
 */
function dispatch(handlers, channel, event, payload) {
  const handler = handlers && Object.prototype.hasOwnProperty.call(handlers, channel)
    ? handlers[channel]
    : null;
  if (typeof handler !== 'function') return throwUnknownChannel(channel);
  return handler(event, payload);
}

/**
 * 把通道表挂到 ipcMain。缺一个通道直接抛错，避免运行到一半才发现漏实现。
 * 每个 invoke 都先校验 senderFrame.url 在应用渲染目录内（拒绝外部页面调用）。
 * @param {{ handle: (channel: string, listener: Function) => void }} ipcMain
 * @param {Record<string, Function>} handlers
 * @param {{ rendererDir?: string }} [options]
 */
function register(ipcMain, handlers, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('register 需要 ipcMain（含 handle 方法）');
  }
  const table = handlers || {};
  const rendererDir = options && options.rendererDir ? options.rendererDir : RENDERER_DIR;
  for (const channel of CHANNELS) {
    if (typeof table[channel] !== 'function') {
      throw new Error(`缺少 IPC 通道实现：${channel}`);
    }
  }
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, (event, payload) => {
      assertSender(event, rendererDir);
      const translateError = (error) => {
        // 错误文案会原样显示在界面上，按当前语言翻译一次（未收录的保持原文）
        if (error instanceof Error && typeof error.message === 'string') {
          const translated = i18n.t(error.message);
          if (translated !== error.message) error.message = translated;
        }
        return error;
      };
      try {
        const result = dispatch(table, channel, event, payload);
        if (result && typeof result.then === 'function') {
          return result.catch((error) => { throw translateError(error); });
        }
        return result;
      } catch (error) {
        throw translateError(error);
      }
    });
  }
  return table;
}

/**
 * 后台记忆抽取器：聊天按轮次或空闲时调用，不阻塞调用方。
 * - 先过后台预算闸门（Spec 8.5）：当日 background 次数不足直接跳过；
 * - 失败退避：写 lastExtractAttemptAt，10 分钟内不再试；
 * - 成功后按「最新读到的」记忆合并再整包写回（带 suppressed），并推进游标；
 * - 每次成功调模型都记一次 background 用量。
 *
 * @param {{ dir: string, config?: object, store?: object, memory?: object, usage?: object,
 *           now?: () => Date, backoffMs?: number,
 *           onBackgroundTask?: (promise: Promise<any>) => void }} options
 * @returns {(characterId: string, options?: { limit?: number, signal?: AbortSignal }) => Promise<void>}
 */
function createExtractor(options = {}) {
  const dir = options.dir;
  if (typeof dir !== 'string' || dir === '') throw new Error('createExtractor 需要数据目录 dir');

  const cfg = options.config || config;
  const st = options.store || store;
  const mem = options.memory || memory;
  const usageMod = options.usage || usage;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const track = typeof options.onBackgroundTask === 'function' ? options.onBackgroundTask : null;
  const backoffMs = Number.isFinite(options.backoffMs) && options.backoffMs >= 0
    ? options.backoffMs
    : EXTRACT_BACKOFF_MS;

  function profileFor(settings) {
    const list = settings && settings.api && Array.isArray(settings.api.profiles)
      ? settings.api.profiles
      : [];
    return list.find((profile) => profile && profile.id === settings.api.background)
      || list.find((profile) => profile && profile.id === settings.api.chat)
      || list[0]
      || null;
  }

  /** 读取失败按「还够用」处理：记账问题不该把记忆功能也挡死 */
  function budgetLeft(settings, at) {
    try {
      return usageMod.canRunBackground(settings, usageMod.today(dir, at));
    } catch (error) {
      console.warn(`[ipc] 读取后台用量失败，按可用处理：${error && error.message ? error.message : error}`);
      return true;
    }
  }

  return function extractMemory(characterId, extractOptions = {}) {
    const task = (async () => {
      if (typeof characterId !== 'string' || characterId === '') return;
      const settings = cfg.loadSettings(dir);
      const characters = st.listCharacters(dir);
      const character = characters.find((item) => item && item.id === characterId) || null;
      if (!character) return;
      const profile = profileFor(settings);
      if (!profile) return;

      const at = now();

      // Spec 8.5：后台预算不足静默跳过（设置页能看到用量，不打扰用户）
      if (!budgetLeft(settings, at)) return;

      const before = st.readMemory(dir, characterId);
      const lastAttemptMs = Date.parse(before.lastExtractAttemptAt);
      if (
        Number.isFinite(lastAttemptMs)
        && at.getTime() - lastAttemptMs >= 0
        && at.getTime() - lastAttemptMs < backoffMs
      ) {
        return;
      }

      const history = st.readMessages(dir, characterId, {
        limit: Number.isInteger(extractOptions.limit) && extractOptions.limit > 0
          ? extractOptions.limit
          : 24,
      });
      if (history.length === 0) return;

      let failure = null;
      let cards;
      try {
        cards = await mem.extractFromChat({
          character,
          messages: history,
          existing: { cards: before.cards, suppressed: before.suppressed || [] },
          profile,
          signal: extractOptions.signal,
          onUsage: (usageData) => {
            try {
              usageMod.record(dir, 'background', usageData || {}, at);
            } catch (error) {
              console.warn(`[ipc] 后台用量记账失败：${error && error.message ? error.message : error}`);
            }
          },
          onFailure: (error) => {
            failure = error || new Error('记忆抽取失败');
          },
        });
      } catch (error) {
        failure = error || new Error('记忆抽取失败');
        cards = [];
      }

      const last = history[history.length - 1];
      const lastId = last && typeof last.id === 'string' ? last.id : before.lastExtractedMessageId;
      const stamp = at.toISOString();

      if (!Array.isArray(cards) || cards.length === 0) {
        const untouched = st.readMemory(dir, characterId);
        if (failure) {
          // 失败退避：写尝试时间，不推进游标，过一阵再试
          st.writeMemory(dir, characterId, {
            ...untouched,
            suppressed: Array.isArray(untouched.suppressed) ? untouched.suppressed : [],
            lastExtractAttemptAt: stamp,
          });
          console.warn(`[ipc] 记忆抽取失败（${failure.message || failure}），${Math.round(backoffMs / 60000)} 分钟内不再尝试`);
        } else {
          // 正常「没有可记的」：推进游标 + 记下抽取时间，避免空闲触发每分钟重试
          st.writeMemory(dir, characterId, {
            ...untouched,
            suppressed: Array.isArray(untouched.suppressed) ? untouched.suppressed : [],
            lastExtractedMessageId: lastId,
            lastExtractedAt: stamp,
            lastExtractAttemptAt: null,
          });
        }
        return;
      }

      const latest = st.readMemory(dir, characterId);
      const merged = mem.mergeCards(
        { cards: latest.cards, suppressed: latest.suppressed || [] },
        cards,
      );
      st.writeMemory(dir, characterId, {
        ...latest,
        cards: merged,
        suppressed: mem.suppressedOf(merged),
        lastExtractedMessageId: lastId,
        lastExtractedAt: stamp,
        lastExtractAttemptAt: null,
      });
    })().catch((error) => {
      console.warn(`[ipc] 记忆抽取失败：${error && error.message ? error.message : error}`);
    });

    if (track) {
      try {
        track(task);
      } catch {
        /* 测试钩子自身出错不影响主流程 */
      }
    }
    return task;
  };
}

/**
 * 装配全部通道处理器。
 *
 * @param {{
 *   dir: string,
 *   emit?: (event: string, payload: any) => void,
 *   windows?: { open?: (target: string) => any, get?: () => object },
 *   workArea?: () => ({ x: number, y: number, width: number, height: number } | null),
 *   openPath?: (target: string) => any,
 *   pickDirectory?: () => (string | null | Promise<string | null>),
 *   pickImage?: () => (string | { path?: string, filePath?: string } | null | Promise<any>),
 *   setAutostart?: (enabled: boolean) => void,
 *   isPackaged?: boolean | (() => boolean),
 *   now?: () => Date,
 *   onBackgroundTask?: (promise: Promise<any>) => void,
 *   config?: object, store?: object, prompt?: object, memory?: object,
 *   usage?: object, life?: object, llm?: object, fs?: object,
 * }} deps
 * @returns {Record<string, (event: unknown, payload: unknown) => any>}
 */
function createHandlers(deps = {}) {
  const dir = deps.dir;
  if (typeof dir !== 'string' || dir === '') {
    throw new Error('createHandlers 需要数据目录 dir');
  }

  const api = {
    config: deps.config || config,
    store: deps.store || store,
    prompt: deps.prompt || prompt,
    memory: deps.memory || memory,
    usage: deps.usage || usage,
    life: deps.life || life,
    state: deps.state || stateModule,
    llm: deps.llm || require('./llm'),
    assets: deps.assets || assets,
    notifications: deps.notifications || notifications,
    tts: deps.tts || require('./tts'),
    fs: deps.fs || fs,
    quit: typeof deps.quit === 'function' ? deps.quit : null,
    cursor: typeof deps.cursor === 'function' ? deps.cursor : null,
    bubbleWidth: typeof deps.bubbleWidth === 'function' ? deps.bubbleWidth : null,
  };
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {};

  // 当前流式会话（同一时间只保留一条；新的 chat:send 会中止旧的）
  let activeChat = null;
  let bubble = null;

  function emitEvent(event, payload) {
    try {
      emit(event, payload);
    } catch (error) {
      console.warn(`[ipc] 广播 ${event} 失败：${error && error.message ? error.message : error}`);
    }
  }

  function loadSettings() {
    return api.config.loadSettings(dir);
  }

  function publicSettings(settings) {
    // 附加数据目录（设置页「数据」Tab 要显示并打开它；不写进 settings.json）
    return { ...api.config.publicSettings(settings || loadSettings()), dataDir: dir };
  }

  function findProfile(settings, id) {
    const list = settings && settings.api && Array.isArray(settings.api.profiles)
      ? settings.api.profiles
      : [];
    return list.find((profile) => profile && profile.id === id) || null;
  }

  function chatProfile(settings) {
    return findProfile(settings, settings.api.chat) || (settings.api.profiles || [])[0] || null;
  }

  function backgroundProfile(settings) {
    return findProfile(settings, settings.api.background) || chatProfile(settings);
  }

  function listCharacters() {
    return api.store.listCharacters(dir);
  }

  function findCharacter(id) {
    if (typeof id !== 'string' || id === '') return null;
    return listCharacters().find((character) => character && character.id === id) || null;
  }

  function activeCharacter(settings) {
    const characters = listCharacters();
    if (characters.length === 0) return null;
    return characters.find((character) => character && character.id === settings.activeCharacterId)
      || characters[0];
  }

  function resolveCharacter(payload, settings) {
    const wanted = payloadOf(payload).characterId || payloadOf(payload).id;
    const character = findCharacter(wanted) || activeCharacter(settings || loadSettings());
    if (!character) throw new Error('还没有角色，先新建一个吧');
    return character;
  }

  function updateActiveIfMissing(settings, characterId) {
    if (typeof settings.activeCharacterId === 'string' && findCharacter(settings.activeCharacterId)) {
      return settings.activeCharacterId;
    }
    api.config.saveSettings(dir, { activeCharacterId: characterId });
    return characterId;
  }

  function getWindows() {
    if (deps.windows && typeof deps.windows.get === 'function') {
      return deps.windows.get() || {};
    }
    return {};
  }

  function windowOpen(target, kind, characterId = null) {
    if (deps.windows && typeof deps.windows.open === 'function') {
      deps.windows.open(target, characterId ? { characterId } : undefined);
      return;
    }
    const win = getWindows()[target];
    if (win && !win.isDestroyed?.()) {
      if (kind === 'show') win.show();
      if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
      win.focus?.();
      if (target === 'chat' && characterId) {
        try {
          win.webContents?.send('chat:select', { characterId });
        } catch (error) {
          console.warn(`[ipc] 切换聊天角色失败：${error && error.message ? error.message : error}`);
        }
      }
    }
  }

  // ---------- 记忆写盘（始终带上 suppressed） ----------

  function writeMemoryObject(characterId, mem) {
    return api.store.writeMemory(dir, characterId, {
      ...mem,
      cards: Array.isArray(mem.cards) ? mem.cards : [],
      suppressed: api.memory.suppressedOf(mem),
    });
  }

  // 后台记忆抽取（不阻塞聊天/调度）
  const extractMemory = createExtractor({
    dir,
    config: api.config,
    store: api.store,
    memory: api.memory,
    usage: api.usage,
    now,
    onBackgroundTask: deps.onBackgroundTask,
  });

  /** 上次抽取游标之后累计的用户消息数（用于 extractEveryTurns 触发） */
  function userTurnsSince(characterId, lastExtractedMessageId) {
    const messages = api.store.readMessages(dir, characterId, { limit: 400 });
    let start = -1;
    if (typeof lastExtractedMessageId === 'string' && lastExtractedMessageId) {
      start = messages.findIndex((item) => item && item.id === lastExtractedMessageId);
    }
    let turns = 0;
    for (let index = start + 1; index < messages.length; index += 1) {
      if (messages[index] && messages[index].role === 'user') turns += 1;
    }
    return turns;
  }

  // ---------- settings ----------

  function settingsGet() {
    return publicSettings(loadSettings());
  }

  /** 开机自启：真实副作用由主进程注入（ipc.js 不 require electron，测试里可断言调用） */
  function autostartWarning() {
    const packaged = typeof deps.isPackaged === 'function' ? deps.isPackaged() : deps.isPackaged;
    if (packaged === false) return '开发态无法真正开机自启，打包安装后才会生效';
    return null;
  }

  function applyAutostart(enabled) {
    if (typeof deps.setAutostart === 'function') {
      try {
        deps.setAutostart(Boolean(enabled));
      } catch (error) {
        console.warn(`[ipc] 设置开机自启失败：${error && error.message ? error.message : error}`);
        return `系统登录项设置失败：${error && error.message ? error.message : error}`;
      }
    }
    return autostartWarning();
  }

  function settingsSave(_event, payload) {
    const patch = payloadOf(payload);
    if (isPlainObject(patch.settings)) return settingsSave(_event, patch.settings);
    const before = loadSettings();
    const saved = api.config.saveSettings(dir, patch);
    i18n.setLanguage(saved.ui.language);
    const languageChanged = before.ui.language !== saved.ui.language;
    const windows = getWindows();
    if (windows.pet && typeof windows.pet.setAlwaysOnTop === 'function') {
      windows.pet.setAlwaysOnTop(saved.ui.alwaysOnTop, 'screen-saver');
    }
    // 鼠标穿透开关立即生效（true = 整窗穿透，指针事件由渲染层按立绘区域临时开关）
    if (windows.pet && typeof windows.pet.setIgnoreMouseEvents === 'function' && !windows.pet.isDestroyed?.()) {
      try {
        windows.pet.setIgnoreMouseEvents(saved.ui.clickThrough !== false, { forward: true });
      } catch (error) {
        console.warn(`[ipc] 应用鼠标穿透失败：${error && error.message ? error.message : error}`);
      }
    }
    if (isPlainObject(patch.ui) && Object.prototype.hasOwnProperty.call(patch.ui, 'autostart')) {
      applyAutostart(saved.ui.autostart);
    }
    if (languageChanged && typeof deps.onLanguageChanged === 'function') {
      try {
        deps.onLanguageChanged(saved.ui.language);
      } catch (error) {
        console.warn(`[ipc] 切换语言失败：${error && error.message ? error.message : error}`);
      }
    }
    emitEvent('state:changed', { reason: 'settings' });
    return publicSettings(saved);
  }

  function settingsSetAutostart(_event, payload) {
    const input = payloadOf(payload);
    const enabled = typeof payload === 'boolean' ? payload : input.enabled;
    if (typeof enabled !== 'boolean') throw new Error('开机自启需要 true/false');
    const saved = api.config.saveSettings(dir, { ui: { autostart: enabled } });
    const warning = applyAutostart(saved.ui.autostart);
    emitEvent('state:changed', { reason: 'settings' });
    return { ok: true, warning, settings: publicSettings(saved) };
  }

  function settingsSetKey(_event, payload) {
    const input = payloadOf(payload);
    const profileId = requireText(input.profileId || input.id, '配置组 id');
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const settings = loadSettings();
    const profiles = settings.api.profiles.map((profile) => (
      profile.id === profileId ? { ...profile, apiKey } : profile
    ));
    if (!profiles.some((profile) => profile.id === profileId)) {
      throw new Error('找不到这个配置组');
    }
    const saved = api.config.saveSettings(dir, { api: { profiles } });
    emitEvent('state:changed', { reason: 'settings' });
    return publicSettings(saved);
  }

  async function settingsTestProfile(_event, payload) {
    const input = payloadOf(payload);
    const settings = loadSettings();
    const profile = isPlainObject(input.profile)
      ? input.profile
      : findProfile(settings, input.profileId || input.id || settings.api.chat);
    if (!profile) throw new Error('找不到这个配置组');
    return api.llm.testProfile(profile);
  }

  // ---------- characters ----------

  function charactersList() {
    return listCharacters();
  }

  function charactersCreate(_event, payload) {
    const character = api.store.createCharacter(dir, payloadOf(payload));
    const settings = loadSettings();
    updateActiveIfMissing(settings, character.id);
    emitEvent('state:changed', { reason: 'characters', characterId: character.id });
    return character;
  }

  function charactersSave(_event, payload) {
    if (!isPlainObject(payload) || typeof payload.id !== 'string') {
      throw new Error('characters:save 需要完整角色对象（含 id）');
    }
    const saved = api.store.saveCharacter(dir, payload);
    emitEvent('state:changed', { reason: 'characters', characterId: saved.id });
    return saved;
  }

  function charactersDelete(_event, payload) {
    const input = payloadOf(payload);
    const id = requireText(typeof payload === 'string' ? payload : input.id || input.characterId, '角色 id');
    api.store.deleteCharacter(dir, id);

    const settings = loadSettings();
    let activeCharacterId = settings.activeCharacterId;
    if (activeCharacterId === id || !findCharacter(activeCharacterId)) {
      const rest = listCharacters();
      activeCharacterId = rest.length > 0 ? rest[0].id : null;
      api.config.saveSettings(dir, { activeCharacterId });
    }
    emitEvent('state:changed', { reason: 'characters', characterId: activeCharacterId });
    return { deleted: id, activeCharacterId };
  }

  function charactersSetActive(_event, payload) {
    const input = payloadOf(payload);
    const id = requireText(typeof payload === 'string' ? payload : input.id || input.characterId, '角色 id');
    if (!findCharacter(id)) throw new Error('找不到这个角色');
    const saved = api.config.saveSettings(dir, { activeCharacterId: id });
    emitEvent('state:changed', { reason: 'characters', characterId: id });
    return publicSettings(saved);
  }

  /**
   * 导入一张立绘（Task 13）。
   * 校验交给 assets.importFrame（PNG 签名 + IHDR + alpha），失败一律返回 { ok:false, error }，
   * 不抛给渲染层——设置页要能在界面上直接显示中文原因；校验失败时不写任何文件。
   */
  function charactersImportFrame(_event, payload) {
    const input = payloadOf(payload);
    let characterId = '';
    try {
      characterId = requireText(input.characterId || input.id, '角色 id');
      const character = findCharacter(characterId);
      if (!character) throw new Error('找不到这个角色');

      const packId = typeof input.packId === 'string' && input.packId ? input.packId : 'default';
      const frameKey = typeof input.frameKey === 'string' && input.frameKey ? input.frameKey : 'idle';

      const imported = api.assets.importFrame({
        dir,
        characterId,
        packId,
        frameKey,
        sourceBuffer: input.sourceBuffer,
        sourcePath: input.sourcePath || input.path,
      });

      const appearance = isPlainObject(character.appearance) ? character.appearance : {};
      const packs = Array.isArray(appearance.packs) ? appearance.packs.slice() : [];
      const packIndex = packs.findIndex((item) => item && item.id === packId);
      let pack;
      if (packIndex < 0) {
        pack = { id: packId, name: packId, frames: {} };
        packs.push(pack);
      } else {
        const existing = packs[packIndex];
        pack = {
          ...existing,
          frames: { ...(isPlainObject(existing.frames) ? existing.frames : {}) },
        };
        packs[packIndex] = pack;
      }
      pack.frames[frameKey] = imported.relPath;

      const saved = api.store.saveCharacter(dir, {
        ...character,
        appearance: {
          ...appearance,
          activePack: appearance.activePack || packId,
          packs,
        },
      });
      emitEvent('state:changed', { reason: 'characters', characterId });

      return {
        ok: true,
        relPath: imported.relPath,
        width: imported.width,
        height: imported.height,
        character: saved,
      };
    } catch (error) {
      return {
        ok: false,
        error: error && error.message ? error.message : '导入失败',
        characterId: characterId || null,
      };
    }
  }

  /**
   * 角色全部形象包的帧位 → 绝对 file:// URL。
   * 只认角色目录内的文件：越界路径、不存在的帧一律跳过（设置页缩略图与小人窗共用）。
   */
  function frameUrlOf(characterId, rel) {
    if (typeof rel !== 'string' || rel === '') return null;
    let base;
    try {
      base = path.resolve(paths.charDir(dir, characterId));
    } catch (error) {
      return null;
    }
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) return null;
    let stat = null;
    try {
      if (!api.fs.existsSync(abs)) return null;
      stat = fs.statSync(abs);
    } catch (error) {
      return null;
    }
    // 带上文件修改时间做缓存戳：换了帧位图片后，小人窗不需要重启也能拿到新图
    const version = stat && Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : Date.now();
    return `${pathToFileURL(abs).href}?v=${version}`;
  }

  function charactersFrames(_event, payload) {
    const input = payloadOf(payload);
    const settings = loadSettings();
    const character = findCharacter(input.characterId || input.id) || activeCharacter(settings);
    if (!character) return {};
    const appearance = isPlainObject(character.appearance) ? character.appearance : {};
    const packs = Array.isArray(appearance.packs) ? appearance.packs : [];
    const result = {};
    for (const pack of packs) {
      if (!pack || typeof pack.id !== 'string') continue;
      const frames = isPlainObject(pack.frames) ? pack.frames : {};
      const urls = {};
      for (const key of FRAME_KEYS) {
        const url = frameUrlOf(character.id, frames[key]);
        if (url) urls[key] = url;
      }
      result[pack.id] = urls;
    }
    return result;
  }

  // ---------- 内在设定（P1：生日 + 五维 + traits/boundaries） ----------

  function backgroundBudgetLeft(settings, at) {
    try {
      return api.usage.canRunBackground(settings, api.usage.today(dir, at));
    } catch (error) {
      console.warn(`[ipc] 读取后台用量失败，按可用处理：${error && error.message ? error.message : error}`);
      return true;
    }
  }

  function saveInnerToCharacter(character, inner) {
    const personaSrc = isPlainObject(character.persona) ? character.persona : {};
    return api.store.saveCharacter(dir, {
      ...character,
      persona: { ...personaSrc, birthday: personaSrc.birthday, inner },
    });
  }

  /**
   * 根据生日生成内在设定（一次性）。
   * - 没填生日 → 报错「先填生日」；
   * - 预算不足 / 未配置模型 / 模型输出不可解析 → autoTraits 兜底，不报错；
   * - 成功写回 persona.inner（保留已有 profile），persona.birthday 不动。
   * @returns {Promise<{ ok: boolean, inner: object, source: 'auto'|'model', character: object }>}
   */
  async function charactersGenerateInner(_event, payload) {
    const settings = loadSettings();
    const character = resolveCharacter(payload, settings);
    const personaSrc = isPlainObject(character.persona) ? character.persona : {};
    const birthday = personaSrc.birthday;
    if (!persona.birthdayValid(birthday)) throw new Error('先填生日');

    const at = now();
    const existingRaw = isPlainObject(personaSrc.inner) ? personaSrc.inner : {};
    const existing = persona.sanitizeInner(existingRaw);
    const zodiac = persona.zodiacOf(birthday.month, birthday.day) || existing.zodiac;

    // 用户改过的五维不覆盖：只要已有合法的 profile 就沿用
    const hasStoredProfile = isPlainObject(existingRaw.profile)
      && persona.PROFILE_KEYS.some((key) => typeof existingRaw.profile[key] === 'number');
    const profile = hasStoredProfile
      ? existing.profile
      : persona.autoProfile({ birthday, life: character.life });

    let traits = persona.autoTraits({ zodiac, profile, life: character.life });
    let boundaries = existing.boundaries.length > 0
      ? existing.boundaries
      : persona.DEFAULT_INNER_BOUNDARIES.slice();
    let source = 'auto';

    const profileConfig = backgroundProfile(settings);
    if (backgroundBudgetLeft(settings, at) && usableProfile(profileConfig)) {
      try {
        const response = await api.llm.chat({
          profile: profileConfig,
          messages: api.prompt.buildInnerMessages({
            character,
            zodiac,
            profile,
            traits,
          }),
          retry: 0,
          // 推理型模型会先花掉一部分 token 在 thinking 上，给足余量
          maxTokens: 2000,
        });
        try {
          api.usage.record(dir, 'background', (response && response.usage) || {}, at);
        } catch (error) {
          console.warn(`[ipc] 内在设定用量记账失败：${error && error.message ? error.message : error}`);
        }
        const parsed = parseInnerPayload(response && response.text);
        if (parsed) {
          traits = parsed.traits;
          if (parsed.boundaries.length > 0) boundaries = parsed.boundaries;
          source = 'model';
        }
      } catch (error) {
        console.warn(`[ipc] 生成内在设定失败，使用内置规则：${error && error.message ? error.message : error}`);
      }
    }

    const inner = persona.sanitizeInner({
      zodiac,
      profile,
      traits,
      boundaries,
      generatedAt: localISOString(at),
      source,
    });
    const saved = saveInnerToCharacter(character, inner);
    emitEvent('state:changed', { reason: 'characters', characterId: saved.id });
    return { ok: true, inner, source, character: saved };
  }

  /**
   * 保存用户手改的 traits / boundaries / profile（source 标记为 manual）。
   * birthday 不动：生日走 characters:save。
   */
  function charactersSaveInner(_event, payload) {
    const input = payloadOf(payload);
    const settings = loadSettings();
    const character = resolveCharacter(input, settings);
    const personaSrc = isPlainObject(character.persona) ? character.persona : {};
    const existing = persona.sanitizeInner(personaSrc.inner);
    const raw = isPlainObject(input.inner) ? input.inner : input;

    const inner = persona.sanitizeInner({
      zodiac: raw.zodiac !== undefined ? raw.zodiac : existing.zodiac,
      profile: raw.profile !== undefined ? raw.profile : existing.profile,
      traits: raw.traits !== undefined ? raw.traits : existing.traits,
      boundaries: raw.boundaries !== undefined ? raw.boundaries : existing.boundaries,
      generatedAt: raw.generatedAt !== undefined ? raw.generatedAt : existing.generatedAt,
      source: 'manual',
    });
    const saved = saveInnerToCharacter(character, inner);
    emitEvent('state:changed', { reason: 'characters', characterId: saved.id });
    return { ok: true, inner, character: saved };
  }

  // ---------- chat ----------
  function buildUserMessage(text) {
    return {
      id: messageId(),
      role: 'user',
      text,
      ts: localISOString(now()),
      unread: false,
      proactive: false,
    };
  }

  function buildAssistantMessage(text, extra = {}) {
    return {
      id: messageId(),
      role: 'assistant',
      text,
      ts: localISOString(now()),
      unread: false,
      proactive: false,
      ...extra,
    };
  }

  async function chatSend(_event, payload) {
    const input = payloadOf(payload);
    const text = requireText(typeof payload === 'string' ? payload : input.text, '消息');

    const settings = loadSettings();
    const character = resolveCharacter(input, settings);
    const nowDate = now();
    const date = dayKey(nowDate);

    // 上一条还没结束：先中止，避免两条流同时往同一个会话里写
    if (activeChat && activeChat.controller) {
      activeChat.stopped = true;
      activeChat.controller.abort();
    }

    const history = api.store.readMessages(dir, character.id, {
      limit: Math.max(1, settings.memory.shortTermTurns) * 2,
    });
    const userMessage = buildUserMessage(text);
    api.store.appendMessage(dir, character.id, userMessage);

    // 对方说了设置里的「结束语」= 对话收尾：只存用户消息，不再回复
    const silentPhrases = Array.isArray(settings.life && settings.life.silentEndPhrases)
      ? settings.life.silentEndPhrases
      : [];
    const normalizedText = text.replace(/[。.!！]+$/, '').trim();
    if (silentPhrases.some((phrase) => typeof phrase === 'string' && phrase.trim() === normalizedText)) {
      emitEvent('chat:done', {
        characterId: character.id,
        message: null,
        usage: null,
        stopped: false,
      });
      return { ok: true, stopped: false, silent: true, message: null, usage: null };
    }

    const memoryData = api.store.readMemory(dir, character.id);
    const memories = api.memory.retrieve(memoryData.cards, text, {
      topK: settings.memory.recallTopK,
      now: nowDate,
    });
    const timeline = api.store.readTimeline(dir, character.id);
    const today = timeline.days && timeline.days[date] ? timeline.days[date] : null;
    const currentState = api.state.settleDay(api.state.readState(dir, character.id, nowDate), nowDate);

    const messages = api.prompt.buildChatMessages({
      character,
      memories,
      today,
      history,
      userText: text,
      now: nowDate,
      topK: settings.memory.recallTopK,
      shortTermTurns: settings.memory.shortTermTurns,
      state: currentState,
    });

    const controller = new AbortController();
    const session = {
      controller,
      stopped: false,
      characterId: character.id,
      messageId: messageId('stream'),
    };
    activeChat = session;

    const profile = chatProfile(settings);
    let acc = '';

    try {
      const result = await api.llm.chat({
        profile,
        messages,
        signal: controller.signal,
        onDelta: (delta) => {
          if (session.stopped) return;
          if (typeof delta !== 'string' || delta === '') return;
          acc += delta;
          emitEvent('chat:delta', {
            characterId: character.id,
            messageId: session.messageId || null,
            text: delta,
          });
        },
      });

      let fullText = result && typeof result.text === 'string' && result.text ? result.text : acc;

      // 地点连续性守门：回复凭空换地方（比如刚说在窗边，转头说「刚回来」）→ 重写一次
      try {
        const previousAssistant = (() => {
          const list = Array.isArray(history) ? history : [];
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const item = list[i];
            if (!item || item.role !== 'assistant') continue;
            const value = typeof item.text === 'string' ? item.text : item.content;
            if (value) return { text: value, ts: item.ts || null };
          }
          return null;
        })();
        const previousPlace = previousAssistant ? api.prompt.extractPlace(previousAssistant.text) : '';
        if (previousPlace && api.prompt.placeConflict(fullText, previousPlace)) {
          const retry = await api.llm.chat({
            profile,
            messages: [
              ...messages,
              { role: 'assistant', content: fullText },
              {
                role: 'system',
                content: `你刚才还在${previousPlace}（${previousAssistant.ts ? '几分钟前' : '刚才'}你自己说的）。`
                  + '这句里写了别的地方，但没说怎么过去的。重写一版：要么留在原地说，要么用一句话交代怎么过去的（例如「从阳台回屋」）。'
                  + '保持 1–3 句、口语，只输出正文。',
              },
            ],
            retry: 0,
            maxTokens: 800,
            signal: controller.signal,
          });
          const fixed = retry && typeof retry.text === 'string' ? retry.text.trim() : '';
          if (fixed && !api.prompt.placeConflict(fixed, previousPlace)) {
            fullText = fixed;
            emitEvent('chat:replace', {
              characterId: character.id,
              messageId: session.messageId,
              text: fixed,
            });
            try {
              api.usage.record(dir, 'chat', (retry && retry.usage) || {}, now());
            } catch (error) {
              console.warn(`[ipc] 重写用量记账失败：${error && error.message ? error.message : error}`);
            }
          }
        }
      } catch (error) {
        console.warn(`[ipc] 地点连续性重写失败，沿用原回复：${error && error.message ? error.message : error}`);
      }

      const message = buildAssistantMessage(fullText, {
        profileId: profile ? profile.id : null,
        tokens: result && result.usage ? result.usage.completionTokens : 0,
      });
      api.store.appendMessage(dir, character.id, message);

      emitEvent('chat:done', {
        characterId: character.id,
        message,
        usage: result ? result.usage || null : null,
        stopped: false,
      });

      try {
        api.usage.record(dir, 'chat', (result && result.usage) || {}, now());
      } catch (error) {
        console.warn(`[ipc] 聊天用量记账失败：${error && error.message ? error.message : error}`);
      }

      // P3：聊完微调状态（正面 +2 心情 / -1 体力，负面 -2 心情）；失败不影响聊天结果
      try {
        const nextState = api.state.applyChat(currentState, {
          positive: api.state.isPositiveChat(text),
          now: nowDate,
        });
        api.state.writeState(dir, character.id, nextState, nowDate);
      } catch (error) {
        console.warn(`[ipc] 更新角色状态失败：${error && error.message ? error.message : error}`);
      }

      // 按 extractEveryTurns 累计用户消息数触发，而不是每条都抽（Spec 7.1 / 成本目标）
      const beforeExtract = api.store.readMemory(dir, character.id);
      const turns = userTurnsSince(character.id, beforeExtract.lastExtractedMessageId);
      const everyTurns = Number.isInteger(settings.memory.extractEveryTurns)
        && settings.memory.extractEveryTurns > 0
        ? settings.memory.extractEveryTurns
        : 4;
      if (turns >= everyTurns) {
        extractMemory(character.id, { limit: Math.max(1, settings.memory.shortTermTurns) * 2 });
      }
      return { ok: true, stopped: false, message, usage: result ? result.usage || null : null };
    } catch (error) {
      const code = error && error.code ? error.code : 'UNKNOWN';
      const stopped = session.stopped || code === 'ABORTED';

      if (stopped) {
        // 用户主动停止：保留已生成内容并标注，不当成错误
        const partial = acc || (error && typeof error.partialText === 'string' ? error.partialText : '');
        let message = null;
        if (partial) {
          message = buildAssistantMessage(`${partial}（中断）`, { stopped: true });
          api.store.appendMessage(dir, character.id, message);
        }
        emitEvent('chat:done', {
          characterId: character.id,
          message,
          text: partial,
          stopped: true,
        });
        return { ok: true, stopped: true, message };
      }

      emitEvent('chat:error', {
        characterId: character.id,
        code,
        message: error && error.message ? error.message : '模型没有回应，再试一次吧',
      });
      return {
        ok: false,
        stopped: false,
        error: {
          code,
          message: error && error.message ? error.message : '模型没有回应，再试一次吧',
        },
      };
    } finally {
      if (activeChat === session) activeChat = null;
    }
  }

  function chatStop() {
    if (!activeChat) return { stopped: false, message: '没有正在生成的回复' };
    activeChat.stopped = true;
    activeChat.controller.abort();
    return { stopped: true };
  }

  function chatHistory(_event, payload) {
    const input = payloadOf(payload);
    const settings = loadSettings();
    const character = resolveCharacter(input, settings);
    const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 200;
    return api.store.readMessages(dir, character.id, { limit });
  }

  function chatClear(_event, payload) {
    const input = payloadOf(payload);
    const settings = loadSettings();
    const character = resolveCharacter(input, settings);
    api.store.clearMessages(dir, character.id);
    emitEvent('state:changed', { reason: 'chat', characterId: character.id });
    return { ok: true, characterId: character.id };
  }

  // ---------- memory ----------

  function memoryList(_event, payload) {
    const settings = loadSettings();
    const character = resolveCharacter(payload, settings);
    const mem = api.store.readMemory(dir, character.id);
    return {
      characterId: character.id,
      cards: mem.cards,
      suppressed: Array.isArray(mem.suppressed) ? mem.suppressed : [],
    };
  }

  function memoryAdd(_event, payload) {
    const input = payloadOf(payload);
    const settings = loadSettings();
    const character = resolveCharacter(input, settings);
    const text = requireText(input.text, '记忆');
    const mem = api.store.readMemory(dir, character.id);
    const merged = api.memory.mergeCards(mem, [{
      kind: input.kind,
      text,
      tags: input.tags,
      importance: input.importance,
      sourceMessageId: input.sourceMessageId,
    }]);
    writeMemoryObject(character.id, { ...mem, cards: merged });
    return memoryList(_event, { characterId: character.id });
  }

  function memoryUpdate(_event, payload) {
    const input = payloadOf(payload);
    const settings = loadSettings();
    const character = resolveCharacter(input, settings);
    const id = requireText(input.id, '记忆 id');
    const mem = api.store.readMemory(dir, character.id);
    const index = mem.cards.findIndex((card) => card && card.id === id);
    if (index < 0) throw new Error('找不到这条记忆');

    const card = mem.cards[index];
    const next = { ...card };
    if (input.text !== undefined) {
      const text = requireText(input.text, '记忆');
      next.text = text;
      const variants = Array.isArray(card.variants) ? card.variants.slice() : [];
      if (variants[variants.length - 1] !== text) variants.push(text);
      next.variants = variants.slice(-api.memory.MAX_VARIANTS);
    }
    if (input.kind !== undefined) next.kind = input.kind;
    if (input.tags !== undefined) next.tags = input.tags;
    if (input.importance !== undefined) {
      next.importance = api.memory.normalizeImportance(input.importance);
    }
    next.updatedAt = now().toISOString();

    const cards = mem.cards.slice();
    cards[index] = next;
    writeMemoryObject(character.id, { ...mem, cards });
    return memoryList(_event, { characterId: character.id });
  }

  function memoryDelete(_event, payload) {
    const input = payloadOf(payload);
    const settings = loadSettings();
    const character = resolveCharacter(input, settings);
    const mem = api.store.readMemory(dir, character.id);
    const card = mem.cards.find((item) => item && item.id === input.id);
    const text = card ? card.text : (typeof input.text === 'string' ? input.text : '');
    if (!text) throw new Error('找不到这条记忆');

    const next = api.memory.suppress(mem, text, now());
    api.store.writeMemory(dir, character.id, next);
    emitEvent('state:changed', { reason: 'memory', characterId: character.id });
    return {
      ok: true,
      characterId: character.id,
      cards: next.cards,
      suppressed: next.suppressed,
    };
  }

  // ---------- timeline / state ----------

  function timelineGet(_event, payload) {
    const settings = loadSettings();
    const character = resolveCharacter(payload, settings);
    const timeline = api.store.readTimeline(dir, character.id);
    const date = dayKey(now());
    return {
      characterId: character.id,
      date,
      days: timeline.days,
      today: timeline.days[date] || null,
    };
  }

  /** 删除某一天的日记正文；日程、事件等当天数据保留。 */
  function timelineDeleteDiary(_event, payload) {
    const input = payloadOf(payload);
    const date = input.date;
    if (!isDayKey(date)) throw new Error('日记日期不合法');

    const settings = loadSettings();
    const character = resolveCharacter(input, settings);
    const timeline = api.store.readTimeline(dir, character.id);
    const day = timeline.days[date];
    let deleted = false;

    if (isPlainObject(day) && ('diary' in day || 'diaryAt' in day)) {
      deleted = typeof day.diary === 'string' && day.diary.trim() !== '';
      delete day.diary;
      delete day.diaryAt;
      // 防止今天删掉后，定时 tick 又自动补写一篇
      day.diaryAttempted = true;
      day.diaryDeleted = true;
      api.store.writeTimeline(dir, character.id, timeline);
      // 再写一次，让 .bak 也变成删除后的版本；否则恢复备份时旧日记会回来
      api.store.writeTimeline(dir, character.id, timeline);
    }

    return { ok: true, characterId: character.id, date, deleted };
  }

  /** 只读状态（设置页生活 Tab 的状态条用）：数值 + 一句中文，不做任何写入 */
  function stateGet(_event, payload) {
    const settings = loadSettings();
    const at = now();
    let character = null;
    try {
      character = resolveCharacter(payload, settings);
    } catch {
      character = null;
    }
    // 新装/还没建角色时不要报错，返回一个中性状态给设置页展示
    if (!character) {
      const empty = api.state.normalizeState(null, at);
      return {
        characterId: null,
        mood: empty.mood,
        energy: empty.energy,
        focus: empty.focus,
        day: empty.day,
        updatedAt: empty.updatedAt,
        description: '还没有角色',
        canGoOut: api.state.canGoOut(empty),
        weather: calendar.seasonalWeather(at, 'empty'),
        holiday: calendar.holidayOf(at),
        term: calendar.solarTermOf(at),
        season: calendar.seasonOf(at),
        useWeather: settings.life.useWeather !== false,
        empty: true,
      };
    }
    // 展示时也走一次跨天结算（不落盘），避免刚过零点看到昨天的体力
    const value = api.state.settleDay(api.state.readState(dir, character.id, at), at);
    const weather = isPlainObject(value.weather)
      ? value.weather
      : calendar.seasonalWeather(at, character.id);
    return {
      characterId: character.id,
      mood: value.mood,
      energy: value.energy,
      focus: value.focus,
      day: value.day,
      updatedAt: value.updatedAt,
      description: api.state.describeState(value),
      canGoOut: api.state.canGoOut(value),
      // P4：设置页「今天」卡片展示用（weather 是 state 缓存或季节估算）
      weather,
      holiday: calendar.holidayOf(at),
      term: calendar.solarTermOf(at),
      season: calendar.seasonOf(at),
      useWeather: settings.life.useWeather !== false,
    };
  }

  // ---------- 语音（TTS） ----------

  /**
   * 把一句话合成成音频，返回 file:// URL 给渲染层播放。
   * 播放/停止都在渲染层做（多窗口各自持有 <audio>），主进程只管合成。
   */
  async function ttsSpeak(_event, payload) {
    const input = payloadOf(payload);
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text.trim()) return { ok: false, error: 'empty' };
    const settings = loadSettings();
    const voice = settings.voice || {};
    const kind = ['bubble', 'chat', 'preview'].includes(input.kind) ? input.kind : 'chat';
    if (voice.enabled === false && kind !== 'preview') return { ok: false, error: 'disabled' };
    if (kind === 'bubble' && voice.inBubble === false) return { ok: false, error: 'off-bubble' };
    if (kind === 'chat' && voice.inChat === false) return { ok: false, error: 'off-chat' };
    try {
      const result = await api.tts.speak({ text, voice, dir });
      if (result && result.ok === false) {
        console.warn(`[ipc] 语音合成失败：${result.error || 'unknown'}`);
      }
      return { ...result, volume: Number.isFinite(Number(voice.volume)) ? Number(voice.volume) : 1 };
    } catch (error) {
      console.warn(`[ipc] 语音合成异常：${error && error.message ? error.message : error}`);
      return { ok: false, error: error && error.message ? error.message : 'tts-error' };
    }
  }

  /** 让所有窗口停下当前朗读（聊天里点「停止」，或她开始新的回复时） */
  function ttsStop() {
    emitEvent('tts:halt', { at: now().toISOString() });
    return { ok: true };
  }

  /** 设置页用：当前机器上哪些引擎可用 */
  async function ttsStatus() {
    const settings = loadSettings();
    try {
      const info = await api.tts.status({ voice: settings.voice, dir });
      return { ok: true, ...info, voice: settings.voice };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : 'tts-status-error', voice: settings.voice };
    }
  }

  // ---------- pet / window ----------

  /**
   * 当前形象包的帧位 → 绝对 file:// URL（供小人窗 <img> 直接用）。
   * 只认角色目录内的文件：越界路径、不存在的帧一律跳过（画面回落到内置占位）。
   */
  function petFrameUrls(character) {
    if (!character || typeof character.id !== 'string' || character.id === '') return {};
    const appearance = isPlainObject(character.appearance) ? character.appearance : {};
    const packs = Array.isArray(appearance.packs) ? appearance.packs : [];
    const pack = packs.find((item) => item && item.id === appearance.activePack) || packs[0] || null;
    const frames = pack && isPlainObject(pack.frames) ? pack.frames : {};

    const urls = {};
    for (const key of FRAME_KEYS) {
      const url = frameUrlOf(character.id, frames[key]);
      if (url) urls[key] = url;
    }
    return urls;
  }

  /** 小人拖动时用于钳制的可用区域（由主进程注入 screen；测试环境没有就返回 null） */
  function petWorkArea() {
    if (typeof deps.workArea !== 'function') return null;
    try {
      const area = deps.workArea();
      return area && typeof area === 'object' ? area : null;
    } catch (error) {
      console.warn(`[ipc] 读取 workArea 失败：${error && error.message ? error.message : error}`);
      return null;
    }
  }

  /** 指针是否还在小人窗内（自定义菜单靠它判断「点外面了」） */
  function petCursorInside() {
    const windowsRef = getWindows();
    const pet = windowsRef && windowsRef.pet;
    if (!pet || (typeof pet.isDestroyed === 'function' && pet.isDestroyed())) {
      return { inside: false };
    }
    const cursor = typeof api.cursor === 'function' ? api.cursor() : null;
    if (!cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) {
      return { inside: true };
    }
    const bounds = typeof pet.getBounds === 'function' ? pet.getBounds() : null;
    if (!bounds) return { inside: true };
    const inside = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
      && cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height;
    return { inside, cursor, bounds };
  }

  /** 当前形象包（缩放 / 朝向跟着包走，不再是全局设置） */
  function activePackOf(character) {
    const appearance = character && isPlainObject(character.appearance) ? character.appearance : {};
    const packs = Array.isArray(appearance.packs) ? appearance.packs : [];
    return packs.find((item) => item && item.id === appearance.activePack) || packs[0] || null;
  }

  /**
   * 形象包里的 Live2D 模型（相对角色目录）→ she-asset:// URL。
   * 只认角色目录内的文件：越界、不存在一律返回空，小人窗就退回静态立绘。
   */
  function live2dUrlOf(characterId, rel) {
    if (typeof characterId !== 'string' || characterId === '') return '';
    if (typeof rel !== 'string' || rel.trim() === '') return '';
    const root = paths.charDir(dir, characterId);
    const target = path.resolve(root, rel.trim());
    const inside = path.relative(root, target);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return '';
    try {
      if (!fs.statSync(target).isFile()) return '';
    } catch {
      return '';
    }
    const parts = inside.split(/[\\/]+/).filter(Boolean).map((part) => encodeURIComponent(part));
    return `she-asset://char/${encodeURIComponent(characterId)}/${parts.join('/')}`;
  }

  function petGetState() {    const settings = loadSettings();
    const character = activeCharacter(settings);
    const appearance = character && isPlainObject(character.appearance) ? character.appearance : {};
    const pack = activePackOf(character);
    const packScale = pack && Number.isFinite(Number(pack.scale)) ? Number(pack.scale) : null;
    // 旧数据没有 pack.scale：沿用原来的全局缩放（ui.petScale），避免升级后小人突然变大
    const scale = packScale !== null
      ? Math.min(2, Math.max(0.2, packScale))
      : settings.ui.petScale;
    const flip = pack && typeof pack.flip === 'boolean'
      ? pack.flip === true
      : appearance.flip === true;
    // Live2D 模型（形象包里写了 live2d 才启用；读不到就走静态立绘）
    const live2dRel = pack && typeof pack.live2d === 'string' ? pack.live2d : '';
    const live2d = live2dUrlOf(character && character.id, live2dRel);
    const live2dSize = pack && isPlainObject(pack.live2dSize)
      ? {
        width: Number.isFinite(Number(pack.live2dSize.width)) ? Number(pack.live2dSize.width) : 360,
        height: Number.isFinite(Number(pack.live2dSize.height)) ? Number(pack.live2dSize.height) : 700,
      }
      : { width: 360, height: 700 };
    return {
      ui: settings.ui,
      scale,
      pos: settings.ui.petPos,
      clickThrough: settings.ui.clickThrough,
      alwaysOnTop: settings.ui.alwaysOnTop,
      flip,
      live2d,
      live2dSize,
      character,
      frames: petFrameUrls(character),
      bubble,
    };
  }

  /**
   * 移动小人窗。
   * - clamp:true 时用 geometry.clampPetPos 把坐标钳制在 workArea 内（留 8px）；
   * - commit:false 用于拖动过程中的实时移动，只动窗口不写盘（松手才保存）。
   */
  function petMove(_event, payload) {
    const input = payloadOf(payload);
    let x = Number(input.x);
    let y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('位置需要数字 x / y');

    const windows = getWindows();
    const pet = windows.pet;

    if (input.clamp === true) {
      const area = petWorkArea();
      if (area) {
        const bounds = pet && typeof pet.getBounds === 'function' ? pet.getBounds() : null;
        const size = {
          width: bounds && Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : 220,
          height: bounds && Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 380,
        };
        const clamped = geometry.clampPetPos({ x, y }, size, area);
        x = clamped.x;
        y = clamped.y;
      }
    }

    const point = { x: Math.round(x), y: Math.round(y) };
    let savedPos = point;
    if (input.commit !== false) {
      const saved = api.config.saveSettings(dir, { ui: { petPos: point } });
      savedPos = saved.ui.petPos;
    }
    if (pet && typeof pet.setPosition === 'function' && !pet.isDestroyed?.()) {
      pet.setPosition(point.x, point.y);
    }
    return savedPos;
  }

  /** 调整小人窗尺寸（= 立绘宽 × petScale，高额外留气泡位）：尺寸下限随 petScale 走，并限制在 workArea 内 */
  function petResize(width, height, scale) {
    const pet = getWindows().pet;
    if (!pet || typeof pet.setContentSize !== 'function' || pet.isDestroyed?.()) return;

    const ratio = Number.isFinite(scale) && scale > 0 ? scale : 1;
    // 0.5 倍时最小宽 = 220 × 0.5 = 110（旧实现写死 120，和规范对不上）
    // 气泡显示期间强制至少 240，避免渲染进程的 pet:scale 把窗口缩回去
    const bubbleWide = typeof api.bubbleWidth === 'function' && api.bubbleWidth();
    const minWidth = Math.max(
      1,
      Math.round(geometry.PET_SIZE.width * ratio),
      bubbleWide ? 240 : 0,
    );
    const minHeight = Math.max(1, Math.round(geometry.PET_SIZE.height * ratio));
    let w = Math.max(minWidth, Math.round(width));
    let h = Math.max(minHeight, Math.round(height));
    const area = petWorkArea();
    if (area) {
      w = Math.min(w, Math.max(minWidth, area.width - geometry.MARGIN * 2));
      h = Math.min(h, Math.max(minHeight, area.height - geometry.MARGIN * 2));
    }
    try {
      pet.setContentSize(w, h);
      if (area && typeof pet.getBounds === 'function' && typeof pet.setPosition === 'function') {
        const bounds = pet.getBounds();
        const pos = geometry.clampPetPos({ x: bounds.x, y: bounds.y }, { width: w, height: h }, area);
        pet.setPosition(pos.x, pos.y);
      }
    } catch (error) {
      console.warn(`[ipc] 调整小人窗尺寸失败：${error && error.message ? error.message : error}`);
    }
  }

  function petScale(_event, payload) {
    const input = payloadOf(payload);
    const scale = Number(input.scale === undefined ? payload : input.scale);
    if (!Number.isFinite(scale) || scale < 0.2 || scale > 2) {
      throw new Error('缩放应在 0.2–2.0 之间');
    }

    // 附带 size：只按立绘调整窗口大小（scale 未变，不回写设置，也不广播）
    const size = isPlainObject(input.size) ? input.size : null;
    if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
      petResize(size.width, size.height, scale);
      return { scale };
    }

    // 缩放写进当前形象包（每个包各自一份），不再改全局 settings.ui.petScale
    const settings = loadSettings();
    const character = activeCharacter(settings);
    if (!character) {
      // 还没有角色：退回全局设置，至少别让调用报错
      const saved = api.config.saveSettings(dir, { ui: { petScale: scale } });
      emitEvent('state:changed', { reason: 'pet' });
      return { scale: saved.ui.petScale };
    }
    const appearance = isPlainObject(character.appearance) ? character.appearance : {};
    const packs = Array.isArray(appearance.packs) ? appearance.packs.slice() : [];
    let index = packs.findIndex((item) => item && item.id === appearance.activePack);
    if (index < 0 && packs.length > 0) index = 0;
    let activePack = appearance.activePack;
    if (index >= 0) {
      packs[index] = { ...packs[index], scale };
      activePack = packs[index].id;
    } else {
      const pack = { id: 'default', name: '常服', frames: {}, scale };
      packs.push(pack);
      activePack = pack.id;
    }
    api.store.saveCharacter(dir, {
      ...character,
      appearance: { ...appearance, activePack, packs },
    });
    emitEvent('state:changed', { reason: 'pet' });
    return { scale };
  }

  function petSetIgnore(_event, payload) {
    const input = payloadOf(payload);
    const flag = typeof payload === 'boolean'
      ? payload
      : typeof input.ignore === 'boolean'
        ? input.ignore
        : Boolean(input);
    const windows = getWindows();
    const pet = windows.pet;
    if (pet && typeof pet.setIgnoreMouseEvents === 'function' && !pet.isDestroyed?.()) {
      pet.setIgnoreMouseEvents(flag, { forward: true });
    }
    return { ok: true, ignore: flag };
  }

  function petBubbleDismissed() {
    bubble = null;
    return { ok: true };
  }

  function windowOpenHandler(_event, payload) {
    const input = payloadOf(payload);
    const target = typeof payload === 'string' ? payload : input.target || input.window;
    if (!WINDOW_TARGETS.has(target)) throw new Error(`未知的窗口：${target}`);
    const characterId = typeof input.characterId === 'string' && input.characterId !== ''
      ? input.characterId
      : null;
    windowOpen(target, 'show', characterId);
    return characterId ? { ok: true, target, characterId } : { ok: true, target };
  }

  /** 聊天窗把「读到这里」告诉主进程，托盘据此清掉该角色的红点/闪烁。 */
  function chatMarkRead(_event, payload) {
    const input = payloadOf(payload);
    const characterId = typeof input.characterId === 'string' ? input.characterId : input.id;
    if (typeof characterId !== 'string' || characterId === '') throw new Error('标记已读需要角色 id');
    if (!findCharacter(characterId)) throw new Error(`未知的角色：${characterId}`);
    const at = Number(input.at);
    const readAt = api.notifications.markRead(
      dir,
      characterId,
      Number.isFinite(at) && at > 0 ? at : now().getTime(),
    );
    if (typeof deps.onUnreadChanged === 'function') {
      try {
        deps.onUnreadChanged();
      } catch (error) {
        console.warn(`[ipc] 刷新托盘未读失败：${error && error.message ? error.message : error}`);
      }
    }
    return { ok: true, characterId, readAt };
  }

  /** 托盘悬停浮层的数据：谁发了消息、各几条。 */
  function trayUnread() {
    return api.notifications.summarize(dir, listCharacters());
  }

  /** 鼠标在托盘浮层里时取消自动隐藏，离开后主进程再延时收起。 */
  function trayPopupHover(_event, payload) {
    const input = payloadOf(payload);
    const inside = input.inside === true;
    if (deps.trayPopup && typeof deps.trayPopup.setHover === 'function') {
      deps.trayPopup.setHover(inside);
    }
    return { ok: true, inside };
  }

  /** 退出应用：渲染层（小人右键菜单）调用；真实退出交给 main.js 注入 */
  function appQuit() {
    if (typeof api.quit === 'function') api.quit();
    return { ok: true };
  }

  // ---------- usage / data ----------

  function usageToday() {
    return api.usage.today(dir, now());
  }

  /** 在系统文件管理器里打开数据目录（shell.openPath 由主进程注入） */
  function dataOpenDir() {
    if (typeof deps.openPath !== 'function') throw new Error('当前环境不能打开数据目录');
    try {
      const result = deps.openPath(dir);
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          console.warn(`[ipc] 打开数据目录失败：${error && error.message ? error.message : error}`);
        });
      }
    } catch (error) {
      throw new Error(`打开数据目录失败：${error && error.message ? error.message : error}`);
    }
    return { ok: true, path: dir };
  }

  /**
   * 导出全部数据：递归复制 data/ → <目标>/she-export-<yyyymmdd-HHMM>/。
   * 项目没有 zip 依赖，这里导出的是文件夹（docs/manual-settings-check.md 有说明）。
   * targetDir 可由测试直接传入；正常流程由主进程弹目录选择框。
   */
  async function dataExport(_event, payload) {
    const input = payloadOf(payload);
    let target = typeof input.targetDir === 'string' && input.targetDir.trim() !== ''
      ? path.resolve(input.targetDir)
      : null;

    if (!target) {
      if (typeof deps.pickDirectory !== 'function') throw new Error('当前环境不能选择导出位置');
      const picked = await deps.pickDirectory();
      if (!picked) return { canceled: true, ok: false, path: null };
      target = path.resolve(String(picked));
    }

    const source = path.resolve(dir);
    const dest = path.join(target, `she-export-${exportStamp(now())}`);

    // 自复制守卫：用真实路径 + Windows 大小写归一比较。
    // dest 还不存在，只能解析父目录；junction/symlink 也会被 realpath 解开。
    const sourceKey = comparablePath(source);
    const destKey = comparablePath(path.join(realOrResolve(path.dirname(dest)), path.basename(dest)));
    if (isSameOrInside(sourceKey, destKey)) {
      throw new Error('导出位置不能选在数据目录里面');
    }
    if (isSameOrInside(destKey, sourceKey)) {
      throw new Error('导出位置不能是数据目录的上级目录');
    }
    if (!api.fs.existsSync(source)) throw new Error('还没有数据可以导出');

    try {
      copyTree(api.fs, source, dest);
      // 导出副本脱敏：settings.json / .bak 里的 apiKey 一律清空（原始 data/ 不动）
      sanitizeExportedSettings(api.fs, dest);
    } catch (error) {
      // 只清理本次新建的半成品导出目录，绝不碰其他文件
      try {
        api.fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        /* 清理失败忽略，保留原始错误 */
      }
      throw new Error(`导出失败：${error && error.message ? error.message : error}`);
    }
    return { canceled: false, ok: true, path: dest };
  }

  /** 选择一张本地图片（返回绝对路径；渲染层拿不到 File.path，必须走主进程） */
  async function dialogPickImage() {
    if (typeof deps.pickImage !== 'function') throw new Error('当前环境不能选择图片');
    const picked = await deps.pickImage();
    if (!picked) return { canceled: true, path: null };
    const filePath = typeof picked === 'string' ? picked : picked.path || picked.filePath;
    if (!filePath) return { canceled: true, path: null };
    return { canceled: false, path: String(filePath) };
  }

  // ---------- 通道表 ----------

  return {
    'settings:get': settingsGet,
    'settings:save': settingsSave,
    'settings:setKey': settingsSetKey,
    'settings:testProfile': settingsTestProfile,
    'settings:setAutostart': settingsSetAutostart,

    'characters:list': charactersList,
    'characters:create': charactersCreate,
    'characters:save': charactersSave,
    'characters:delete': charactersDelete,
    'characters:setActive': charactersSetActive,
    'characters:importFrame': charactersImportFrame,
    'characters:frames': charactersFrames,
    'characters:generateInner': charactersGenerateInner,
    'characters:saveInner': charactersSaveInner,

    'chat:send': chatSend,
    'chat:stop': chatStop,
    'chat:history': chatHistory,
    'chat:clear': chatClear,
    'chat:markRead': chatMarkRead,

    'memory:list': memoryList,
    'memory:add': memoryAdd,
    'memory:update': memoryUpdate,
    'memory:delete': memoryDelete,

    'timeline:get': timelineGet,
    'timeline:deleteDiary': timelineDeleteDiary,
    'state:get': stateGet,

    'usage:today': usageToday,

    'pet:getState': petGetState,
    'pet:cursorInside': petCursorInside,
    'pet:move': petMove,
    'pet:scale': petScale,
    'pet:setIgnore': petSetIgnore,
    'pet:bubbleDismissed': petBubbleDismissed,
    'tts:speak': ttsSpeak,
    'tts:stop': ttsStop,
    'tts:status': ttsStatus,
    'window:open': windowOpenHandler,
    'tray:unread': trayUnread,
    'tray:popupHover': trayPopupHover,
    'app:quit': appQuit,

    'data:openDataDir': dataOpenDir,
    'data:export': dataExport,
    'dialog:pickImage': dialogPickImage,
  };
}

module.exports = {
  CHANNELS,
  EVENTS,
  createHandlers,
  createExtractor,
  register,
  dispatch,
  isAppRendererUrl,
  EXTRACT_BACKOFF_MS,
};
