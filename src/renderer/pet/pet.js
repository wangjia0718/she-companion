'use strict';

// 小人窗渲染层（经典 script，不用 module；只经 preload 暴露的 window.api 通主进程）。
//
// 职责（Task 10 / Spec 10.1）：
//   1. 透明背景 + 按角色 appearance.packs[activePack].frames 显示立绘，缺图用内联 SVG 占位；
//   2. 呼吸 / 轻摆 / 有 sleepy 帧时 4–8 秒随机眨眼；
//   3. 鼠标穿透：默认开启，按指针是否落在立绘 alpha 上临时关闭；读不到 alpha 时整窗可点；
//   4. 拖动：按住移动、松手保存 petPos（主进程用 geometry.clampPetPos 钳制在 workArea 内）；
//   5. 单击开聊天、双击开设置、右键自定义菜单（聊天 / 换个样子 / 看她今天 / 设置 / 隐藏）；
//   6. 气泡：收到 pet:bubble 显示 12 秒，点一下进聊天并告诉主进程已读；
//   7. 形象包切换写回 characters:save；
//   8. 无角色 / 加载失败：占位图 + 提示，点提示直接去设置。

(function () {
  const API = window.api || null;

  // 内置占位立绘：内联 SVG data URI（不引用任何外部文件 / 网络资源）
  const PLACEHOLDER_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 380">',
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#F3E4D3"/><stop offset="1" stop-color="#E7D3BE"/>',
    '</linearGradient></defs>',
    '<ellipse cx="110" cy="366" rx="62" ry="8" fill="#3A322C" opacity="0.06"/>',
    '<path d="M110 46c22 0 36 17 36 39 0 12-4 21-11 28 20 9 33 27 37 52 4 26 6 52 6 79H42c0-27 2-53 6-79 4-25 17-43 37-52-7-7-11-16-11-28 0-22 14-39 36-39z" fill="url(#g)" stroke="#DCC4AB" stroke-width="2"/>',
    '<circle cx="96" cy="86" r="3.2" fill="#8A7E74"/>',
    '<circle cx="124" cy="86" r="3.2" fill="#8A7E74"/>',
    '<path d="M102 100c5 4 11 4 16 0" stroke="#B08E72" stroke-width="2.4" fill="none" stroke-linecap="round"/>',
    '<path d="M52 246c14-11 32-16 58-16s44 5 58 16" stroke="#D9BE9F" stroke-width="2" fill="none" opacity="0.85"/>',
    '</svg>',
  ].join('');
  const PLACEHOLDER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PLACEHOLDER_SVG)}`;

  const BUBBLE_SPACE = 96; // 与 pet.css 的 --bubble-space 一致
  const BUBBLE_MS = 12000;
  const BLINK_MIN_MS = 4000;
  const BLINK_MAX_MS = 8000;
  const BLINK_HOLD_MS = 140;
  // 与 Windows 默认双击间隔（500ms）齐平：小于它时，间隔 320ms 的双击会先开聊天
  const CLICK_DELAY_MS = 500;
  const DRAG_THRESHOLD = 3;
  const DEFAULT_SIZE = { width: 220, height: 380 };
  const HINT_TEXT = '先到设置里传一张立绘';

  const els = {
    img: document.getElementById('pet'),
    flip: document.getElementById('flip'),
    bubble: document.getElementById('bubble'),
    hint: document.getElementById('hint'),
    menu: document.getElementById('menu'),
    wave: document.getElementById('wave'),
    live2d: document.getElementById('live2d'),
  };

  const Voice = window.SheVoice || null;
  if (Voice && typeof Voice.bindWave === 'function') Voice.bindWave(els.wave);
  const Live2DModel = window.PetLive2D || null;

  const state = {
    character: null,
    frames: {},
    idleUrl: '',
    sleepyUrl: '',
    currentSrc: '',
    scale: 1,
    clickThrough: true,
    flip: false,
    isPlaceholder: true,
    alpha: null, // 立绘 RGBA 像素（离屏 canvas 读出来）
    alphaW: 0,
    alphaH: 0,
    alphaBroken: false, // canvas 读取失败 → 退化为整窗可点
    ignore: null, // 当前鼠标穿透状态
    dragging: false,
    dragMoved: false,
    dragStart: null,
    winStart: null,
    lastScreen: null,
    lastTarget: null,
    target: null,
    moving: false,
    menuOpen: false,
    bubbleTimer: null,
    blinkTimer: null,
    appliedSize: null,
    live2dOn: false,
    live2dUrl: '',
    live2dFailed: '',
    mouthRaf: 0,
  };

  // -------------------------------------------------------------------------
  // 与主进程通信
  // -------------------------------------------------------------------------

  function call(channel, payload) {
    if (!API) return Promise.resolve(null);
    try {
      return Promise.resolve(API.invoke(channel, payload)).catch((error) => {
        console.warn(`[pet] ${channel} 失败：${error && error.message ? error.message : error}`);
        return null;
      });
    } catch (error) {
      console.warn(`[pet] 调用 ${channel} 出错：${error && error.message ? error.message : error}`);
      return Promise.resolve(null);
    }
  }

  function openWindow(target) {
    return call('window:open', { target });
  }

  // 单击延迟 500ms 才开聊天；双击第二下（detail>1）撤销排队，只开设置（见 pet-click.js）
  const PetClick = window.PetClick && typeof window.PetClick === 'object' ? window.PetClick : null;
  const clickGate = PetClick && typeof PetClick.createClickGate === 'function'
    ? PetClick.createClickGate({
      delay: CLICK_DELAY_MS,
      onSingle: () => openWindow('chat'),
    })
    : {
      // 兜底：脚本没加载到时退化为「单击立刻开聊天」，至少不影响双击
      pointerUp(event) {
        const source = event && typeof event === 'object' ? event : {};
        if (source.dragMoved) return 'drag';
        if (Number.isFinite(source.detail) && source.detail > 1) return 'superseded';
        openWindow('chat');
        return 'queued';
      },
      cancel() { return false; },
    };

  // -------------------------------------------------------------------------
  // 立绘 / 占位
  // -------------------------------------------------------------------------

  function showFrame(src) {
    state.isPlaceholder = false;
    els.hint.hidden = true;
    els.img.classList.remove('is-placeholder');

    if (state.currentSrc === src && els.img.complete && els.img.naturalWidth > 0) {
      fitWindow();
      scheduleBlink();
      return;
    }
    state.currentSrc = src;
    state.alpha = null;
    state.alphaW = 0;
    state.alphaH = 0;
    els.img.src = src;
  }

  function showPlaceholder() {
    state.isPlaceholder = true;
    state.alpha = null;
    state.alphaW = 0;
    state.alphaH = 0;
    state.alphaBroken = false;
    stopBlink();

    if (state.currentSrc !== PLACEHOLDER) {
      state.currentSrc = PLACEHOLDER;
      els.img.classList.add('is-placeholder');
      els.img.src = PLACEHOLDER;
    }
    els.hint.hidden = false;
    els.hint.textContent = HINT_TEXT;

    // 占位时回到默认窗口尺寸，别把上一张立绘的尺寸留着
    const previous = state.appliedSize;
    state.appliedSize = { ...DEFAULT_SIZE };
    if (
      !previous
      || previous.width !== DEFAULT_SIZE.width
      || previous.height !== DEFAULT_SIZE.height
    ) {
      call('pet:scale', { scale: state.scale, size: { ...DEFAULT_SIZE } });
    }
    // 没有 alpha 可判 → 整窗可点（否则提示点不到）
    applyIgnore(false);
  }

  /** 窗口尺寸 = 立绘宽 × petScale；高度额外留出顶部气泡的位置（气泡空间随缩放同步） */
  function fitWindow() {
    if (state.live2dOn) return; // Live2D 的尺寸由 applyLive2DSize 管
    if (state.isPlaceholder || !state.idleUrl) return;
    const width = els.img.naturalWidth;
    const height = els.img.naturalHeight;
    if (!width || !height) return;
    const bubble = Math.max(48, Math.round(BUBBLE_SPACE * Math.max(0.3, state.scale)));
    // CSS 里图片高度是 calc(100% - var(--bubble-space))，必须同步改，否则小尺寸会把人物裁掉
    document.documentElement.style.setProperty('--bubble-space', `${bubble}px`);
    // 直接写死图片像素高度，避免百分比在某些缩放下解析成整张原图高度
    els.img.style.height = `${Math.round(height * state.scale)}px`;
    els.img.style.width = 'auto';
    const next = {
      width: Math.max(60, Math.round(width * state.scale)),
      height: Math.max(60, Math.round(height * state.scale)) + bubble,
    };
    if (state.appliedSize && state.appliedSize.width === next.width && state.appliedSize.height === next.height) {
      return;
    }
    state.appliedSize = next;
    call('pet:scale', { scale: state.scale, size: next });
  }

  /** 把立绘画进离屏 canvas，缓存 alpha 用于命中判断（跨域/解码失败则退化） */
  function buildAlpha() {
    state.alpha = null;
    state.alphaW = 0;
    state.alphaH = 0;
    state.alphaBroken = false;

    const width = els.img.naturalWidth;
    const height = els.img.naturalHeight;
    if (!width || !height) {
      state.alphaBroken = true;
      applyIgnore(false);
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('拿不到 2d context');
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(els.img, 0, 0);
      const data = ctx.getImageData(0, 0, width, height).data;
      state.alpha = data;
      state.alphaW = width;
      state.alphaH = height;
    } catch (error) {
      // 跨域 / 解码失败：不能因为读不到像素就把人卡死 → 整窗可点
      console.warn(`[pet] 读取立绘 alpha 失败，退化为整窗可点：${error && error.message ? error.message : error}`);
      state.alpha = null;
      state.alphaBroken = true;
      applyIgnore(false);
    }
  }

  function isOver(element, event) {
    if (!element || element.hidden) return false;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  function isOverUi(event) {
    return isOver(els.bubble, event) || isOver(els.hint, event) || isOver(els.menu, event);
  }

  /** 指针是否落在立绘不透明像素上（alpha > 10） */
  function alphaHit(event) {
    if (state.isPlaceholder) return true;
    if (state.alphaBroken || !state.alpha) return true; // 退化：整窗可点

    const rect = els.img.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    if (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom) {
      return false;
    }
    const px = Math.floor(((event.clientX - rect.left) / rect.width) * state.alphaW);
    const py = Math.floor(((event.clientY - rect.top) / rect.height) * state.alphaH);
    const x = Math.min(state.alphaW - 1, Math.max(0, px));
    const y = Math.min(state.alphaH - 1, Math.max(0, py));
    return state.alpha[(y * state.alphaW + x) * 4 + 3] > 10;
  }

  // -------------------------------------------------------------------------
  // 鼠标穿透
  // -------------------------------------------------------------------------

  function applyIgnore(ignore) {
    if (!state.clickThrough) {
      // 设置里关了穿透：整窗可点，不再来回切
      if (state.ignore !== false) {
        state.ignore = false;
        call('pet:setIgnore', false);
      }
      return;
    }
    if (state.ignore === ignore) return;
    state.ignore = ignore;
    call('pet:setIgnore', ignore);
  }

  function refreshIgnore(event) {
    if (!state.clickThrough) {
      applyIgnore(false);
      return;
    }
    if (state.alphaBroken) {
      applyIgnore(false);
      return;
    }
    const hit = isOverUi(event) || alphaHit(event);
    applyIgnore(!hit);
  }

  // -------------------------------------------------------------------------
  // 拖动
  // -------------------------------------------------------------------------

  function onMouseDown(event) {
    if (!els.menu.hidden) {
      if (isOver(els.menu, event)) return; // 菜单自己处理点击
      hideMenu();
      return;
    }
    if (event.button !== 0) return;
    if (isOverUi(event)) return;
    // 关闭穿透时整窗可点（不再要求点在立绘的 alpha 上）；
    // 开启穿透时仍用 alpha 判断，避免透明区域抢鼠标。
    if (state.clickThrough && !alphaHit(event)) return;

    // 按下即取消排队中的单击：避免「点一下 → 立刻拖动」时聊天窗在拖动途中弹出
    if (typeof clickGate !== 'undefined' && clickGate && typeof clickGate.cancel === 'function') {
      clickGate.cancel();
    }

    state.dragging = true;
    state.dragMoved = false;
    state.dragStart = { screenX: event.screenX, screenY: event.screenY };
    // screenX - clientX 就是窗口左上角（无边框窗的内容区 = 窗口）
    state.winStart = {
      x: Math.round(event.screenX - event.clientX),
      y: Math.round(event.screenY - event.clientY),
    };
    state.lastScreen = { x: event.screenX, y: event.screenY };
    state.lastTarget = { ...state.winStart };
    state.target = null;
    applyIgnore(false);
    event.preventDefault();
  }

  function onMouseMove(event) {
    if (state.dragging) {
      const dx = event.screenX - state.dragStart.screenX;
      const dy = event.screenY - state.dragStart.screenY;
      if (!state.dragMoved) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        state.dragMoved = true;
      }
      state.lastScreen = { x: event.screenX, y: event.screenY };
      state.lastTarget = { x: state.winStart.x + dx, y: state.winStart.y + dy };
      queueMove();
      return;
    }
    if (state.menuOpen) {
      applyIgnore(false);
      return;
    }
    refreshIgnore(event);
  }

  function queueMove() {
    if (!state.target && state.lastTarget) state.target = state.lastTarget;
    if (state.moving || !state.target) return;
    flushMove();
  }

  async function flushMove() {
    if (state.moving || !state.target) return;
    state.moving = true;
    const point = state.target;
    state.target = null;
    // 拖动过程只动窗口不写盘（commit:false），松手才保存
    const applied = await call('pet:move', { x: point.x, y: point.y, clamp: true, commit: false });
    state.moving = false;

    if (
      state.dragging
      && applied
      && Number.isFinite(applied.x)
      && Number.isFinite(applied.y)
      && state.lastScreen
    ) {
      // 被屏幕边缘钳制后修正拖动起点，避免继续拖时「粘」在边上
      state.winStart = {
        x: applied.x - (state.lastScreen.x - state.dragStart.screenX),
        y: applied.y - (state.lastScreen.y - state.dragStart.screenY),
      };
    }
    if (state.target) flushMove();
  }

  function onMouseUp(event) {
    if (!state.dragging) return;
    state.dragging = false;
    state.target = null;

    if (state.dragMoved && state.lastTarget) {
      // 松手：带 clamp（主进程 workArea 内留 8px）并写回 settings.ui.petPos
      call('pet:move', { x: state.lastTarget.x, y: state.lastTarget.y, clamp: true });
    } else {
      // 单击排队；双击的第二下（detail > 1）会在这里撤销排队，只等 dblclick 开设置
      clickGate.pointerUp({ detail: event.detail, dragMoved: false });
    }

    refreshIgnore(event);
  }

  function onDoubleClick(event) {
    if (!els.menu.hidden) return;
    if (isOverUi(event)) return;
    if (!alphaHit(event)) return;
    clickGate.cancel();
    openWindow('settings');
  }

  // -------------------------------------------------------------------------
  // 右键自定义菜单
  // -------------------------------------------------------------------------

  function menuItem(label, onClick, options = {}) {
    const item = document.createElement('div');
    item.className = 'menu-item';
    item.setAttribute('role', 'menuitem');
    if (options.current) item.classList.add('is-current');
    if (options.disabled) item.setAttribute('aria-disabled', 'true');

    const check = document.createElement('span');
    check.className = 'menu-check';
    check.textContent = options.current ? '✓' : '';
    item.appendChild(check);

    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);

    if (!options.disabled) {
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        hideMenu();
        onClick();
      });
    }
    return item;
  }

  function menuSeparator() {
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    return sep;
  }

  function menuLabel(text) {
    const label = document.createElement('div');
    label.className = 'menu-label';
    label.textContent = text;
    return label;
  }

  function showMenu(x, y) {
    const menu = els.menu;
    menu.textContent = '';

    const character = state.character;
    const appearance = character && character.appearance && typeof character.appearance === 'object'
      ? character.appearance
      : {};
    const packs = Array.isArray(appearance.packs) ? appearance.packs : [];

    menu.appendChild(menuItem('聊天', () => openWindow('chat')));

    menu.appendChild(menuSeparator());
    menu.appendChild(menuLabel('换个样子'));
    if (packs.length === 0) {
      menu.appendChild(menuItem('还没有形象包', () => {}, { disabled: true }));
    } else {
      for (const pack of packs) {
        if (!pack || typeof pack.id !== 'string' || pack.id === '') continue;
        const name = typeof pack.name === 'string' && pack.name ? pack.name : pack.id;
        menu.appendChild(menuItem(name, () => switchPack(pack.id), {
          current: pack.id === appearance.activePack,
        }));
      }
    }

    menu.appendChild(menuSeparator());
    menu.appendChild(menuItem('看她今天', () => openWindow('chat')));
    menu.appendChild(menuItem('设置', () => openWindow('settings')));
    menu.appendChild(menuItem('隐藏', () => hidePet()));
    menu.appendChild(menuSeparator());
    menu.appendChild(menuItem('退出', () => call('app:quit')));

    menu.hidden = false;
    state.menuOpen = true;
    startMenuGuard();

    // 贴边时往窗内收，别让菜单跑出窗口
    const rect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    applyIgnore(false);
  }

  function hideMenu() {
    if (els.menu.hidden) return;
    els.menu.hidden = true;
    state.menuOpen = false;
    stopMenuGuard();
  }

  // 自定义菜单收不到「窗口外」的点击，用指针位置兜底：离开小窗就收起
  let menuGuardTimer = null;

  function stopMenuGuard() {
    if (menuGuardTimer) {
      clearInterval(menuGuardTimer);
      menuGuardTimer = null;
    }
  }

  function startMenuGuard() {
    stopMenuGuard();
    menuGuardTimer = setInterval(async () => {
      if (!state.menuOpen) {
        stopMenuGuard();
        return;
      }
      try {
        const info = await call('pet:cursorInside');
        if (info && info.inside === false) hideMenu();
      } catch {
        // 查询失败就保持现状，不影响使用
      }
    }, 150);
  }

  async function switchPack(packId) {
    const character = state.character;
    if (!character || !character.appearance) return;
    if (character.appearance.activePack === packId) return;
    const next = {
      ...character,
      appearance: { ...character.appearance, activePack: packId },
    };
    await call('characters:save', next);
    await refresh();
  }

  function hidePet() {
    // 「隐藏小人」：关掉这个窗（托盘「显示小人」会按已保存的 petPos 重新创建）
    window.close();
  }

  // -------------------------------------------------------------------------
  // 气泡
  // -------------------------------------------------------------------------

  function showBubble(text, options = {}) {
    els.bubble.textContent = text;
    els.bubble.hidden = false;
    clearTimeout(state.bubbleTimer);
    state.bubbleTimer = setTimeout(() => {
      state.bubbleTimer = null;
      els.bubble.hidden = true;
    }, BUBBLE_MS);
    applyIgnore(false);
    // 只有新到的那条才念（设置里可关：voice.inBubble）；
    // 刷新时把「还挂着的气泡」重画一遍不能重复出声。
    if (options.speak === false) return;
    if (Voice && typeof Voice.say === 'function') Voice.say(text, { kind: 'bubble' });
  }

  function hideBubble() {
    clearTimeout(state.bubbleTimer);
    state.bubbleTimer = null;
    els.bubble.hidden = true;
  }

  // -------------------------------------------------------------------------
  // 眨眼
  // -------------------------------------------------------------------------

  function stopBlink() {
    clearTimeout(state.blinkTimer);
    state.blinkTimer = null;
  }

  function scheduleBlink() {
    stopBlink();
    if (state.isPlaceholder || !state.sleepyUrl || !state.idleUrl) return;
    const delay = BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
    state.blinkTimer = setTimeout(blink, delay);
  }

  function blink() {
    state.blinkTimer = null;
    if (state.isPlaceholder || !state.sleepyUrl || !state.idleUrl) return;
    const restore = state.idleUrl;
    state.blinkRestore = restore;
    els.img.src = state.sleepyUrl;
    setTimeout(() => {
      if (state.isPlaceholder) return;
      if (state.idleUrl === restore) els.img.src = restore;
      scheduleBlink();
    }, BLINK_HOLD_MS);
  }

  // -------------------------------------------------------------------------
  // 与主进程同步状态
  // -------------------------------------------------------------------------

  function applyState(info) {
    const data = info && typeof info === 'object' ? info : {};
    state.character = data.character || null;
    state.frames = data.frames && typeof data.frames === 'object' ? data.frames : {};
    state.idleUrl = typeof state.frames.idle === 'string' ? state.frames.idle : '';
    state.sleepyUrl = typeof state.frames.sleepy === 'string' ? state.frames.sleepy : '';

    const scale = Number(data.scale);
    state.scale = Number.isFinite(scale) ? Math.min(2, Math.max(0.2, scale)) : 1;
    state.clickThrough = data.clickThrough !== false;
    state.flip = data.flip === true;
    if (els.flip) els.flip.classList.toggle('is-flipped', state.flip);

    if (data.bubble && typeof data.bubble.text === 'string' && data.bubble.text) {
      // 刷新时只把还挂着的气泡画回来，不重复出声（新气泡走 pet:bubble 事件）
      showBubble(data.bubble.text, { speak: false });
    }

    // Live2D 形象包：有模型就上模型，读不到再退回静态立绘
    const live2dUrl = typeof data.live2d === 'string' ? data.live2d : '';
    if (live2dUrl && live2dUrl !== state.live2dFailed) {
      if (enterLive2D(live2dUrl, data.live2dSize, state.scale)) {
        if (!state.clickThrough) applyIgnore(false);
        return;
      }
    }
    exitLive2D();

    if (state.character && state.idleUrl) showFrame(state.idleUrl);
    else showPlaceholder();

    if (!state.clickThrough) applyIgnore(false);
  }

  // -------------------------------------------------------------------------
  // Live2D
  // -------------------------------------------------------------------------

  function applyLive2DSize(size, scale) {
    const baseWidth = size && Number.isFinite(Number(size.width)) ? Number(size.width) : 360;
    const baseHeight = size && Number.isFinite(Number(size.height)) ? Number(size.height) : 700;
    const bubble = Math.max(48, Math.round(BUBBLE_SPACE * Math.max(0.3, scale)));
    document.documentElement.style.setProperty('--bubble-space', `${bubble}px`);
    const width = Math.max(80, Math.round(baseWidth * scale));
    const height = Math.max(80, Math.round(baseHeight * scale)) + bubble;
    const next = { width, height };
    if (state.appliedSize && state.appliedSize.width === width && state.appliedSize.height === height) return;
    state.appliedSize = next;
    call('pet:scale', { scale, size: next }).then(() => {
      if (Live2DModel && typeof Live2DModel.resize === 'function') {
        requestAnimationFrame(() => Live2DModel.resize());
      }
    });
  }

  function enterLive2D(url, size, scale) {
    if (!Live2DModel || !els.live2d) return false;
    if (state.live2dOn && state.live2dUrl === url) {
      applyLive2DSize(size, scale);
      return true;
    }
    state.live2dOn = true;
    state.live2dUrl = url;
    // 画布没有 alpha 像素可判 → 整窗可点（和读不到立绘 alpha 时的退化一致）
    state.alphaBroken = true;
    state.alpha = null;
    stopBlink();
    els.live2d.hidden = false;
    els.hint.hidden = true;
    if (els.img) els.img.style.visibility = 'hidden';
    const sway = document.getElementById('sway');
    if (sway) sway.hidden = true;

    applyLive2DSize(size, scale);
    startMouthLoop();

    Live2DModel.init({ canvas: els.live2d, url }).then((ok) => {
      if (ok) {
        placeWaveOverHead();
        return;
      }
      // 模型加载失败：记住这个地址别再重试，退回静态立绘
      state.live2dFailed = url;
      state.live2dOn = false;
      els.live2d.hidden = true;
      if (els.img) els.img.style.visibility = '';
      if (sway) sway.hidden = false;
      refresh();
    });
    return true;
  }

  /** Live2D 模型不一定铺满窗口上缘，把波形贴着模型头顶放 */
  function placeWaveOverHead() {
    if (!Live2DModel || typeof Live2DModel.headTop !== 'function' || !els.wave) return;
    const top = Live2DModel.headTop();
    if (!top) return;
    els.wave.style.top = `${Math.max(2, top - 30)}px`;
    els.wave.style.bottom = 'auto';
  }

  function exitLive2D() {
    if (!state.live2dOn) return;
    state.live2dOn = false;
    state.live2dUrl = '';
    state.alphaBroken = false;
    if (Live2DModel && typeof Live2DModel.destroy === 'function') Live2DModel.destroy();
    if (els.live2d) els.live2d.hidden = true;
    if (els.img) els.img.style.visibility = '';
    if (els.wave) {
      els.wave.style.top = '';
      els.wave.style.bottom = '';
    }
    const sway = document.getElementById('sway');
    if (sway) sway.hidden = false;
  }

  /** 每帧把音量写进嘴型参数（不说话时闭着） */
  function startMouthLoop() {
    if (state.mouthRaf) return;
    const step = () => {
      state.mouthRaf = requestAnimationFrame(step);
      if (!state.live2dOn || !Live2DModel) return;
      const speaking = Voice && Voice.state ? Voice.state.speaking : false;
      const level = speaking ? Number(Voice.state.level) || 0 : 0;
      Live2DModel.setMouth(Math.min(1, level * 1.2));
    };
    state.mouthRaf = requestAnimationFrame(step);
  }

  function refresh() {
    if (!API) {
      showPlaceholder();
      return Promise.resolve();
    }
    return API.invoke('pet:getState').then(
      (info) => applyState(info),
      (error) => {
        console.warn(`[pet] 读取状态失败：${error && error.message ? error.message : error}`);
        showPlaceholder();
      },
    );
  }

  // -------------------------------------------------------------------------
  // 事件绑定
  // -------------------------------------------------------------------------

  els.img.addEventListener('load', () => {
    const src = els.img.getAttribute('src') || '';
    if (src !== state.currentSrc) return; // 眨眼帧 / 已过期的请求
    if (state.isPlaceholder) return;
    if (!state.alpha) buildAlpha(); // 眨眼换回 idle 时像素没变，不必重画
    fitWindow();
    scheduleBlink();
  });

  els.img.addEventListener('error', () => {
    const src = els.img.getAttribute('src') || '';
    if (src !== state.currentSrc) return;
    if (state.isPlaceholder) return;
    // 立绘读不到：占位 + 提示，整窗可点
    showPlaceholder();
  });

  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('dblclick', onDoubleClick);
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!els.menu.hidden) {
      hideMenu();
      return;
    }
    // 右键前若刚排了「单击开聊天」，别让它在菜单弹出后再冒出来
    clickGate.cancel();
    showMenu(event.clientX, event.clientY);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu();
  });
  window.addEventListener('blur', () => hideMenu());
  function onPointerLeave() {
    if (state.dragging || state.menuOpen) return;
    if (state.clickThrough) applyIgnore(true);
  }
  document.addEventListener('mouseleave', onPointerLeave);
  window.addEventListener('mouseout', (event) => {
    if (event.relatedTarget || event.toElement) return;
    onPointerLeave();
  });

  els.bubble.addEventListener('mousedown', (event) => event.stopPropagation());
  els.bubble.addEventListener('click', (event) => {
    event.stopPropagation();
    hideBubble();
    call('pet:bubbleDismissed');
    openWindow('chat');
  });

  els.hint.addEventListener('mousedown', (event) => event.stopPropagation());
  els.hint.addEventListener('click', (event) => {
    event.stopPropagation();
    openWindow('settings');
  });

  if (API && typeof API.on === 'function') {
    let refreshTimer = null;
    API.on('state:changed', () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh();
      }, 120);
    });
    API.on('pet:bubble', (payload) => {
      if (payload && typeof payload.text === 'string' && payload.text) showBubble(payload.text);
    });
  }

  // 先亮占位，避免白屏/空窗，再向主进程要真实状态
  els.img.classList.add('is-placeholder');
  els.img.src = PLACEHOLDER;
  state.currentSrc = PLACEHOLDER;
  if (API) {
    API.invoke('settings:get').then((settings) => {
      if (window.SheI18n) {
        window.SheI18n.apply(settings && settings.ui && settings.ui.language === 'en' ? 'en' : 'zh');
      }
    }).catch(() => {});
  }
  refresh();
}());
