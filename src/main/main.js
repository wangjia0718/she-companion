'use strict';

// 主进程：单实例锁、三窗口、托盘、调度器装配、IPC 注册。
// 只用 Node 标准库 + Electron 内置模块；CommonJS。
//
// 窗口分工（Spec 3 / 10）：
//   pet      透明无边框立绘窗（不占任务栏、不可缩放、无阴影）
//   chat     960×680 聊天窗
//   settings 900×640 设置窗
// 三窗口统一 contextIsolation:true / nodeIntegration:false / preload 白名单。
//
// --selftest：以 show:false 建三个窗口，全部 did-finish-load 后做 preload 的 on/off 断言，
// 通过 app.exit(0)、失败或 15 秒超时 app.exit(1)；不弹托盘、不发系统通知、不开调度器。
// --smoke：数据目录用 data/smoke，先准备演示角色（阿澜）+ 1×1 透明 idle 帧 + 两条示例消息，
// 三窗口加载完成后依次 capturePage 存 smoke-pet/chat/settings.png（后两个调到 1100×720），
// 成功 app.exit(0)、任何一步失败或 20 秒超时 app.exit(1)。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, dialog, shell,
  protocol, net,
} = require('electron');

// 打包版允许在 <安装目录>/data/content/*.json 覆盖静态内容，改完重启即可生效。
const CONTENT_OVERRIDE_DIR = app.isPackaged
  ? path.join(path.dirname(process.execPath), 'data', 'content')
  : '';
if (CONTENT_OVERRIDE_DIR) process.env.SHE_CONTENT_DIR = CONTENT_OVERRIDE_DIR;

const paths = require('./paths');
const config = require('./config');
const store = require('./store');
const ipc = require('./ipc');
const life = require('./life');
const stateEngine = require('./state');
const usage = require('./usage');
const memory = require('./memory');
const geometry = require('./geometry');
const notifications = require('./notifications');
const trayIcon = require('./tray-icon');
const i18n = require('./i18n');
const { createScheduler, shouldExtractIdle } = require('./scheduler');

const MODE = process.argv.includes('--selftest')
  ? 'selftest'
  : process.argv.includes('--smoke')
    ? 'smoke'
    : 'run';
const HEADLESS = MODE !== 'run';
const MODE_TIMEOUT_MS = 15000;
const SMOKE_TIMEOUT_MS = 20000;
const ROOT = path.join(__dirname, '..', '..');
// 打包后 ROOT 在 asar 里（只读），数据放到 exe 同级目录（NSIS 默认装在 LocalAppData，可写）
const BASE_DIR = app.isPackaged ? path.dirname(app.getPath('exe')) : ROOT;
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
// 小人窗默认尺寸：立绘按 contain 适配，气泡叠在上方；拖动钳制也用它兜底
const PET_SIZE = geometry.PET_SIZE;
const DATA_DIR = MODE === 'run'
  ? paths.dataDir(BASE_DIR)
  : path.join(paths.dataDir(BASE_DIR), MODE);

// 托盘图标：32×32 暖色圆点（内嵌 PNG，避免依赖外部资源 / 原生模块）
const TRAY_ICON = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAk0lEQVR4nO3UMQ6AIBBEUU7qhTyZ17ExscHWhjC7M4OQaLLl+p+YUMrqz7FvdWgMnc/CUggTpiHKeBjhiMMIZxxCRF92X6cOEIm2hkKw8QjC8vXUKSwBQOLp37DECdgA6IIaYEGk4pkb8I3J7koAzPyA9HVsiU8BGIVoxqcAuBHduBMBxx2IcFwFocIMRBruoZj9Bzlm1SDV6XPaAAAAAElFTkSuQmCC';

const TRAY_ALERT_ICON = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABKklEQVR4nM2XsQ3CMBBFcyeQaBiAJSKlIdvAApRkCiizANkGGqQswQA0SBRGKYycc0zOPifmV2A7fs9nnATIJopSStE2AADahlLQ9bRTFDwEd/WBBEazPV6+nx95bvVv2taqBsQAc+AuCZCCfeBDEiiFm+HA6TiUwvXquXAqgRJ4jGCWOIuQ1ReHOl0FiojwnkDo3r9fT+tocaLHYwh0bFKfcRij/LoKHAl6J0QfgXt9cPZxJMz223lvnwJpOonlaj1aCQ3vAr4/QM4p6CplPh+GwD2BmBK/tommrBoI2gIT0sn4QGkw+MoBmSQC0uDfCJRV4/V+KI3mYZY4aH6ZqwomB7PEQdowdRXo/MgZNBXcKTCFhGs+4FwseVMeWwj4TOYjMtt9Rfo/4gN5BpHjqB3rLAAAAABJRU5ErkJggg==';

const HTML = {
  pet: path.join(__dirname, '..', 'renderer', 'pet', 'pet.html'),
  chat: path.join(__dirname, '..', 'renderer', 'chat', 'chat.html'),
  settings: path.join(__dirname, '..', 'renderer', 'settings', 'settings.html'),
  tray: path.join(__dirname, '..', 'renderer', 'tray', 'tray.html'),
};

app.setName('她');
app.setAppUserModelId('com.she.companion');

// Live2D 模型需要从渲染层取 model3.json 和纹理；file:// 页面用 fetch 读不了 file://，
// 所以给角色资源单独开一个协议，只映射到 data/characters 下面。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'she-asset',
    privileges: {
      standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
    },
  },
]);
// Windows 上窗口隐藏/被遮挡时间长了，Chromium 会按「原生遮挡」停止绘制，再显示时可能空白很久。
// 三件事一起关掉：原生遮挡计算、被遮挡窗口的后台化、渲染进程后台化。否则新建/恢复的窗口
// 可能几十秒都不出第一帧（用户看到的就是「打开后空白半分钟」）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

if (MODE === 'smoke') {
  // 截图尺寸不随机器缩放变化：1100×720 的内容区就输出 1100×720 的 PNG
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

// 数据（含 Electron 自己的 userData）全部收在项目 data/ 下，不污染用户目录
try {
  app.setPath('userData', path.join(DATA_DIR, 'userData'));
} catch (error) {
  console.warn(`[main] 设置 userData 失败：${error && error.message ? error.message : error}`);
}

if (HEADLESS) {
  // 无 GPU 的 CI/远程桌面更稳；透明窗口仍能创建
  app.disableHardwareAcceleration();
}

const windows = { pet: null, chat: null, settings: null };
// 关闭窗口只隐藏，真正退出（托盘「退出」）才销毁；quitting 用来放行真正的 close
let quitting = false;
// 窗口隐藏超过这么久，后台悄悄 reload 一次，下次打开就是热页面
const BACKGROUND_RELOAD_MS = 30 * 60 * 1000;

// 气泡显示时临时加宽小人窗：立绘很窄时，气泡 max-width 只有几十像素，文字会被挤成竖排。
const BUBBLE_MIN_WIDTH = 240;
const BUBBLE_WIDEN_MS = 12500;
let bubbleWidthState = null;
let bubbleWidthTimer = null;
let tray = null;
let trayIcons = null;
let trayBlinkTimer = null;
let traySummary = { total: 0, items: [] };
let trayAvatarKey = '';
let trayHoverTimer = null;
let trayHideTimer = null;
let trayPopup = null;
let trayPopupWanted = false;
let trayPopupHovered = false;
const TRAY_POPUP_WIDTH = 288;
const TRAY_POPUP_MAX_HEIGHT = 380;
let scheduler = null;
let startedAt = new Date();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function activeCharacter(settings) {
  const characters = store.listCharacters(DATA_DIR);
  if (characters.length === 0) return null;
  return characters.find((character) => character && character.id === settings.activeCharacterId)
    || characters[0];
}

function findProfile(settings, id) {
  const list = settings && settings.api && Array.isArray(settings.api.profiles)
    ? settings.api.profiles
    : [];
  return list.find((profile) => profile && profile.id === id) || null;
}

function backgroundProfile(settings) {
  return findProfile(settings, settings.api.background)
    || findProfile(settings, settings.api.chat)
    || (settings.api.profiles || [])[0]
    || null;
}

function lastUserMessage(characterId, recent) {
  try {
    const messages = Array.isArray(recent)
      ? recent
      : store.readMessages(DATA_DIR, characterId, { limit: 50 });
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== 'user') continue;
      return {
        at: typeof message.ts === 'string' ? message.ts : null,
        text: typeof message.text === 'string' ? message.text : '',
      };
    }
  } catch (error) {
    console.warn(`[main] 读取最近消息失败：${error && error.message ? error.message : error}`);
  }
  return { at: null, text: '' };
}

function lastUserAt(characterId) {
  return lastUserMessage(characterId).at;
}

/** 昨天的日期键（本地时区） */
function previousDayKeyOf(now = new Date()) {
  const previous = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  previous.setDate(previous.getDate() - 1);
  return dayKey(previous);
}

/** 广播给所有还活着的窗口（渲染层只能监听白名单事件） */
function broadcast(event, payload) {
  for (const win of Object.values(windows)) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(event, payload);
    } catch (error) {
      console.warn(`[main] 发送 ${event} 失败：${error && error.message ? error.message : error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function petWorkAreas() {
  return screen.getAllDisplays().map((display) => display.workArea);
}

function petInitialPosition(settings) {
  const saved = settings && settings.ui ? settings.ui.petPos : null;
  // 有保存坐标就按它所在的显示器钳制（副屏/负坐标屏不会被拉回主屏）；未定位才放主屏右下角
  return geometry.initialPetPosition(
    saved,
    PET_SIZE,
    petWorkAreas(),
    screen.getPrimaryDisplay().workArea,
  );
}

/** 显示器拔插 / 分辨率变化后重新钳制小人窗，别留在已经不存在的区域里 */
function reclampPetWindow() {
  const win = windows.pet;
  if (!win || win.isDestroyed()) return;
  let bounds;
  try {
    bounds = win.getBounds();
  } catch (error) {
    console.warn(`[main] 读取小人窗位置失败：${error && error.message ? error.message : error}`);
    return;
  }
  const pos = geometry.clampPetPosToNearest(
    { x: bounds.x, y: bounds.y },
    { width: bounds.width, height: bounds.height },
    petWorkAreas(),
    screen.getPrimaryDisplay().workArea,
  );
  if (pos.x === bounds.x && pos.y === bounds.y) return;
  try {
    win.setPosition(pos.x, pos.y);
  } catch (error) {
    console.warn(`[main] 重新钳制小人窗位置失败：${error && error.message ? error.message : error}`);
  }
}

/** 气泡显示前把小人窗临时加宽到可读宽度，并保持立绘中心不动 */
function widenPetForBubble() {
  const win = windows.pet;
  if (!win || win.isDestroyed()) return;
  let bounds;
  try {
    bounds = win.getBounds();
  } catch (error) {
    return;
  }
  if (bounds.width >= BUBBLE_MIN_WIDTH) {
    bubbleWidthState = null;
    return;
  }
  // 已经加宽过：只重置计时，别把原始宽度覆盖掉
  if (bubbleWidthState) {
    if (bubbleWidthTimer) clearTimeout(bubbleWidthTimer);
    bubbleWidthTimer = setTimeout(restorePetWidth, BUBBLE_WIDEN_MS);
    if (bubbleWidthTimer && typeof bubbleWidthTimer.unref === 'function') bubbleWidthTimer.unref();
    return;
  }
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(BUBBLE_MIN_WIDTH, area.width);
  const centerX = bounds.x + bounds.width / 2;
  const x = Math.round(Math.max(area.x, Math.min(centerX - width / 2, area.x + area.width - width)));
  bubbleWidthState = { width: bounds.width };
  try {
    win.setBounds({ x, y: bounds.y, width, height: bounds.height });
  } catch (error) {
    console.warn(`[main] 加宽小人窗失败：${error && error.message ? error.message : error}`);
    bubbleWidthState = null;
    return;
  }
  if (bubbleWidthTimer) clearTimeout(bubbleWidthTimer);
  bubbleWidthTimer = setTimeout(restorePetWidth, BUBBLE_WIDEN_MS);
  if (bubbleWidthTimer && typeof bubbleWidthTimer.unref === 'function') bubbleWidthTimer.unref();
}

/** 气泡消失后还原原来的宽度，以当前中心为准，避免拖拽后跳动 */
function restorePetWidth() {
  if (bubbleWidthTimer) {
    clearTimeout(bubbleWidthTimer);
    bubbleWidthTimer = null;
  }
  const state = bubbleWidthState;
  bubbleWidthState = null;
  if (!state) return;
  const win = windows.pet;
  if (!win || win.isDestroyed()) return;
  let bounds;
  try {
    bounds = win.getBounds();
  } catch (error) {
    return;
  }
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = state.width;
  const centerX = bounds.x + bounds.width / 2;
  const x = Math.round(Math.max(area.x, Math.min(centerX - width / 2, area.x + area.width - width)));
  try {
    win.setBounds({ x, y: bounds.y, width, height: bounds.height });
  } catch (error) {
    console.warn(`[main] 还原小人窗宽度失败：${error && error.message ? error.message : error}`);
  }
}

/**
 * 角色资源协议：she-asset://char/<角色 id>/<相对路径>
 * 只允许读 data/characters/<id>/ 下面的文件，越界或不存在一律 404。
 * 用途：Live2D 的 model3.json / moc3 / 纹理需要 fetch，file:// 页面读不了 file://。
 */
function registerAssetProtocol() {
  const MIME = {
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.moc3': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
  };

  protocol.handle('she-asset', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'char') return new Response('not found', { status: 404 });
      const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
      const [characterId, ...rest] = segments;
      if (!characterId || rest.length === 0) return new Response('not found', { status: 404 });

      const root = paths.charDir(DATA_DIR, characterId);
      const target = path.resolve(root, rest.join('/'));
      const rel = path.relative(root, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return new Response('forbidden', { status: 403 });
      }

      let body;
      try {
        body = fs.readFileSync(target);
      } catch {
        return new Response('not found', { status: 404 });
      }
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
          'access-control-allow-origin': '*',
          'cache-control': 'no-cache',
        },
      });
    } catch (error) {
      console.warn(`[main] she-asset 读取失败：${error && error.message ? error.message : error}`);
      return new Response('error', { status: 500 });
    }
  });
}

function isInsideRenderer(rawUrl) {  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('file:')) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  parsed.search = '';
  parsed.hash = '';
  let target;
  try {
    target = path.resolve(fileURLToPath(parsed));
  } catch {
    return false;
  }
  const root = path.resolve(RENDERER_DIR);
  return target === root || target.startsWith(root + path.sep);
}

function createWindow(name, settings, { autoShow = true } = {}) {
  const isPet = name === 'pet';
  const options = {
    width: isPet ? PET_SIZE.width : name === 'chat' ? 960 : 900,
    height: isPet ? PET_SIZE.height : name === 'chat' ? 680 : 640,
    show: false,
    title: isPet ? i18n.t('她') : name === 'chat' ? i18n.t('和她聊天') : i18n.t('设置'),
    backgroundColor: isPet ? '#00000000' : '#FAF7F2',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 小人窗不常获得焦点，定时器不能被 Chromium 节流（菜单收起的守卫依赖它）
      backgroundThrottling: false,
      // smoke/selftest 窗口不显示也要能截图（Task 14）
      paintWhenInitiallyHidden: true,
    },
  };

  if (isPet) {
    Object.assign(options, {
      transparent: true,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: settings.ui.alwaysOnTop !== false,      hasShadow: false,
      ...petInitialPosition(settings),
    });
  } else {
    Object.assign(options, {
      minWidth: name === 'chat' ? 720 : 780,
      minHeight: name === 'chat' ? 520 : 560,
    });
  }

  const win = new BrowserWindow(options);
  win.setMenuBarVisibility(false);

  // 安全：禁止开新窗口，禁止导航到应用渲染目录之外的地址
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInsideRenderer(url)) {
      event.preventDefault();
      console.warn(`[main] 已拦截 ${name} 窗口跳转到 ${url}`);
    }
  });

  if (isPet) {
    // 先开穿透，渲染层判断指针落在立绘上时再临时关闭（Spec 10.1）
    win.setIgnoreMouseEvents(settings.ui.clickThrough !== false, { forward: true });
  } else {
    win.on('ready-to-show', () => {
      if (!HEADLESS && autoShow) win.show();
    });
    win.on('focus', () => {
      if (name === 'chat') refreshTrayNotifications();
    });
    win.on('blur', () => {
      // 聊天窗失焦后，如果还有别的角色没读，托盘重新开始闪
      if (name === 'chat') refreshTrayNotifications();
    });
    // 从隐藏状态显示时强制重绘一次：偶发「窗口出来了但首帧还是空白」
    win.__hiddenSince = Date.now();
    win.on('show', () => {
      win.__hiddenSince = null;
      if (win.__reloadTimer) {
        clearTimeout(win.__reloadTimer);
        win.__reloadTimer = null;
      }
      if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate();
    });
    win.on('hide', () => {
      win.__hiddenSince = Date.now();
      // 隐藏够久就在后台重载一次（不显示窗口）：再打开时页面已经是热的，
      // 不用等它加载，也不会出现「窗口先出来、内容半天不画」。
      if (win.__reloadTimer) clearTimeout(win.__reloadTimer);
      win.__reloadTimer = setTimeout(() => {
        win.__reloadTimer = null;
        if (quitting || win.isDestroyed() || win.isVisible()) return;
        try {
          win.webContents.reload();
        } catch (error) {
          console.warn(`[main] 后台重载 ${name} 失败：${error && error.message ? error.message : error}`);
        }
      }, BACKGROUND_RELOAD_MS);
      win.__reloadTimer.unref?.();
    });
    // 渲染进程崩溃时窗口会整块空白；聊天窗自动重载一次，避免用户只能手动重启
    let crashReloads = 0;
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[main] ${name} 渲染进程退出：${details && details.reason ? details.reason : 'unknown'}`);
      if (name !== 'chat' || win.isDestroyed() || crashReloads >= 2) return;
      crashReloads += 1;
      setTimeout(() => {
        if (!win.isDestroyed()) win.reload();
      }, 300);
    });
    win.webContents.on('did-finish-load', () => {
      crashReloads = 0;
    });
  }

  // 所有窗口关闭 = 收起来（隐藏），不销毁：小人的「隐藏小人」、聊天窗的关窗都走这里。
  // 下次从托盘打开直接显示已有画面，不用重建窗口、重新加载页面。
  // 真正退出走托盘菜单「退出」（before-quit 置 quitting 放行）。
  win.on('close', (event) => {
    if (quitting || HEADLESS) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    if (windows[name] === win) windows[name] = null;
  });

  win.loadFile(HTML[name]).catch((error) => {
    console.error(`[main] 加载 ${name} 窗口失败：${error && error.message ? error.message : error}`);
  });

  if (isPet && !HEADLESS) {
    win.once('ready-to-show', () => win.showInactive());
  }

  // 桌面宠物要压在其他置顶窗口（比如终端）之上：用更高层级 + 运行时反复置顶
  if (isPet) {
    const raise = () => {
      if (!win || win.isDestroyed()) return;
      const latest = config.loadSettings(DATA_DIR);
      if (latest.ui.alwaysOnTop === false) return;
      win.setAlwaysOnTop(true, 'screen-saver');
      if (typeof win.moveTop === 'function') win.moveTop();
    };
    win.once('ready-to-show', raise);
    if (!HEADLESS) {
      const timer = setInterval(raise, 8000);
      timer.unref?.();
      win.once('closed', () => clearInterval(timer));
    }
  }

  return win;
}

/** 桌面快捷方式：没有就补一个，指向当前安装的 exe（覆盖安装后卸载器会删掉它） */
function ensureDesktopShortcut() {
  if (process.platform !== 'win32' || HEADLESS) return;
  try {
    const desktop = app.getPath('desktop');
    const target = process.execPath;
    const name = i18n.t('她');
    const lnk = path.join(desktop, `${name}.lnk`);
    const options = {
      target,
      cwd: path.dirname(target),
      icon: target,
      iconIndex: 0,
      description: i18n.t('桌面陪伴「她」'),
    };
    const exists = fs.existsSync(lnk);
    shell.writeShortcutLink(lnk, exists ? 'update' : 'create', options);
  } catch (error) {
    console.warn(`[main] 创建桌面快捷方式失败：${error && error.message ? error.message : error}`);
  }
}

function createAllWindows() {
  const settings = config.loadSettings(DATA_DIR);
  windows.pet = createWindow('pet', settings);
  // 聊天与设置窗口先建好但保持隐藏，等用户点开再显示（否则启动时会盖住小人）
  windows.chat = createWindow('chat', settings, { autoShow: false });
  windows.settings = createWindow('settings', settings, { autoShow: false });
}

function ensureWindow(name) {
  if (!Object.prototype.hasOwnProperty.call(windows, name)) throw new Error(`未知窗口：${name}`);
  if (windows[name] && !windows[name].isDestroyed()) return windows[name];
  windows[name] = createWindow(name, config.loadSettings(DATA_DIR));
  return windows[name];
}

function openWindow(name, options = {}) {
  const win = ensureWindow(name);
  if (!win || win.isDestroyed()) return;
  if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();

  let revealed = false;
  const reveal = () => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    if (name === 'pet') {
      win.showInactive();
      try {
        win.moveTop();
      } catch (error) {
        // 置顶失败不影响显示
      }
      if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate();
      if (typeof win.webContents.capturePage === 'function') win.webContents.capturePage().catch(() => {});
    } else {
      win.show();
      // 点托盘时窗口经常抢不到前台，直接开会停在别的窗口后面（看起来像没反应）。
      // 短暂置顶 + moveTop 把它顶到最前面，400ms 后恢复普通层级。
      try {
        win.moveTop();
        win.setAlwaysOnTop(true);
        const timer = setTimeout(() => {
          if (!win.isDestroyed()) win.setAlwaysOnTop(false);
        }, 400);
        timer.unref?.();
      } catch (error) {
        // 置顶失败不影响显示
      }
      win.focus();
      // 首帧还没画就 show() 时，窗口可能停在空白；补一次重绘并强制截一帧
      if (typeof win.webContents.invalidate === 'function') win.webContents.invalidate();
      if (typeof win.webContents.capturePage === 'function') {
        win.webContents.capturePage().catch(() => {});
      }
      // 窗口常驻后，隐藏期间来的消息不会自动进列表：打开时让渲染层重新拉一次历史
      if (name === 'chat') {
        try {
          win.webContents.send('chat:refresh');
        } catch (error) {
          // 页面还没加载好就算了，boot 会自己拉
        }
      }
    }
    // 从托盘浮层点某个角色：聊天窗显示后再切过去，避免页面还没加载时事件丢掉
    if (name === 'chat' && options && typeof options.characterId === 'string' && options.characterId) {
      try {
        win.webContents.send('chat:select', { characterId: options.characterId });
      } catch (error) {
        console.warn(`[main] 切换聊天角色失败：${error && error.message ? error.message : error}`);
      }
    }
  };

  // 窗口还在加载：等首帧准备好再显示，避免「先白后画」。
  // 长时间隐藏后的重载已经在 hide 时后台做掉了，这里不再 reload。
  if (typeof win.webContents.isLoadingMainFrame === 'function' && win.webContents.isLoadingMainFrame()) {
    win.once('ready-to-show', reveal);
    win.webContents.once('did-finish-load', reveal);
    const timer = setTimeout(reveal, 1500);
    timer.unref?.();
  } else {
    reveal();
  }
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

/** 托盘头像：取立绘上方正方形（头/上半身）再缩到 32×32，比整张全身图清楚。 */
function trayAvatarFromPath(framePath) {
  return trayIcon.avatarFromPath(framePath);
}

/** 在头像右下角画一个红点，闪烁时红点出现/消失。 */
function withTrayBadge(image) {
  return trayIcon.withBadge(image);
}

function updateTrayAvatar() {
  const latest = traySummary.items[0] || null;
  const key = latest ? `${latest.characterId}|${latest.avatarPath || ''}` : '';
  if (key === trayAvatarKey) return;
  trayAvatarKey = key;
  if (!trayIcons) return;
  trayIcons.avatar = null;
  trayIcons.avatarAlert = null;
  if (!latest || !latest.avatarPath) return;
  const base = trayAvatarFromPath(latest.avatarPath);
  if (!base) return;
  trayIcons.avatar = base;
  trayIcons.avatarAlert = withTrayBadge(base);
}

function refreshTrayNotifications() {
  if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return;
  try {
    traySummary = notifications.summarize(DATA_DIR, store.listCharacters(DATA_DIR));
  } catch (error) {
    console.warn(`[main] 汇总托盘未读失败：${error && error.message ? error.message : error}`);
    traySummary = { total: 0, items: [] };
  }

  if (traySummary.total <= 0) {
    stopTrayBlink();
    tray.setToolTip(i18n.t('她'));
    hideTrayPopup();
    return;
  }

  updateTrayAvatar();
  const lines = traySummary.items
    .slice(0, 5)
    .map((item) => i18n.t('{0}：{1} 条新消息', item.name, item.count));
  if (traySummary.items.length > 5) lines.push(i18n.t('还有 {0} 个角色…', traySummary.items.length - 5));
  tray.setToolTip(lines.join('\n') || i18n.t('她'));
  startTrayBlink();

  // 浮层正开着时，新消息 / 已读变化实时刷新
  if (trayPopup && !trayPopup.isDestroyed() && trayPopup.isVisible()) {
    try {
      trayPopup.webContents.send('tray:update', traySummary);
    } catch (error) {
      console.warn(`[main] 刷新托盘浮层失败：${error && error.message ? error.message : error}`);
    }
  }
}

function startTrayBlink() {
  if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed()) || !trayIcons) return;
  if (traySummary.total <= 0) return;

  if (trayBlinkTimer) {
    clearInterval(trayBlinkTimer);
    trayBlinkTimer = null;
  }

  const base = trayIcons.avatar || trayIcons.normal;
  const alert = trayIcons.avatarAlert || trayIcons.alert;
  // 聊天窗正在前台时不闪：消息已经直接看到了。但保持角色头像，别退回默认圆点。
  const chat = windows.chat;
  if (chat && !chat.isDestroyed() && chat.isFocused()) {
    tray.setImage(base);
    return;
  }

  tray.setImage(base);
  let on = false;
  trayBlinkTimer = setInterval(() => {
    if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) {
      stopTrayBlink();
      return;
    }
    on = !on;
    tray.setImage(on ? alert : base);
  }, 500);
  if (trayBlinkTimer && typeof trayBlinkTimer.unref === 'function') trayBlinkTimer.unref();
}

function stopTrayBlink() {
  if (trayBlinkTimer) {
    clearInterval(trayBlinkTimer);
    trayBlinkTimer = null;
  }
  if (tray && !(typeof tray.isDestroyed === 'function' && tray.isDestroyed()) && trayIcons) {
    tray.setImage(trayIcons.normal);
  }
}

// ---------------------------------------------------------------------------
// 托盘悬停浮层
// ---------------------------------------------------------------------------

function ensureTrayPopup() {
  if (trayPopup && !trayPopup.isDestroyed()) return trayPopup;
  trayPopup = new BrowserWindow({
    width: TRAY_POPUP_WIDTH,
    height: 150,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
    },
  });
  trayPopup.setMenuBarVisibility(false);
  trayPopup.setAlwaysOnTop(true, 'pop-up-menu');
  trayPopup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  trayPopup.webContents.on('will-navigate', (event, url) => {
    if (!isInsideRenderer(url)) event.preventDefault();
  });
  trayPopup.on('blur', () => {
    if (!trayPopupHovered) scheduleTrayPopupHide(180);
  });
  trayPopup.on('closed', () => {
    trayPopup = null;
    trayPopupWanted = false;
    trayPopupHovered = false;
  });
  trayPopup.loadFile(HTML.tray).catch((error) => {
    console.warn(`[main] 加载托盘浮层失败：${error && error.message ? error.message : error}`);
  });
  return trayPopup;
}

function trayPopupHeight(count) {
  return Math.min(TRAY_POPUP_MAX_HEIGHT, 54 + count * 52 + 42);
}

function positionTrayPopup(popup, point, height) {
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const x = Math.round(Math.min(
    Math.max(area.x + 8, point.x - TRAY_POPUP_WIDTH + 22),
    area.x + area.width - TRAY_POPUP_WIDTH - 8,
  ));
  const y = Math.round(Math.min(
    Math.max(area.y + 8, point.y - height - 10),
    area.y + area.height - height - 8,
  ));
  popup.setPosition(x, y);
}

function showTrayPopup(position) {
  if (!trayPopupWanted || traySummary.total <= 0 || traySummary.items.length === 0) return;
  const popup = ensureTrayPopup();
  if (!popup || popup.isDestroyed()) return;

  const point = position && Number.isFinite(position.x) && Number.isFinite(position.y)
    ? position
    : screen.getCursorScreenPoint();
  const height = trayPopupHeight(traySummary.items.length);
  popup.setSize(TRAY_POPUP_WIDTH, height);
  positionTrayPopup(popup, point, height);

  const reveal = () => {
    if (!trayPopupWanted || !trayPopup || trayPopup.isDestroyed()) return;
    try {
      trayPopup.webContents.send('tray:update', traySummary);
    } catch (error) {
      console.warn(`[main] 更新托盘浮层失败：${error && error.message ? error.message : error}`);
    }
    trayPopup.showInactive();
    trayPopup.setAlwaysOnTop(true, 'pop-up-menu');
  };

  if (popup.webContents.isLoadingMainFrame()) {
    if (!popup.__pendingShow) {
      popup.__pendingShow = true;
      popup.webContents.once('did-finish-load', () => {
        if (popup && !popup.isDestroyed()) popup.__pendingShow = false;
        if (trayPopupWanted) showTrayPopup(position);
      });
    }
    return;
  }
  reveal();
}

function scheduleTrayPopupShow(position) {
  if (traySummary.total <= 0) return;
  trayPopupWanted = true;
  if (trayHideTimer) {
    clearTimeout(trayHideTimer);
    trayHideTimer = null;
  }
  if (trayHoverTimer) clearTimeout(trayHoverTimer);
  const point = position && Number.isFinite(position.x) && Number.isFinite(position.y)
    ? position
    : screen.getCursorScreenPoint();
  trayHoverTimer = setTimeout(() => {
    trayHoverTimer = null;
    showTrayPopup(point);
  }, 180);
  trayHoverTimer.unref?.();
}

function scheduleTrayPopupHide(delay = 350) {
  if (!trayPopupWanted) return;
  if (trayHideTimer) clearTimeout(trayHideTimer);
  trayHideTimer = setTimeout(() => {
    trayHideTimer = null;
    if (trayPopupHovered) return;
    hideTrayPopup();
  }, delay);
  trayHideTimer.unref?.();
}

function hideTrayPopup() {
  trayPopupWanted = false;
  trayPopupHovered = false;
  if (trayHoverTimer) {
    clearTimeout(trayHoverTimer);
    trayHoverTimer = null;
  }
  if (trayHideTimer) {
    clearTimeout(trayHideTimer);
    trayHideTimer = null;
  }
  if (trayPopup && !trayPopup.isDestroyed() && trayPopup.isVisible()) trayPopup.hide();
}

/** 浮层里的鼠标进入/离开：进入时取消自动收起，离开后延时收起。 */
function setTrayPopupHover(inside) {
  trayPopupHovered = inside === true;
  if (trayPopupHovered) {
    trayPopupWanted = true;
    if (trayHideTimer) {
      clearTimeout(trayHideTimer);
      trayHideTimer = null;
    }
  } else {
    scheduleTrayPopupHide(250);
  }
}

function trayMenuTemplate() {
  return [
    { label: i18n.t('显示小人'), click: () => { hideTrayPopup(); openWindow('pet'); } },
    { label: i18n.t('打开聊天'), click: () => { hideTrayPopup(); openWindow('chat'); } },
    { label: i18n.t('设置'), click: () => { hideTrayPopup(); openWindow('settings'); } },
    { type: 'separator' },
    { label: i18n.t('退出'), click: () => app.quit() },
  ];
}

/**
 * 托盘右键菜单：显式弹出，不依赖 Windows 自动弹。
 * 部分 Win11 环境下 setContextMenu 不会在右键时自动出现，必须自己 popUpContextMenu。
 */
function showTrayMenu() {
  hideTrayPopup();
  if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return;
  try {
    tray.popUpContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  } catch (error) {
    console.warn(`[main] 弹出托盘菜单失败：${error && error.message ? error.message : error}`);
  }
}

/** 非 Windows 平台仍然用系统托盘菜单（Linux 上点击托盘必须靠它） */
function applyTrayContextMenu() {
  if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return;
  if (process.platform === 'win32') return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  } catch (error) {
    console.warn(`[main] 重建托盘菜单失败：${error && error.message ? error.message : error}`);
  }
}

function createTray() {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON}`);
  const alert = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ALERT_ICON}`);
  trayIcons = { normal: icon, alert, avatar: null, avatarAlert: null };
  trayAvatarKey = '';
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(i18n.t('她'));
  applyTrayContextMenu();
  tray.on('click', () => {
    hideTrayPopup();
    // 小人本来就常驻桌面，左键统一打开聊天窗才有明确反馈
    openWindow('chat');
  });
  tray.on('right-click', () => showTrayMenu());
  tray.on('mouse-enter', (_event, position) => {
    scheduleTrayPopupShow(position);
  });
  tray.on('mouse-leave', () => {
    scheduleTrayPopupHide(350);
  });

  refreshTrayNotifications();
}

// ---------------------------------------------------------------------------
// 过日子 tick：timeline 只读一次，改完统一写回
// ---------------------------------------------------------------------------

async function runTick(now = new Date()) {
  const settings = config.loadSettings(DATA_DIR);
  const character = activeCharacter(settings);
  if (!character) return;

  const profile = backgroundProfile(settings);
  let timeline = store.readTimeline(DATA_DIR, character.id);

  // 1) 当天日程（幂等；返回的是同一份 timeline 的最新快照）
  //    ensureSchedule 内部会先 settleDay（每天只结算一次）再抽样，返回结算后的状态
  const ensured = await life.ensureSchedule({
    dir: DATA_DIR, character, profile, settings, now,
  });
  if (ensured && ensured.timeline) timeline = ensured.timeline;
  let lifeState = ensured && ensured.state
    ? ensured.state
    : stateEngine.readState(DATA_DIR, character.id, now);

  // 2) 事件推进：在刚拿到的 timeline 上改，避免覆盖刚生成的日程
  if (settings.life.enabled !== false) {
    const advanced = life.advanceEvents({ timeline, now, character, dir: DATA_DIR });
    timeline = advanced.timeline;
    if (advanced.fired.length > 0) {
      broadcast('state:changed', { reason: 'events', characterId: character.id });
      // P3：按事件类别结算状态（外出/社交扣体力，居家少量恢复），一天只落盘一次
      const effects = advanced.fired
        .map((event) => life.eventStateEffect(event.category))
        .filter((effect) => Object.keys(effect).length > 0);
      if (effects.length > 0) {
        let nextState = lifeState;
        for (const effect of effects) {
          nextState = stateEngine.applyEvent(nextState, { ...effect, now });
        }
        lifeState = nextState;
        try {
          stateEngine.writeState(DATA_DIR, character.id, lifeState, now);
        } catch (error) {
          console.warn(`[main] 写入角色状态失败：${error && error.message ? error.message : error}`);
        }
      }
    }
  }

  const date = dayKey(now);
  let day = timeline.days[date];
  if (!day || typeof day !== 'object') {
    day = { schedule: [], events: [] };
    timeline.days[date] = day;
  }

  // 3) 主动消息：决策用同一份 day；runProactive 会就地改 day.proactive
  if (settings.life.enabled !== false) {
    let recentMessages = [];
    try {
      recentMessages = store.readMessages(DATA_DIR, character.id, { limit: 50 });
    } catch (error) {
      console.warn(`[main] 读取最近对话失败：${error && error.message ? error.message : error}`);
    }
    const lastUser = lastUserMessage(character.id, recentMessages);
    const previousDay = timeline.days[previousDayKeyOf(now)];
    const pick = life.pickProactive({
      day,
      now,
      settings,
      state: lifeState,
      lastUserAt: lastUser.at,
      lastUserText: lastUser.text,
      recentMessages,
      previousWeather: previousDay && typeof previousDay === 'object' ? previousDay.weather : null,
      character,
      startedAt,
      // 空档到了、但九类触发源都不成立时，也让她随口分享一句（由计划控制频率）
      allowLifeFallback: true,
    });
    if (pick) {
      try {
        const mem = store.readMemory(DATA_DIR, character.id);
        const message = await life.runProactive({
          character,
          now,
          day,
          trigger: pick.trigger,
          event: pick.event,
          meta: pick.meta,
          lastUserText: lastUser.text,
          recentMessages,
          memories: mem.cards,
          profile,
          settings,
          dir: DATA_DIR,
          state: lifeState,
        });
        timeline.days[date] = day;
        if (message) {
          widenPetForBubble();
          refreshTrayNotifications();
          broadcast('pet:bubble', {
            text: message.text,
            trigger: pick.trigger,
            messageId: message.id,
            characterId: character.id,
          });
          broadcast('state:changed', {
            reason: 'proactive',
            characterId: character.id,
            message,
          });
        }
      } catch (error) {
        console.warn(`[main] 主动消息失败：${error && error.message ? error.message : error}`);
      }
    }

    // 4) 当天日记（到点才写；传同一份 timeline，避免把事件/proactive 标记写丢）
    if (now.getHours() >= settings.life.diaryHour) {
      try {
        const recentChat = store.readMessages(DATA_DIR, character.id, { limit: 20 });
        const written = await life.writeDiary({
          dir: DATA_DIR,
          character,
          date,
          timeline,
          profile,
          settings,
          recentChat,
          now,
        });
        if (written && written.timeline) timeline = written.timeline;
        if (written && written.diary) {
          broadcast('state:changed', { reason: 'diary', characterId: character.id });
        }
      } catch (error) {
        console.warn(`[main] 写日记失败：${error && error.message ? error.message : error}`);
      }
    }

    // 4b) 补写漏掉的日记：额度/网络中断导致当天没写成，恢复后补前 2 天（每天最多 3 次）
    for (const offset of [1, 2]) {
      const catchDate = dayKey(new Date(now.getTime() - offset * 86400000));
      const catchDay = timeline.days[catchDate];
      if (!catchDay || catchDay.diary || catchDay.diaryDeleted) continue;
      if (!Array.isArray(catchDay.events) || catchDay.events.length === 0) continue;
      const catchTries = Number(catchDay.diaryTries) || 0;
      if (catchTries >= 3) continue;
      try {
        const written = await life.writeDiary({
          dir: DATA_DIR,
          character,
          date: catchDate,
          timeline,
          profile,
          settings,
          recentChat: [],
          now,
        });
        if (written && written.timeline) timeline = written.timeline;
        if (written && written.diary) {
          broadcast('state:changed', { reason: 'diary', characterId: character.id, date: catchDate });
        }
      } catch (error) {
        console.warn(`[main] 补写 ${catchDate} 日记失败：${error && error.message ? error.message : error}`);
      }
    }
  }

  // 5) 空闲抽取记忆：距最后一条用户消息满 N 分钟，且期间没抽过
  try {
    const mem = store.readMemory(DATA_DIR, character.id);
    const idle = shouldExtractIdle({
      lastUserAt: lastUserAt(character.id),
      lastExtractAt: mem.lastExtractedAt,
      now,
      idleMinutes: settings.memory.extractIdleMinutes,
    });
    if (idle) extractor(character.id);
  } catch (error) {
    console.warn(`[main] 空闲抽取判断失败：${error && error.message ? error.message : error}`);
  }

  // 统一写回一次（ensureSchedule / writeDiary 内部也写过，但都基于同一份 timeline）
  try {
    store.writeTimeline(DATA_DIR, character.id, store.pruneTimeline(timeline, 180));
  } catch (error) {
    console.warn(`[main] 写入 timeline 失败：${error && error.message ? error.message : error}`);
  }
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

const extractor = ipc.createExtractor({
  dir: DATA_DIR,
  config,
  store,
  memory,
  now: () => new Date(),
});

// ---------------------------------------------------------------------------
// 系统对话框 / 系统副作用（ipc.js 不 require electron，这里注入）
// ---------------------------------------------------------------------------

function dialogParent() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (windows.settings && !windows.settings.isDestroyed()) return windows.settings;
  return undefined;
}

/** 选择导出位置（数据 Tab「导出全部数据」），返回目录绝对路径或 null */
async function pickDirectory() {
  const win = dialogParent();
  const options = {
    title: i18n.t('选择导出位置'),
    buttonLabel: i18n.t('导出到这里'),
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
}

/** 选择一张本地 PNG（形象 Tab 的帧位上传），返回文件绝对路径或 null */
async function pickImage() {
  const win = dialogParent();
  const options = {
    title: i18n.t('选择透明背景 PNG'),
    buttonLabel: i18n.t('使用这张'),
    properties: ['openFile'],
    filters: [{ name: i18n.t('PNG 图片'), extensions: ['png'] }],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
}

/** 开机自启：写系统登录项（ui.autostart 是本地状态，系统 API 失败只告警不阻断保存） */
function applyAutostart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath });
  } catch (error) {
    console.warn(`[main] 设置开机自启失败：${error && error.message ? error.message : error}`);
  }
}

function applyLanguage(lang) {
  i18n.setLanguage(lang === 'en' ? 'en' : 'zh');
  if (tray && (typeof tray.isDestroyed !== 'function' || !tray.isDestroyed())) {
    // Windows 下菜单每次右键现建，语言切换自然生效；其他平台重建系统菜单
    applyTrayContextMenu();
    refreshTrayNotifications();
  }
  hideTrayPopup();
  // 聊天窗 / 小人窗直接重载：历史与草稿都不在页面状态里，重载最稳
  for (const name of ['chat', 'pet']) {
    const win = windows[name];
    if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed()) {
      try {
        win.webContents.reload();
      } catch (error) {
        console.warn(`[main] 重载 ${name} 失败：${error && error.message ? error.message : error}`);
      }
    }
  }
}

// 首次以打包版运行时，把内置内容复制到 data/content，方便之后直接改 JSON。
function ensureContentDir() {
  if (!CONTENT_OVERRIDE_DIR) return;
  try {
    if (fs.existsSync(CONTENT_OVERRIDE_DIR)) return;
    const src = path.join(__dirname, 'content');
    fs.mkdirSync(CONTENT_OVERRIDE_DIR, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (!name.endsWith('.json')) continue;
      fs.copyFileSync(path.join(src, name), path.join(CONTENT_OVERRIDE_DIR, name));
    }
  } catch (error) {
    console.warn(`[main] 初始化 content 目录失败：${error && error.message ? error.message : error}`);
  }
}

function setupIpc() {
  const handlers = ipc.createHandlers({
    dir: DATA_DIR,
    config,
    store,
    memory,
    usage,
    life,
    emit: broadcast,
    windows: {
      get: () => windows,
      open: openWindow,
    },
    onUnreadChanged: refreshTrayNotifications,
    onLanguageChanged: applyLanguage,
    trayPopup: { setHover: setTrayPopupHover },
    // 小人拖动钳制用：鼠标所在显示器的可用区域（多屏/缩放都跟随指针）
    workArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    openPath: (target) => shell.openPath(target),
    pickDirectory,
    pickImage,
    setAutostart: applyAutostart,
    isPackaged: app.isPackaged,
    quit: () => app.quit(),
    cursor: () => screen.getCursorScreenPoint(),
    bubbleWidth: () => Boolean(bubbleWidthState),
    now: () => new Date(),
  });
  ipc.register(ipcMain, handlers);
}

function setupScheduler() {
  scheduler = createScheduler({
    intervalMs: 60000,
    onTick: (now) => runTick(now),
  });
  scheduler.start();
  // 启动后先跑一次，补上停机期间漏掉的日程/事件
  setTimeout(() => scheduler && scheduler.tickOnce(), 3000);
}

function showExistingWindows() {
  // 第二个实例：聚焦已有聊天窗（没有就都拉起来）
  if (windows.chat && !windows.chat.isDestroyed()) {
    openWindow('chat');
    return;
  }
  for (const name of ['pet', 'chat']) openWindow(name);
}

// ---------------------------------------------------------------------------
// 自检 / 冒烟：只创建窗口并等加载完成，不弹托盘、不发通知
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 冒烟数据：演示角色 + 透明 idle 帧 + 两条示例消息（只写 data/smoke）
// ---------------------------------------------------------------------------

const SMOKE_CHARACTER = {
  name: '阿澜',
  persona: {
    traits: ['安静', '爱观察', '有点慢热'],
    speechStyle: '短句、口语、偶尔停顿，不劝人',
    catchphrases: ['嗯…', '我看看'],
    background: '住在杭州老城区，做陶，窗台上一盆快养不活的栀子',
    relationship: '认识很久的朋友，说话不用客套',
    boundaries: ['不编造没发生过的事', '不假装记得用户没说过的事'],
    likes: ['雨天', '旧唱片', '手冲咖啡'],
    dislikes: ['被催', '临时改计划'],
  },
  life: {
    city: '杭州',
    home: '老城区的小院',
    occupation: '陶艺师',
    hobbies: ['捏陶', '逛旧货市场'],
    tone: '松弛',
  },
};

/** CRC32 表（Node 20 的 zlib 还没有 zlib.crc32，自己算，避免依赖运行时版本） */
let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 内置 1×1 全透明 RGBA PNG（不读外部资源，保证冒烟在任何机器上都能跑） */
function onePixelTransparentPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colorType：RGBA，带 alpha
  const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0])); // filter 0 + RGBA(0,0,0,0)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function localStamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/**
 * 准备冒烟数据（幂等）：
 * - characters/ 为空时创建「阿澜」；
 * - 缺 idle.png 时写入内置 1×1 透明 PNG，并把 character.json 的 idle 帧指过去；
 * - chat.jsonl 为空时补一条 user + 一条 assistant，保证聊天窗有内容可截。
 */
function prepareSmokeData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let character = store.listCharacters(DATA_DIR)[0] || null;
  if (!character) {
    character = store.createCharacter(DATA_DIR, SMOKE_CHARACTER);
    console.log(`[smoke] 已创建演示角色：${character.name}（${character.id}）`);
  }

  const relPath = path.posix.join('assets', 'pack-default', 'idle.png');
  const frameFile = path.join(paths.charDir(DATA_DIR, character.id), relPath);
  if (!fs.existsSync(frameFile)) {
    fs.mkdirSync(path.dirname(frameFile), { recursive: true });
    fs.writeFileSync(frameFile, onePixelTransparentPng());
  }

  // 帧位直接写进 character.json：冒烟文件本来就是内置占位图，不必过 importFrame 的像素校验
  const appearance = character.appearance && typeof character.appearance === 'object'
    ? character.appearance
    : {};
  const packs = Array.isArray(appearance.packs) ? appearance.packs.slice() : [];
  const activePackId = typeof appearance.activePack === 'string' && appearance.activePack
    ? appearance.activePack
    : 'default';
  let packIndex = packs.findIndex((item) => item && item.id === activePackId);
  if (packIndex < 0) {
    packs.push({ id: activePackId, name: '常服', frames: {} });
    packIndex = packs.length - 1;
  }
  const pack = packs[packIndex];
  const frames = pack.frames && typeof pack.frames === 'object' ? pack.frames : {};
  if (frames.idle !== relPath) {
    packs[packIndex] = { ...pack, frames: { ...frames, idle: relPath } };
    character = store.saveCharacter(DATA_DIR, {
      ...character,
      appearance: { ...appearance, activePack: activePackId, packs },
    });
  }

  // 演示数据直接跳过引导，截图里展示的是正常聊天/设置界面（引导另有手工检查文档）
  config.saveSettings(DATA_DIR, { activeCharacterId: character.id, onboarded: true });

  const messages = store.readMessages(DATA_DIR, character.id, { limit: 1 });
  if (messages.length === 0) {
    const stamp = localStamp(new Date());
    store.appendMessage(DATA_DIR, character.id, {
      id: `msg-smoke-${Date.now()}-user`,
      role: 'user',
      text: '今天风挺大的，你那边呢？',
      ts: stamp,
      unread: false,
      proactive: false,
    });
    store.appendMessage(DATA_DIR, character.id, {
      id: `msg-smoke-${Date.now()}-assistant`,
      role: 'assistant',
      text: '嗯…窗关小了一半，桌上的纸被吹跑了一张。',
      ts: stamp,
      mood: '平静',
      tokens: 18,
      unread: false,
      proactive: false,
    });
  }

  return character;
}

// ---------------------------------------------------------------------------
// 冒烟截图
// ---------------------------------------------------------------------------

const SMOKE_SHOTS = [
  { name: 'pet', file: 'smoke-pet.png', label: '小人窗' },
  { name: 'chat', file: 'smoke-chat.png', label: '聊天窗', size: { width: 1100, height: 720 } },
  { name: 'settings', file: 'smoke-settings.png', label: '设置窗', size: { width: 1100, height: 720 } },
];

/** 等小人窗把演示帧真正挂到 <img> 上（证明截图不是「窗口没加载」，只是图本身是 1×1 透明） */
async function waitForPetFrame() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await windows.pet.webContents.executeJavaScript(`(() => {
      const img = document.getElementById('pet');
      return {
        src: img && img.getAttribute('src') ? img.getAttribute('src') : '',
        width: img ? img.naturalWidth : 0,
        height: img ? img.naturalHeight : 0,
      };
    })()`);
    if (info && typeof info.src === 'string' && info.src.startsWith('file:')) return info;
    await delay(100);
  }
  return null;
}

async function captureSmokeShots() {
  const saved = [];
  for (const shot of SMOKE_SHOTS) {
    const win = windows[shot.name];
    if (!win || win.isDestroyed()) throw new Error(`${shot.label}不存在`);

    if (shot.name === 'pet') {
      const info = await waitForPetFrame();
      if (!info) throw new Error('小人窗没有加载到立绘帧');
      console.log(`[smoke] 小人窗立绘已加载：${info.width}×${info.height}`);
    }

    if (shot.size) {
      win.setContentSize(shot.size.width, shot.size.height);
      // 等一次布局/重绘，避免截到调整尺寸前的旧画面
      await delay(500);
    } else {
      await delay(400);
    }

    const image = await win.webContents.capturePage();
    if (!image || image.isEmpty()) throw new Error(`${shot.label}截图是空的`);

    const file = path.join(DATA_DIR, shot.file);
    fs.writeFileSync(file, image.toPNG());
    const size = image.getSize();
    saved.push({
      file,
      width: size.width,
      height: size.height,
      bytes: fs.statSync(file).size,
    });
  }
  return saved;
}

function runSmoke() {
  let settled = false;
  let remaining = 3;

  const finish = (code, message) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0) console.log(`[smoke] ${message}`);
    else console.error(`[smoke] ${message}`);
    app.exit(code);
  };

  const timer = setTimeout(() => {
    finish(1, `超时：${SMOKE_TIMEOUT_MS / 1000} 秒内没有完成三窗口截图`);
  }, SMOKE_TIMEOUT_MS);

  const names = ['pet', 'chat', 'settings'];
  for (const name of names) {
    const win = windows[name];
    if (!win || win.isDestroyed()) {
      finish(1, `${name} 窗口没有创建成功`);
      return;
    }

    win.webContents.once('did-finish-load', () => {
      remaining -= 1;
      if (remaining > 0) return;
      captureSmokeShots().then(
        (saved) => {
          const detail = saved
            .map((item) => `${item.file} (${item.width}×${item.height}, ${item.bytes} 字节)`)
            .join('，');
          finish(0, `截图已保存: ${detail}`);
        },
        (error) => {
          finish(1, `截图失败：${error && error.message ? error.message : error}`);
        },
      );
    });
    win.webContents.once('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame === false) return;
      finish(1, `${name} 加载失败：${code} ${description} ${url}`);
    });
    win.webContents.once('render-process-gone', (_event, details) => {
      finish(1, `${name} 渲染进程退出：${details && details.reason ? details.reason : 'unknown'}`);
    });
  }
}

/**
 * 行为级验证 preload：
 *   1) on 注册后能收到一次 state:changed；
 *   2) off 之后主进程再发，不能收到；
 *   3) invoke 仍可用且设置已脱敏（同时验证 senderFrame 白名单放行本应用页面）。
 */
async function verifyPreload(name, win) {
  const injected = await win.webContents.executeJavaScript(`(() => {
    window.__sheProbe = { count: 0 };
    window.api.on('state:changed', () => { window.__sheProbe.count += 1; });
    return 'ok';
  })()`);
  if (injected !== 'ok') throw new Error('注入 preload 探针失败');

  win.webContents.send('state:changed', { probe: 1 });
  await delay(120);

  const beforeOff = await win.webContents.executeJavaScript(`(() => {
    const count = window.__sheProbe.count;
    window.api.off('state:changed');
    return count;
  })()`);
  if (beforeOff !== 1) throw new Error(`on 没收到事件（收到 ${beforeOff} 次）`);

  win.webContents.send('state:changed', { probe: 2 });
  await delay(120);
  const afterOff = await win.webContents.executeJavaScript('window.__sheProbe.count');
  if (afterOff !== 1) throw new Error(`off 之后仍收到事件（共 ${afterOff} 次）`);

  const invoked = await win.webContents.executeJavaScript(`window.api.invoke('settings:get').then((s) => {
    const profile = s && s.api && Array.isArray(s.api.profiles) ? s.api.profiles[0] : null;
    return Boolean(profile) && !Object.prototype.hasOwnProperty.call(profile, 'apiKey');
  })`);
  if (invoked !== true) throw new Error('invoke settings:get 失败或结果未脱敏');

  return true;
}

function runHeadless(verify) {
  const label = MODE;
  let settled = false;
  let remaining = 0;

  const finish = (code, message) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0) console.log(`[${label}] ${message}`);
    else console.error(`[${label}] ${message}`);
    app.exit(code);
  };

  const timer = setTimeout(() => {
    finish(1, `超时：${MODE_TIMEOUT_MS / 1000}s 内三个窗口没有全部加载完成`);
  }, MODE_TIMEOUT_MS);

  const names = ['pet', 'chat', 'settings'];
  remaining = names.length;

  for (const name of names) {
    const win = windows[name];
    if (!win || win.isDestroyed()) {
      finish(1, `${name} 窗口没有创建成功`);
      return;
    }
    win.webContents.once('did-finish-load', async () => {
      console.log(`[${label}] ${name} 加载完成`);
      if (verify) {
        try {
          await verify(name, win);
          console.log(`[${label}] ${name} preload on/off 断言通过`);
        } catch (error) {
          finish(1, `${name} preload 断言失败：${error && error.message ? error.message : error}`);
          return;
        }
      }
      remaining -= 1;
      if (remaining === 0) {
        finish(0, verify ? '三个窗口加载完成，preload on/off 断言全部通过' : '三个窗口加载完成');
      }
    });
    win.webContents.once('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame === false) return;
      finish(1, `${name} 加载失败：${code} ${description} ${url}`);
    });
    win.webContents.once('render-process-gone', (_event, details) => {
      finish(1, `${name} 渲染进程退出：${details && details.reason ? details.reason : 'unknown'}`);
    });
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = HEADLESS ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  if (!HEADLESS) app.on('second-instance', showExistingWindows);

  app.whenReady().then(() => {
    startedAt = new Date();
    ensureContentDir();

    // 语言必须在建窗口 / 建托盘之前定下来，托盘菜单与系统对话框都读这份状态
    try {
      i18n.setLanguage(config.loadSettings(DATA_DIR).ui.language);
    } catch (error) {
      i18n.setLanguage('zh');
    }

    if (MODE === 'smoke') {
      try {
        const character = prepareSmokeData();
        console.log(`[smoke] 演示数据：${DATA_DIR}（角色：${character.name}）`);
      } catch (error) {
        console.error(`[smoke] 准备演示数据失败：${error && error.message ? error.message : error}`);
        app.exit(1);
        return;
      }
    }

    registerAssetProtocol();
    createAllWindows();
    setupIpc();
    ensureDesktopShortcut();

    // 开机自启以设置里的 ui.autostart 为准（主进程启动时对齐一次系统登录项）
    if (MODE === 'run') applyAutostart(config.loadSettings(DATA_DIR).ui.autostart);

    // 拔显示器 / 改分辨率后把小人窗拉回最近的可用区域
    screen.on('display-removed', reclampPetWindow);
    screen.on('display-metrics-changed', reclampPetWindow);

    if (MODE === 'selftest') {
      runHeadless(verifyPreload);
      return;
    }
    if (MODE === 'smoke') {
      runSmoke();
      return;
    }

    createTray();
    setupScheduler();
  }).catch((error) => {
    console.error(`[main] 启动失败：${error && error.message ? error.message : error}`);
    if (HEADLESS) app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (!HEADLESS) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (scheduler) scheduler.stop();
    stopTrayBlink();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  // Windows 关机 / 注销时不会再走 before-quit，必须放行 close，否则会卡住关机
  app.on('session-end', () => {
    quitting = true;
  });
}
