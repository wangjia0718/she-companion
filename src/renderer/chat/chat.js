'use strict';

// 聊天窗渲染层（经典 script，不用 module；只经 preload 暴露的 window.api 通主进程）。
//
// 职责（Task 11 / Spec 10.2）：
//   1. 左栏 200px：角色列表（立绘首帧或首字圆形占位、名字、未读红点）+「＋ 新建角色」；
//   2. 中栏：用户右侧实心气泡、她左侧白底描边气泡，按天插日期分隔条；流式逐字追加，
//      默认跟随到底部，用户手动上滑后不再强制滚动；
//   3. 底部输入：Enter 发送、Shift+Enter 换行；生成中发送按钮变「停止」；
//   4. 右上「⋯」：停止生成 / 导出当前会话 markdown（Blob）/ 清空本会话（二次确认）；
//   5. 右侧抽屉（默认收起）：记忆（只读）/ 今天（日程+事件）/ 日记；
//   6. chat:error 显示中文警示气泡 + 重试（重发上一条用户消息）；
//   7. 进入窗口且角色可见时清掉未读红点（本地 localStorage 记"读到这里"的时间水位）；
//   8. 所有模型输出都经 MarkdownLite.render（先转义再渲染），绝不直接塞原文进 innerHTML。
//
// 事件里都带 characterId：只处理当前角色的；preload 的 on 返回 unsubscribe，退出时逐个取消。

(function () {
  const API = window.api || null;
  const MD = window.MarkdownLite || null;
  const Stream = window.ChatStream || null;

  const TYPING_HTML = '<span class="typing"><i></i><i></i><i></i></span>';
  const READ_STORAGE_KEY = 'chat-read-ids-v1';
  const STICK_THRESHOLD = 64;
  const KIND_LABEL = { fact: '事实', preference: '偏好', event: '事件', relation: '关系' };

  const els = {
    chat: document.querySelector('.chat'),
    composer: document.querySelector('.composer'),
    railList: document.getElementById('rail-list'),
    btnNewChar: document.getElementById('btn-new-char'),
    topName: document.getElementById('top-name'),
    wave: document.getElementById('wave'),
    topSub: document.getElementById('top-sub'),
    topMood: document.getElementById('top-mood'),
    topModel: document.getElementById('top-model'),
    btnDrawer: document.getElementById('btn-drawer'),
    drawerSettings: document.getElementById('btn-drawer-settings'),
    btnMore: document.getElementById('btn-more'),
    moreMenu: document.getElementById('more-menu'),
    menuStop: document.getElementById('menu-stop'),
    messages: document.getElementById('messages'),
    empty: document.getElementById('empty'),
    emptyTitle: document.getElementById('empty-title'),
    emptyDesc: document.getElementById('empty-desc'),
    emptyAction: document.getElementById('empty-action'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    drawer: document.getElementById('drawer'),
    drawerTabs: Array.from(document.querySelectorAll('.drawer-tab')),
    drawerBody: document.getElementById('drawer-body'),
    btnDrawerClose: document.getElementById('btn-drawer-close'),
    modal: document.getElementById('modal'),
    modalInput: document.getElementById('modal-input'),
    modalError: document.getElementById('modal-error'),
    modalOk: document.getElementById('modal-ok'),
    modalCancel: document.getElementById('modal-cancel'),
    toast: document.getElementById('toast'),
  };

  const Voice = window.SheVoice || null;
  if (Voice && typeof Voice.bindWave === 'function') Voice.bindWave(els.wave);

  const state = {
    characters: [],
    activeId: null,
    messages: [], // 当前显示的消息（含本地的流式占位）
    unread: new Map(), // characterId -> 未读数
    framesById: new Map(), // characterId -> 立绘 idle 帧 URL
    settings: null, // 最近一次 settings:get（只用来显示模型名）
    mood: '平静',
    lastDayKey: '',
    stick: true,
    generating: false,
    stopping: false, // 已点停止、等 chat:done 的窗口期：期间到达的 delta 一律丢弃
    stream: null, // { msg, gate, paintScheduled, finalized }
    lastUserText: '',
    errorSeen: false,
    loadingHistory: false,
    drawerOpen: false,
    tab: 'memory',
    diaryDate: null, // 当前查看的日记日期；null 表示回到今天
    memoryCards: [],
    memoryQuery: '',
    creating: false,
    stopTimer: null,
  };

  const unsubs = [];
  let historyToken = 0;
  let drawerToken = 0;
  let refreshTimer = null;
  let toastTimer = null;

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function parseTs(value) {
    if (typeof value !== 'string' || value === '') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function clockOf(value) {
    const date = parseTs(value);
    return date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : '';
  }

  function dayKeyOf(value) {
    const date = parseTs(value);
    if (!date) return 'unknown';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function dayLabelOf(value) {
    const date = parseTs(value);
    if (!date) return '';
    const today = new Date();
    if (dayKeyOf(value) === dayKeyOf(today.toISOString())) return '今天';
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKeyOf(value) === dayKeyOf(yesterday.toISOString())) return '昨天';
    if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function fullDayLabelOf(value) {
    const date = parseTs(value);
    if (!date) return '';
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatDateTime(value) {
    const date = parseTs(value);
    if (!date) return '';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function localISO(date) {
    const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const offset = -value.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
      + `T${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`
      + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  }

  function fileStamp(date) {
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
      + `-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  }

  function safeFileName(name) {
    return String(name || '她').replace(/[\\/:*?"<>|]/g, '-').slice(0, 40) || '她';
  }

  /** 导出成 markdown 时把尖括号转义，避免在支持 HTML 的预览器里被当成标签 */
  function escapeForMarkdown(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function firstChar(name) {
    const chars = Array.from(String(name || '她').trim());
    return chars.length > 0 ? chars[0] : '她';
  }

  function msgOf(error) {
    let text = error && error.message ? String(error.message) : String(error || '');
    text = text.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
    return text.trim() || '未知错误';
  }

  function currentCharacter() {
    if (!state.activeId) return null;
    return state.characters.find((character) => character && character.id === state.activeId) || null;
  }

  function invoke(channel, payload) {
    if (!API) return Promise.reject(new Error('界面没有连上主进程'));
    return API.invoke(channel, payload);
  }

  async function safeInvoke(channel, payload) {
    try {
      return await invoke(channel, payload);
    } catch (error) {
      return null;
    }
  }

  function paintInto(node, text) {
    if (MD && typeof MD.render === 'function') {
      node.innerHTML = MD.render(text);
      return;
    }
    // markdown-lite 没加载时的兜底：纯文本，同样不会执行任何标记
    node.textContent = text;
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      els.toast.hidden = true;
    }, 2200);
  }

  // -------------------------------------------------------------------------
  // 已读记录（没有"标记已读"的 IPC，先把读过的消息 id 记在本地）
  // -------------------------------------------------------------------------

  function loadReadIds() {
    try {
      const raw = window.localStorage.getItem(READ_STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : {};
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
      return {};
    }
  }

  function saveReadIds(data) {
    try {
      window.localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      // 存不了就算了：红点下次重启会回来，不影响聊天
    }
  }

  /** 兼容旧格式（数组）与新格式（{ ids, readAt }） */
  function readRecord(store, characterId) {
    const raw = store[characterId];
    if (Array.isArray(raw)) return { ids: raw, readAt: 0 };
    if (raw && typeof raw === 'object') {
      return {
        ids: Array.isArray(raw.ids) ? raw.ids : [],
        readAt: Number.isFinite(raw.readAt) ? raw.readAt : 0,
      };
    }
    return { ids: [], readAt: 0 };
  }

  /**
   * 标记当前角色的未读为已读。
   * 只靠当前加载的 200 条 id 无法覆盖更早的未读，所以这里改记一个"读到这里"的时间水位，
   * 并清空该角色之前存的所有 id（评审要求）；读过的更早消息按时间视为已读。
   * 同时把水位同步给主进程（chat:markRead），托盘据此停止该角色的头像闪烁。
   */
  function markRead() {
    // 隐藏的预建聊天窗 visibilityState 仍可能是 visible，必须再确认窗口真的有焦点；
    // 否则启动时会把还没看过的主动消息误标成已读，托盘头像就不会闪。
    if (!state.activeId) return;
    if (document.visibilityState === 'hidden' || !document.hasFocus()) return;
    const store = loadReadIds();
    const previous = readRecord(store, state.activeId);
    const readAt = Math.max(previous.readAt || 0, Date.now());
    store[state.activeId] = { ids: [], readAt };
    saveReadIds(store);
    safeInvoke('chat:markRead', { characterId: state.activeId, at: readAt });
    for (const message of state.messages) {
      if (message && message.unread) message.unread = false;
    }
    if ((state.unread.get(state.activeId) || 0) !== 0) {
      state.unread.set(state.activeId, 0);
      renderRail();
    }
  }

  // -------------------------------------------------------------------------
  // 角色列表
  // -------------------------------------------------------------------------

  async function refreshCharacters() {
    let list;
    try {
      list = await invoke('characters:list');
    } catch (error) {
      toast(`读取角色失败：${msgOf(error)}`);
      list = state.characters;
    }
    state.characters = Array.isArray(list)
      ? list.filter((character) => character && typeof character.id === 'string' && character.id !== '')
      : [];
    await loadUnreadCounts();
    renderRail();
    return state.characters;
  }

  async function loadUnreadCounts() {
    const readStore = loadReadIds();
    const visible = document.visibilityState !== 'hidden';
    const entries = await Promise.all(state.characters.map(async (character) => {
      // 当前正在看这个角色：进窗口就算已读，不再飘红（markRead 会记下时间水位）
      if (visible && character.id === state.activeId) return [character.id, 0];
      const record = readRecord(readStore, character.id);
      const readSet = new Set(record.ids);
      try {
        const list = await invoke('chat:history', { characterId: character.id, limit: 200 });
        const count = (Array.isArray(list) ? list : [])
          .filter((message) => {
            if (!message || message.unread !== true) return false;
            if (readSet.has(message.id)) return false;
            if (record.readAt > 0 && typeof message.ts === 'string') {
              const at = Date.parse(message.ts);
              if (Number.isFinite(at) && at <= record.readAt) return false;
            }
            return true;
          })
          .length;
        return [character.id, count];
      } catch (error) {
        return [character.id, 0];
      }
    }));
    state.unread = new Map(entries);
  }

  function renderRail() {
    const frag = document.createDocumentFragment();
    for (const character of state.characters) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'char' + (character.id === state.activeId ? ' is-active' : '');
      button.dataset.id = character.id;
      button.setAttribute('role', 'listitem');
      button.setAttribute('aria-current', character.id === state.activeId ? 'true' : 'false');
      button.title = character.name || '她';

      const avatar = document.createElement('span');
      avatar.className = 'char-avatar';
      const frame = state.framesById.get(character.id);
      if (frame) {
        const img = document.createElement('img');
        img.src = frame;
        img.alt = '';
        img.draggable = false;
        avatar.appendChild(img);
      } else {
        avatar.textContent = firstChar(character.name);
      }

      const name = document.createElement('span');
      name.className = 'char-name';
      name.textContent = character.name || '她';

      const unread = state.unread.get(character.id) || 0;
      const dot = document.createElement('span');
      if (unread > 0) {
        dot.className = 'char-dot';
        dot.setAttribute('aria-label', `${unread} 条未读`);
        dot.title = `${unread} 条未读`;
      } else {
        dot.className = 'char-dot';
        dot.hidden = true;
      }

      button.append(avatar, name, dot);
      frag.appendChild(button);
    }
    els.railList.textContent = '';
    els.railList.appendChild(frag);
  }

  async function refreshActiveAvatar(id) {
    const data = await safeInvoke('pet:getState');
    let mood = '';
    if (data && data.character && data.character.id === id) {
      if (typeof data.mood === 'string') mood = data.mood.trim();
      else if (typeof data.character.mood === 'string') mood = data.character.mood.trim();
      if (data.frames && typeof data.frames.idle === 'string' && data.frames.idle !== '') {
        state.framesById.set(id, data.frames.idle);
        renderRail();
      }
    }
    // pet:getState 暂时没带 mood 时，用今天最近一条事件的心情兜底
    if (mood === '') {
      const timeline = await safeInvoke('timeline:get', { characterId: id });
      const today = timeline && timeline.today;
      if (today && typeof today.mood === 'string') {
        mood = today.mood.trim();
      } else if (today && Array.isArray(today.events) && today.events.length > 0) {
        const last = today.events[today.events.length - 1];
        if (last && typeof last.mood === 'string') mood = last.mood.trim();
      }
    }
    state.mood = mood || '平静';
    setHeader();
  }

  // -------------------------------------------------------------------------
  // 选择角色 / 历史
  // -------------------------------------------------------------------------

  async function selectCharacter(id) {
    if (typeof id !== 'string' || id === '') return;
    if (state.activeId !== id) {
      cancelLocalStream();
      state.messages = [];
      state.lastDayKey = '';
      state.memoryQuery = '';
      state.diaryDate = null;
      state.mood = '平静';
    }
    state.activeId = id;
    state.stick = true;
    state.loadingHistory = true;
    setHeader();
    renderRail();
    renderAll({ forceBottom: true });
    updateEmptyState();
    updateComposer();

    // 记下当前角色（pet:getState 也按这个取头像）
    await safeInvoke('characters:setActive', { id });
    await loadHistory(id);
    await refreshActiveAvatar(id);
    setHeader();
    markRead();
    if (state.drawerOpen) renderDrawerTab(state.tab);
  }

  async function loadHistory(id) {
    const token = ++historyToken;
    try {
      const list = await invoke('chat:history', { characterId: id, limit: 200 });
      if (token !== historyToken || state.activeId !== id) return;
      state.messages = (Array.isArray(list) ? list : [])
        .filter((message) => message && typeof message === 'object')
        .map(normalizeMessage);
      state.lastDayKey = '';
      state.loadingHistory = false;
      renderAll({ forceBottom: true });
      updateEmptyState();
      setHeader();
    } catch (error) {
      if (token !== historyToken || state.activeId !== id) return;
      state.loadingHistory = false;
      renderAll();
      updateEmptyState();
      showErrorBubble(`读取聊天记录失败：${msgOf(error)}`, 'HISTORY');
    }
  }

  function normalizeMessage(message) {
    const tokens = Number(message.tokens);
    return {
      id: typeof message.id === 'string' ? message.id : '',
      role: message.role === 'user' ? 'user' : 'assistant',
      text: typeof message.text === 'string' ? message.text : '',
      ts: typeof message.ts === 'string' ? message.ts : '',
      unread: message.unread === true,
      proactive: message.proactive === true,
      stopped: message.stopped === true,
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    };
  }

  // -------------------------------------------------------------------------
  // 消息渲染
  // -------------------------------------------------------------------------

  function setHeader() {
    const character = currentCharacter();
    els.topName.textContent = character ? (character.name || '她') : '还没有角色';
    if (!character) {
      els.topSub.textContent = '';
      els.topMood.hidden = true;
      els.topModel.hidden = true;
      return;
    }
    const count = state.messages.length;
    els.topSub.textContent = count > 0 ? `${count} 条` : '还没说过话';
    els.topMood.hidden = false;
    els.topModel.hidden = false;
    els.topMood.textContent = state.mood || '平静';
    els.topMood.title = `心情：${state.mood || '平静'}（点击打开设置）`;
    const model = modelLabel();
    els.topModel.textContent = model;
    els.topModel.title = `当前模型：${model}（点击打开设置）`;
  }

  /** 顶栏显示的模型名：settings.api.chat 指到的配置组，找不到就用第一组 */
  function modelLabel() {
    const api = state.settings && state.settings.api ? state.settings.api : null;
    const profiles = api && Array.isArray(api.profiles) ? api.profiles : [];
    if (profiles.length === 0) return '未配置模型';
    const profile = profiles.find((item) => item && item.id === api.chat) || profiles[0];
    const model = profile && typeof profile.model === 'string' ? profile.model.trim() : '';
    return model || '未配置模型';
  }

  async function loadSettingsSummary() {
    const settings = await safeInvoke('settings:get');
    if (settings && typeof settings === 'object') {
      state.settings = settings;
      if (window.SheI18n) {
        window.SheI18n.apply(settings.ui && settings.ui.language === 'en' ? 'en' : 'zh');
      }
    }
    setHeader();
  }

  function renderAll(options = {}) {
    els.messages.textContent = '';
    state.lastDayKey = '';
    const frag = document.createDocumentFragment();
    for (const message of state.messages) frag.appendChild(nodeFor(message));
    els.messages.appendChild(frag);
    setHeader();
    updateJump();
    if (options.forceBottom || state.stick) scrollToBottom();
  }

  /** 一条消息（必要时带日期分隔条）的 DOM 片段；同时把节点挂回 message.__el 方便流式更新 */
  function nodeFor(message) {
    const frag = document.createDocumentFragment();
    const key = dayKeyOf(message.ts);
    if (key !== state.lastDayKey) {
      const divider = document.createElement('div');
      divider.className = 'day-divider';
      divider.textContent = dayLabelOf(message.ts);
      divider.setAttribute('role', 'separator');
      frag.appendChild(divider);
      state.lastDayKey = key;
    }
    frag.appendChild(bubbleFor(message));
    return frag;
  }

  function bubbleFor(message) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (message.role === 'user' ? 'msg-user' : 'msg-assistant');
    wrap.dataset.id = message.id || '';
    if (message.proactive) wrap.classList.add('is-proactive');
    if (message.streaming) wrap.classList.add('is-streaming');

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const body = document.createElement('div');
    body.className = 'msg-text';
    body.setAttribute('data-i18n-skip', '');

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    if (message.proactive) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '主动';
      meta.appendChild(tag);
    }
    if (message.stopped) {
      const tag = document.createElement('span');
      tag.className = 'tag tag-muted';
      tag.textContent = '中断';
      meta.appendChild(tag);
    }
    if (message.tokens > 0) meta.appendChild(tokensNode(message.tokens));
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = clockOf(message.ts);
    time.title = formatDateTime(message.ts);
    meta.appendChild(time);

    bubble.append(body, meta);
    wrap.appendChild(bubble);

    message.__el = wrap;
    message.__body = body;
    message.__time = time;
    paintBubble(message);
    return wrap;
  }

  function paintBubble(message) {
    if (!message || !message.__body) return;
    if (message.text) {
      paintInto(message.__body, message.text);
    } else if (message.streaming) {
      message.__body.innerHTML = TYPING_HTML;
    } else {
      message.__body.textContent = '';
    }
  }

  function tokensNode(tokens) {
    const span = document.createElement('span');
    span.className = 'msg-tokens';
    span.textContent = `· ${tokens} tokens`;
    span.title = `本次回复用了 ${tokens} tokens`;
    return span;
  }

  /** done 里带回来的 token 数补进已有气泡（历史消息在 bubbleFor 里已渲染） */
  function updateMeta(message) {
    if (!message || !message.__el) return;
    const meta = message.__el.querySelector('.msg-meta');
    if (!meta) return;
    const existing = meta.querySelector('.msg-tokens');
    if (message.tokens > 0) {
      if (existing) {
        existing.textContent = `· ${message.tokens} tokens`;
        existing.title = `本次回复用了 ${message.tokens} tokens`;
        return;
      }
      const node = tokensNode(message.tokens);
      if (message.__time) meta.insertBefore(node, message.__time);
      else meta.appendChild(node);
      return;
    }
    if (existing) existing.remove();
  }

  function appendToStream(node) {
    els.messages.appendChild(node);
    updateJump();
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function updateJump() {
    if (!els.jump) return;
    els.jump.hidden = state.stick || state.messages.length === 0;
  }

  function updateEmptyState() {
    const hasCharacter = !!currentCharacter();
    if (state.loadingHistory) {
      els.empty.hidden = true;
      return;
    }
    if (!hasCharacter) {
      showEmpty('先到设置里创建角色', '创建之后就能跟她说话了。', '去设置', openSettings);
      return;
    }
    if (state.messages.length === 0 && !state.generating) {
      showEmpty('跟她说句话吧', '她今天也在这里。', '', null);
      return;
    }
    els.empty.hidden = true;
  }

  function showEmpty(title, desc, actionText, action) {
    els.empty.hidden = false;
    els.emptyTitle.textContent = title;
    els.emptyDesc.textContent = desc;
    if (actionText && typeof action === 'function') {
      els.emptyAction.hidden = false;
      els.emptyAction.textContent = actionText;
      els.emptyAction.onclick = action;
    } else {
      els.emptyAction.hidden = true;
      els.emptyAction.onclick = null;
    }
  }

  function updateComposer() {
    const hasCharacter = !!currentCharacter();
    const generating = state.generating;
    els.input.disabled = !hasCharacter;
    els.input.placeholder = hasCharacter
      ? '和她说点什么…（Enter 发送，Shift+Enter 换行）'
      : '先在设置里创建角色';
    els.send.textContent = generating ? '停止' : '发送';
    els.send.classList.toggle('is-stop', generating);
    els.send.disabled = !hasCharacter || (!generating && els.input.value.trim() === '');
    els.send.setAttribute('aria-label', generating ? '停止生成' : '发送');
    els.menuStop.disabled = !generating;
  }

  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(132, Math.max(26, els.input.scrollHeight))}px`;
    syncComposerHeight();
  }

  /** 把输入区高度告诉 CSS：右侧抽屉停在输入框上方，不会盖住发送按钮 */
  function syncComposerHeight() {
    if (!els.chat || !els.composer) return;
    els.chat.style.setProperty('--composer-h', `${els.composer.offsetHeight}px`);
  }

  // -------------------------------------------------------------------------
  // 发送 / 流式 / 停止
  // -------------------------------------------------------------------------

  function startStreaming() {
    const message = {
      id: `local-stream-${Date.now()}`,
      role: 'assistant',
      text: '',
      ts: localISO(new Date()),
      unread: false,
      proactive: false,
      stopped: false,
      streaming: true,
      tokens: 0,
    };
    state.messages.push(message);
    appendToStream(nodeFor(message));
    state.stream = {
      msg: message,
      gate: Stream ? Stream.create() : null,
      paintScheduled: false,
      finalized: false,
    };
    state.stick = true;
    setHeader();
    updateEmptyState();
    scrollToBottom();
  }

  function scheduleStreamPaint() {
    const stream = state.stream;
    if (!stream || stream.paintScheduled) return;
    stream.paintScheduled = true;
    window.requestAnimationFrame(() => {
      if (state.stream !== stream) return;
      stream.paintScheduled = false;
      paintBubble(stream.msg);
      if (state.stick) scrollToBottom();
    });
  }

  function clearStopTimer() {
    window.clearTimeout(state.stopTimer);
    state.stopTimer = null;
  }

  /** 出错 / 切换角色时：保留已经写出来的字，去掉空气泡 */
  function closeStreamKeepText() {
    const stream = state.stream;
    state.stopping = false;
    if (!stream) return;
    stream.finalized = true;
    if (stream.gate) stream.gate.finalized = true;
    clearStopTimer();
    stream.msg.streaming = false;
    if (stream.msg.__el) stream.msg.__el.classList.remove('is-streaming');
    if (!stream.msg.text.trim()) {
      if (stream.msg.__el) stream.msg.__el.remove();
      state.messages = state.messages.filter((message) => message !== stream.msg);
    } else {
      paintBubble(stream.msg);
    }
    state.stream = null;
    updateEmptyState();
    updateJump();
    setHeader();
  }

  /** 没有 ChatStream 模块时的兜底：仍以 done 的权威文本为准 */
  function fallbackFinalize(stream, payload) {
    const input = payload && typeof payload === 'object' ? payload : {};
    const message = input.message && typeof input.message === 'object' ? input.message : null;
    let text = '';
    if (message && typeof message.text === 'string' && message.text !== '') text = message.text;
    else if (typeof input.text === 'string') text = input.text;
    else text = stream.msg.text;
    const stopped = input.stopped === true || !!(message && message.stopped === true);
    if (stopped && text !== '' && !/（中断）\s*$/.test(text)) text = `${text}（中断）`;
    const usageTokens = Number(input.usage && input.usage.completionTokens);
    const messageTokens = Number(message && message.tokens);
    const tokens = Number.isFinite(usageTokens) && usageTokens > 0
      ? usageTokens
      : (Number.isFinite(messageTokens) && messageTokens > 0 ? messageTokens : 0);
    return { text, stopped, tokens };
  }

  function finalizeStream(payload = {}) {
    const stream = state.stream;
    if (!stream) {
      state.stopping = false;
      state.generating = false;
      updateComposer();
      return;
    }
    if (stream.finalized) {
      state.stream = null;
      state.stopping = false;
      state.generating = false;
      updateComposer();
      return;
    }
    stream.finalized = true;
    clearStopTimer();

    const result = Stream
      ? Stream.finalize(stream.gate || Stream.create(), payload)
      : fallbackFinalize(stream, payload);
    const message = payload && payload.message && typeof payload.message === 'object' ? payload.message : null;
    const text = result.text;

    if (!text || text.trim() === '') {
      if (stream.msg.__el) stream.msg.__el.remove();
      state.messages = state.messages.filter((item) => item !== stream.msg);
    } else {
      stream.msg.text = text;
      stream.msg.streaming = false;
      stream.msg.tokens = result.tokens || 0;
      if (message) {
        if (typeof message.id === 'string' && message.id) stream.msg.id = message.id;
        if (typeof message.ts === 'string' && message.ts) stream.msg.ts = message.ts;
        stream.msg.proactive = message.proactive === true;
      }
      stream.msg.stopped = result.stopped;
      if (stream.msg.__el) {
        stream.msg.__el.classList.remove('is-streaming');
        stream.msg.__el.dataset.id = stream.msg.id || '';
        if (stream.msg.stopped && !stream.msg.__el.querySelector('.tag-muted')) {
          const tag = document.createElement('span');
          tag.className = 'tag tag-muted';
          tag.textContent = '中断';
          stream.msg.__el.querySelector('.msg-meta')?.prepend(tag);
        }
      }
      if (stream.msg.__time) {
        stream.msg.__time.textContent = clockOf(stream.msg.ts);
        stream.msg.__time.title = formatDateTime(stream.msg.ts);
      }
      updateMeta(stream.msg);
      paintBubble(stream.msg);
    }

    state.stream = null;
    state.stopping = false;
    state.generating = false;
    updateComposer();
    updateEmptyState();
    updateJump();
    setHeader();
    if (state.stick) scrollToBottom();

    // 念出这条回复（设置里可关：voice.inChat）；被中断的半句不念
    if (text && !result.stopped && Voice && typeof Voice.say === 'function') {
      Voice.say(text, { kind: 'chat' });
    }
  }

  function friendlyError(message, code) {
    const text = typeof message === 'string' && message.trim() ? message.trim() : '';
    if (!text) return '模型没有回应，稍后再试一次。';
    if (code === 'AUTH') return `${text}（到设置里把模型和 Key 填好再试）`;
    if (code === 'NETWORK') return `${text}（网络不太稳，可以点重试）`;
    if (code === 'RATE') return `${text}（等一会儿再试）`;
    return text;
  }

  function removeErrorBubbles() {
    for (const node of Array.from(els.messages.querySelectorAll('.msg-error'))) node.remove();
  }

  function showErrorBubble(message, code) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant msg-error';
    wrap.dataset.error = '1';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const text = document.createElement('div');
    text.className = 'msg-error-text';
    text.textContent = `没收到回复：${friendlyError(message, code)}`;

    const actions = document.createElement('div');
    actions.className = 'msg-error-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry-btn';
    retry.textContent = '重试';
    retry.disabled = !state.lastUserText || state.generating;
    retry.addEventListener('click', () => {
      const last = state.lastUserText;
      if (!last || state.generating) return;
      removeErrorBubbles();
      sendText(last);
    });
    actions.appendChild(retry);

    bubble.append(text, actions);
    wrap.appendChild(bubble);
    els.messages.appendChild(wrap);
    updateJump();
    if (state.stick) scrollToBottom();
  }

  async function sendText(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    const character = currentCharacter();
    if (!text || !character || state.generating) return;

    state.lastUserText = text;
    state.errorSeen = false;
    state.stopping = false;
    state.generating = true;
    state.stick = true;
    removeErrorBubbles();
    // 用户开始新一句：先把她上一句念到一半的停掉
    if (Voice && typeof Voice.stop === 'function') Voice.stop();

    const userMessage = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      text,
      ts: localISO(new Date()),
      unread: false,
      proactive: false,
      stopped: false,
    };
    state.messages.push(userMessage);
    appendToStream(nodeFor(userMessage));
    startStreaming();

    els.input.value = '';
    autoResize();
    updateComposer();
    scrollToBottom();

    try {
      const result = await invoke('chat:send', { characterId: character.id, text });
      if (result && result.ok === false) {
        if (!state.errorSeen) {
          state.errorSeen = true;
          closeStreamKeepText();
          state.generating = false;
          updateComposer();
          showErrorBubble(result.error && result.error.message, result.error && result.error.code);
        }
      } else if (result && result.message) {
        finalizeStream({ message: result.message, stopped: result.stopped === true });
      } else {
        finalizeStream({
          text: state.stream ? (state.stream.gate ? state.stream.gate.text : state.stream.msg.text) : '',
          stopped: !!(result && result.stopped),
        });
      }
    } catch (error) {
      state.stopping = false;
      if (!state.errorSeen) {
        state.errorSeen = true;
        closeStreamKeepText();
        state.generating = false;
        updateComposer();
        showErrorBubble(msgOf(error), 'IPC');
      }
    } finally {
      if (state.stream) {
        finalizeStream({ text: state.stream.gate ? state.stream.gate.text : state.stream.msg.text });
      }
      state.stopping = false;
      state.generating = false;
      updateComposer();
      updateEmptyState();
      setHeader();
      markRead();
    }
  }

  async function stopGeneration() {
    if (!state.generating) {
      closeMenu();
      return;
    }
    closeMenu();
    // 先关闸再通知主进程：等 done 期间迟到的 delta 一律不画
    state.stopping = true;
    if (state.stream && state.stream.gate && Stream) Stream.stop(state.stream.gate);
    els.send.disabled = true;
    try {
      const result = await invoke('chat:stop');
      if (!result || result.stopped !== true) {
        finalizeStream({ text: streamText(), stopped: true });
        state.generating = false;
        updateComposer();
        return;
      }
      // 等主进程的 chat:done（会带「（中断）」）；3 秒还没来就本地收尾
      clearStopTimer();
      state.stopTimer = window.setTimeout(() => {
        if (!state.generating) return;
        finalizeStream({ text: streamText(), stopped: true });
        state.generating = false;
        updateComposer();
      }, 3000);
    } catch (error) {
      state.stopping = false;
      if (state.stream && state.stream.gate) state.stream.gate.stopping = false;
      toast(`停止失败：${msgOf(error)}`);
      state.generating = false;
      updateComposer();
    }
  }

  function streamText() {
    if (!state.stream) return '';
    return state.stream.gate ? state.stream.gate.text : state.stream.msg.text;
  }

  /** 切换角色 / 清空会话前，把本地流式状态收干净（并通知主进程中止） */
  function cancelLocalStream() {
    if (state.generating) invoke('chat:stop').catch(() => {});
    clearStopTimer();
    state.stopping = false;
    const stream = state.stream;
    if (stream) {
      stream.finalized = true;
      if (stream.gate) stream.gate.finalized = true;
      if (stream.msg.__el) stream.msg.__el.remove();
      state.messages = state.messages.filter((message) => message !== stream.msg);
    }
    state.stream = null;
    state.generating = false;
    state.errorSeen = false;
    updateComposer();
  }

  // -------------------------------------------------------------------------
  // 会话操作：清空 / 导出
  // -------------------------------------------------------------------------

  async function clearConversation() {
    closeMenu();
    const character = currentCharacter();
    if (!character) return;
    const name = character.name || '她';
    const confirmed = window.confirm(`清空和「${name}」的这段对话？\n清空后无法恢复。`);
    if (!confirmed) return;

    cancelLocalStream();
    try {
      await invoke('chat:clear', { characterId: character.id });
      state.messages = [];
      state.lastDayKey = '';
      state.stick = true;
      renderAll();
      updateEmptyState();
      updateComposer();
      toast('这段对话已清空');
    } catch (error) {
      toast(`清空失败：${msgOf(error)}`);
    }
  }

  function exportConversation() {
    closeMenu();
    const character = currentCharacter();
    if (!character) {
      toast('还没有角色');
      return;
    }
    if (state.messages.length === 0) {
      toast('这段会话还没有消息');
      return;
    }

    const lines = [];
    lines.push(`# 和「${character.name || '她'}」的对话`, '');
    lines.push(`导出时间：${formatDateTime(new Date().toISOString())}`, `共 ${state.messages.length} 条`, '');
    let lastDay = '';
    for (const message of state.messages) {
      const day = dayKeyOf(message.ts);
      if (day !== lastDay) {
        lines.push(`## ${fullDayLabelOf(message.ts)}`, '');
        lastDay = day;
      }
      lines.push(`**${message.role === 'user' ? '我' : (character.name || '她')}** ${clockOf(message.ts)}`, '');
      lines.push(escapeForMarkdown(message.text || ''), '');
    }

    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(character.name)}-对话-${fileStamp(new Date())}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出 markdown');
  }

  // -------------------------------------------------------------------------
  // 右侧抽屉
  // -------------------------------------------------------------------------

  function setDrawerOpen(open) {
    const next = typeof open === 'boolean' ? open : !state.drawerOpen;
    if (next && !state.drawerOpen) state.diaryDate = null;
    state.drawerOpen = next;
    els.drawer.classList.toggle('is-open', next);
    els.drawer.setAttribute('aria-hidden', next ? 'false' : 'true');
    els.btnDrawer.setAttribute('aria-expanded', next ? 'true' : 'false');
    els.btnDrawer.setAttribute('aria-label', next ? '收起侧栏' : '打开侧栏');
    if (next) renderDrawerTab(state.tab);
  }

  function drawerMessage(text) {
    els.drawerBody.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'drawer-empty';
    empty.textContent = text;
    els.drawerBody.appendChild(empty);
  }

  function drawerSection(title) {
    const heading = document.createElement('div');
    heading.className = 'drawer-section';
    heading.textContent = title;
    els.drawerBody.appendChild(heading);
  }

  function setActiveTab(tab) {
    if (state.tab !== tab) state.diaryDate = null;
    state.tab = tab;
    for (const button of els.drawerTabs) {
      const active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }

  async function renderDrawerTab(tab) {
    setActiveTab(tab);
    const character = currentCharacter();
    if (!character) {
      drawerMessage('还没有角色，先到设置里创建。');
      return;
    }
    const token = ++drawerToken;
    drawerMessage('正在读取…');
    try {
      if (tab === 'memory') {
        const data = await invoke('memory:list', { characterId: character.id });
        if (token !== drawerToken || character.id !== state.activeId) return;
        renderMemory(data);
      } else {
        const data = await invoke('timeline:get', { characterId: character.id });
        if (token !== drawerToken || character.id !== state.activeId) return;
        if (tab === 'today') renderToday(data);
        else renderDiary(data);
      }
    } catch (error) {
      if (token !== drawerToken) return;
      drawerMessage(`读取失败：${msgOf(error)}`);
    }
  }

  function renderMemory(data) {
    state.memoryCards = (data && Array.isArray(data.cards) ? data.cards : [])
      .filter((card) => card && typeof card.text === 'string')
      .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
    els.drawerBody.textContent = '';
    if (state.memoryCards.length === 0) {
      drawerMessage('她还没记住什么。聊得多了，重要的事会慢慢留下来。');
      return;
    }

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'drawer-search';
    search.placeholder = '搜索记忆…';
    search.value = state.memoryQuery;
    search.setAttribute('aria-label', '搜索记忆');

    const list = document.createElement('div');
    list.className = 'memory-list';

    const paint = () => {
      const query = state.memoryQuery.trim().toLowerCase();
      const cards = query === ''
        ? state.memoryCards
        : state.memoryCards.filter((card) => (
          card.text.toLowerCase().includes(query)
          || (KIND_LABEL[card.kind] || '').includes(query)
        ));
      list.textContent = '';
      if (cards.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'drawer-empty';
        empty.textContent = `没有匹配「${state.memoryQuery.trim()}」的记忆`;
        list.appendChild(empty);
        return;
      }
      for (const card of cards) list.appendChild(memoryCardNode(card));
    };

    search.addEventListener('input', () => {
      state.memoryQuery = search.value;
      paint();
    });
    els.drawerBody.append(search, list);
    paint();
  }

  function memoryCardNode(card) {
    const item = document.createElement('div');
    item.className = 'card-item';

    const head = document.createElement('div');
    head.className = 'card-head';
    const kind = document.createElement('span');
    kind.className = 'tag';
    kind.textContent = KIND_LABEL[card.kind] || '记忆';
    const importance = document.createElement('span');
    importance.className = 'card-importance';
    const level = Math.max(1, Math.min(5, Number(card.importance) || 3));
    importance.textContent = `${'★'.repeat(level)}${'☆'.repeat(5 - level)}`;
    importance.title = `重要度 ${level}/5`;
    head.append(kind, importance);

    const text = document.createElement('div');
    text.className = 'card-text';
    text.setAttribute('data-i18n-skip', '');
    text.textContent = card.text; // 记忆条目也是模型产物：只当文本用

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    foot.textContent = `记于 ${formatDateTime(card.updatedAt || card.createdAt)}`;

    item.append(head, text, foot);
    return item;
  }

  function renderToday(data) {
    els.drawerBody.textContent = '';
    const today = data && data.today;
    const dateLabel = document.createElement('div');
    dateLabel.className = 'drawer-date';
    dateLabel.textContent = data && data.date ? data.date : '今天';
    els.drawerBody.appendChild(dateLabel);

    if (!today) {
      drawerMessage('今天的日程还没排出来，等她自己过一会儿。');
      return;
    }

    drawerSection('日程');
    const schedule = Array.isArray(today.schedule) ? today.schedule : [];
    if (schedule.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'drawer-empty';
      empty.textContent = '今天还没安排。';
      els.drawerBody.appendChild(empty);
    } else {
      for (const item of schedule) {
        if (!item) continue;
        const row = document.createElement('div');
        row.className = 'schedule-row';
        const time = document.createElement('span');
        time.className = 'schedule-time';
        time.textContent = item.time || '--:--';
        const activity = document.createElement('span');
        activity.className = 'schedule-text';
        activity.textContent = item.activity || '';
        row.append(time, activity);
        els.drawerBody.appendChild(row);
      }
    }

    drawerSection('她做了什么');
    const events = Array.isArray(today.events) ? today.events : [];
    if (events.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'drawer-empty';
      empty.textContent = '还没到第一个日程点。';
      els.drawerBody.appendChild(empty);
      return;
    }
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const row = document.createElement('div');
      row.className = 'event-row';
      const time = document.createElement('div');
      time.className = 'event-time';
      time.textContent = event.time || '';
      const text = document.createElement('div');
      text.className = 'event-text';
      text.setAttribute('data-i18n-skip', '');
      text.textContent = event.text || event.activity || '';
      row.append(time, text);
      els.drawerBody.appendChild(row);
    }
  }

  function renderDiary(data) {
    els.drawerBody.textContent = '';
    const days = data && data.days && typeof data.days === 'object' ? data.days : {};
    const todayKey = data && typeof data.date === 'string' ? data.date : '';
    const diaryKeys = Object.keys(days)
      .filter((key) => {
        const day = days[key];
        return day && typeof day.diary === 'string' && day.diary.trim() !== '';
      })
      .sort();
    const keys = Array.from(new Set([...diaryKeys, todayKey].filter(Boolean))).sort();

    let selected = state.diaryDate;
    if (!selected || !keys.includes(selected)) selected = todayKey || keys[keys.length - 1] || '';
    state.diaryDate = selected;
    const index = keys.indexOf(selected);

    const nav = document.createElement('div');
    nav.className = 'diary-nav';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'diary-nav-btn';
    prev.textContent = '‹';
    prev.setAttribute('aria-label', '前一天');
    prev.disabled = index <= 0;
    prev.addEventListener('click', () => {
      if (index <= 0) return;
      state.diaryDate = keys[index - 1];
      renderDiary(data);
    });

    const dateLabel = document.createElement('div');
    dateLabel.className = 'diary-nav-date';
    dateLabel.textContent = selected === todayKey ? `${selected}（今天）` : selected;
    dateLabel.title = selected;

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'diary-nav-btn';
    next.textContent = '›';
    next.setAttribute('aria-label', '后一天');
    next.disabled = index < 0 || index >= keys.length - 1;
    next.addEventListener('click', () => {
      if (index < 0 || index >= keys.length - 1) return;
      state.diaryDate = keys[index + 1];
      renderDiary(data);
    });

    nav.append(prev, dateLabel, next);
    els.drawerBody.appendChild(nav);

    const day = days[selected];
    if (!day || typeof day.diary !== 'string' || day.diary.trim() === '') {
      const empty = document.createElement('div');
      empty.className = 'drawer-empty';
      if (selected === todayKey) {
        const hour = state.settings && state.settings.life && Number.isInteger(state.settings.life.diaryHour)
          ? state.settings.life.diaryHour
          : 21;
        const label = `${String(hour).padStart(2, '0')}:00`;
        empty.textContent = new Date().getHours() < hour
          ? `今天还没有日记，${label} 会写。`
          : '今天还没有日记，等她想写的时候吧。';
      } else {
        empty.textContent = '这一天没有日记。';
      }
      els.drawerBody.appendChild(empty);
      return;
    }

    const text = document.createElement('div');
    text.className = 'diary-text';
    text.setAttribute('data-i18n-skip', '');
    paintInto(text, day.diary);
    els.drawerBody.appendChild(text);
    if (day.diaryAt) {
      const foot = document.createElement('div');
      foot.className = 'card-foot';
      foot.textContent = `写于 ${formatDateTime(day.diaryAt)}`;
      els.drawerBody.appendChild(foot);
    }

    const actions = document.createElement('div');
    actions.className = 'diary-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'diary-delete';
    remove.textContent = '删除这篇';
    remove.setAttribute('aria-label', '删除这篇日记');
    let armed = false;
    let armTimer = null;
    const disarm = () => {
      armed = false;
      window.clearTimeout(armTimer);
      remove.classList.remove('is-armed');
      remove.textContent = '删除这篇';
      remove.setAttribute('aria-label', '删除这篇日记');
    };
    remove.addEventListener('click', async () => {
      if (remove.disabled) return;
      if (!armed) {
        armed = true;
        remove.classList.add('is-armed');
        remove.textContent = '确认删除？';
        remove.setAttribute('aria-label', '再点一次确认删除这篇日记');
        armTimer = window.setTimeout(disarm, 3000);
        return;
      }

      window.clearTimeout(armTimer);
      const fallbackDate = keys[index - 1] || keys[index + 1] || '';
      const characterId = state.activeId;
      remove.disabled = true;
      remove.textContent = '删除中…';
      try {
        const result = await invoke('timeline:deleteDiary', { characterId, date: selected });
        if (!result || result.ok !== true) throw new Error('删除失败');
        toast(result.deleted ? '日记已删除' : '这篇日记已经不存在');
        state.diaryDate = fallbackDate && fallbackDate !== todayKey ? fallbackDate : null;
        await renderDrawerTab('diary');
      } catch (error) {
        disarm();
        remove.disabled = false;
        toast(`删除失败：${msgOf(error)}`);
      }
    });
    actions.appendChild(remove);
    els.drawerBody.appendChild(actions);
  }

  // -------------------------------------------------------------------------
  // 菜单 / 弹层
  // -------------------------------------------------------------------------

  function openMenu(open) {
    els.moreMenu.hidden = !open;
    els.btnMore.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) els.menuStop.disabled = !state.generating;
  }

  function closeMenu() {
    if (!els.moreMenu.hidden) openMenu(false);
  }

  function modalError(text) {
    els.modalError.textContent = text;
    els.modalError.hidden = false;
  }

  function openCreateModal() {
    if (state.creating) return;
    els.modal.hidden = false;
    els.modalError.hidden = true;
    els.modalError.textContent = '';
    els.modalInput.value = '';
    els.modalOk.disabled = false;
    window.requestAnimationFrame(() => els.modalInput.focus());
  }

  function closeCreateModal() {
    els.modal.hidden = true;
  }

  async function submitCreate() {
    if (state.creating) return;
    const name = els.modalInput.value.trim();
    if (name === '') {
      modalError('给个名字吧');
      els.modalInput.focus();
      return;
    }
    state.creating = true;
    els.modalOk.disabled = true;
    try {
      const created = await invoke('characters:create', { name });
      closeCreateModal();
      await afterCharactersChanged();
      if (created && created.id && created.id !== state.activeId) {
        await selectCharacter(created.id);
      }
      toast(`「${name}」来了`);
    } catch (error) {
      modalError(`没建成：${msgOf(error)}`);
    } finally {
      state.creating = false;
      els.modalOk.disabled = false;
    }
  }

  function openSettings() {
    invoke('window:open', { target: 'settings' }).catch((error) => {
      toast(`打不开设置：${msgOf(error)}`);
    });
  }

  // -------------------------------------------------------------------------
  // 首次引导（三步卡片，见 onboarding.js；失败不影响聊天）
  // -------------------------------------------------------------------------

  function refreshOnboarding() {
    const onboarding = window.Onboarding;
    if (onboarding && typeof onboarding.refresh === 'function') {
      // 异步但不阻塞聊天：读设置失败时它自己会收起
      Promise.resolve(onboarding.refresh()).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // 角色变化的统一处理（新建 / 删除 / 外部设置窗改动）
  // -------------------------------------------------------------------------

  async function afterCharactersChanged() {
    refreshOnboarding();
    const characters = await refreshCharacters();
    await loadSettingsSummary();
    if (characters.length === 0) {
      cancelLocalStream();
      historyToken += 1;
      state.activeId = null;
      state.messages = [];
      state.lastDayKey = '';
      state.loadingHistory = false;
      renderAll();
      updateEmptyState();
      updateComposer();
      setHeader();
      return;
    }
    if (!characters.some((character) => character.id === state.activeId)) {
      const settings = await safeInvoke('settings:get');
      const wanted = settings && typeof settings.activeCharacterId === 'string' ? settings.activeCharacterId : '';
      const next = characters.some((character) => character.id === wanted) ? wanted : characters[0].id;
      state.activeId = null;
      await selectCharacter(next);
      return;
    }
    updateEmptyState();
    updateComposer();
    setHeader();
  }

  function scheduleCharactersRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      afterCharactersChanged().catch((error) => {
        toast(`刷新角色失败：${msgOf(error)}`);
      });
    }, 300);
  }

  // -------------------------------------------------------------------------
  // 事件绑定
  // -------------------------------------------------------------------------

  function bindApiEvents() {
    if (!API || typeof API.on !== 'function') return;

    unsubs.push(API.on('chat:delta', (payload) => {
      if (state.stopping) return; // 已点停止：等 done 期间迟到的增量不画
      if (!payload || payload.characterId !== state.activeId) return;
      if (!state.generating) return;
      if (!state.stream) startStreaming();
      const stream = state.stream;
      if (!stream) return;
      if (stream.gate) {
        if (!Stream.applyDelta(stream.gate, payload)) return;
        stream.msg.text = stream.gate.text;
      } else {
        const delta = typeof payload.text === 'string' ? payload.text : '';
        if (delta === '') return;
        stream.msg.text += delta;
      }
      scheduleStreamPaint();
    }));

    unsubs.push(API.on('chat:done', (payload) => {
      if (!payload || payload.characterId !== state.activeId) return;
      finalizeStream(payload);
    }));

    unsubs.push(API.on('chat:replace', (payload) => {
      if (!payload || payload.characterId !== state.activeId) return;
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!text) return;
      if (state.stream && state.stream.msg) {
        state.stream.msg.text = text;
        if (state.stream.gate) state.stream.gate.text = text;
        scheduleStreamPaint();
        return;
      }
      for (let i = state.messages.length - 1; i >= 0; i -= 1) {
        if (state.messages[i] && state.messages[i].role === 'assistant') {
          state.messages[i].text = text;
          break;
        }
      }
      renderAll();
    }));

    unsubs.push(API.on('chat:select', (payload) => {
      const id = payload && typeof payload.characterId === 'string' ? payload.characterId : '';
      if (!id) return;
      if (id === state.activeId) {
        markRead();
        return;
      }
      selectCharacter(id).catch((error) => {
        toast(`切换角色失败：${msgOf(error)}`);
      });
    }));

    unsubs.push(API.on('chat:error', (payload) => {
      // done 之后迟到的 error 忽略，避免清掉已经收尾的气泡
      if (!state.generating && !state.stream) return;
      if (!payload || payload.characterId !== state.activeId) return;
      if (state.errorSeen) return;
      state.errorSeen = true;
      state.stopping = false;
      closeStreamKeepText();
      state.generating = false;
      updateComposer();
      showErrorBubble(payload.message, payload.code);
    }));

    // 窗口常驻后，隐藏期间到达的消息不会自己进列表：打开窗口时由主进程通知刷新
    unsubs.push(API.on('chat:refresh', () => {
      if (state.activeId) loadHistory(state.activeId);
    }));

    unsubs.push(API.on('state:changed', (payload) => {
      if (!payload || typeof payload !== 'object') {
        scheduleCharactersRefresh();
        return;
      }
      if (payload.reason === 'chat' && payload.characterId === state.activeId) return;
      // 主动消息到达时聊天窗正好开着且在前台：直接算已读，别让托盘继续闪
      if (payload.reason === 'proactive'
        && payload.characterId === state.activeId
        && document.visibilityState !== 'hidden'
        && document.hasFocus()) {
        markRead();
      }
      // 主动消息是直接写进 chat.jsonl 的，列表不会自己多出来，必须重新拉一次历史
      if (payload.reason === 'proactive' && payload.characterId === state.activeId) {
        loadHistory(state.activeId);
      }
      scheduleCharactersRefresh();
    }));
  }

  function bindUi() {
    els.railList.addEventListener('click', (event) => {
      const button = event.target.closest('.char');
      if (!button || !els.railList.contains(button)) return;
      const id = button.dataset.id;
      if (id && id !== state.activeId) selectCharacter(id);
    });

    els.btnNewChar.addEventListener('click', openCreateModal);
    els.topMood.addEventListener('click', openSettings);
    els.topModel.addEventListener('click', openSettings);
    els.drawerSettings.addEventListener('click', openSettings);

    els.send.addEventListener('click', () => {
      if (state.generating) {
        stopGeneration();
        return;
      }
      sendText(els.input.value);
    });

    els.input.addEventListener('input', () => {
      autoResize();
      updateComposer();
    });

    els.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.shiftKey) return;
      event.preventDefault();
      if (state.generating) return;
      sendText(els.input.value);
    });

    els.btnMore.addEventListener('click', (event) => {
      event.stopPropagation();
      openMenu(els.moreMenu.hidden);
    });

    els.moreMenu.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'stop') stopGeneration();
      else if (action === 'export') exportConversation();
      else if (action === 'clear') clearConversation();
    });

    els.btnDrawer.addEventListener('click', () => setDrawerOpen());
    els.btnDrawerClose.addEventListener('click', () => setDrawerOpen(false));

    for (const button of els.drawerTabs) {
      button.addEventListener('click', () => {
        if (button.dataset.tab !== state.tab) renderDrawerTab(button.dataset.tab);
      });
    }

    // 「↓ 回到最新」：上滑看历史时出现，不打断阅读
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'jump-latest';
    jump.textContent = '↓ 回到最新';
    jump.hidden = true;
    jump.addEventListener('click', () => {
      state.stick = true;
      scrollToBottom();
      updateJump();
    });
    els.chat.appendChild(jump);
    els.jump = jump;

    syncComposerHeight();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => syncComposerHeight());
      observer.observe(els.composer);
      unsubs.push(() => observer.disconnect());
    }
    const onResize = () => {
      syncComposerHeight();
      if (state.stick) scrollToBottom();
    };
    window.addEventListener('resize', onResize);
    unsubs.push(() => window.removeEventListener('resize', onResize));

    els.messages.addEventListener('scroll', () => {
      const box = els.messages;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_THRESHOLD;
      state.stick = atBottom;
      updateJump();
    });

    document.addEventListener('click', (event) => {
      if (els.moreMenu.hidden) return;
      if (els.moreMenu.contains(event.target) || els.btnMore.contains(event.target)) return;
      closeMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!els.modal.hidden) {
        closeCreateModal();
        return;
      }
      if (!els.moreMenu.hidden) {
        closeMenu();
        return;
      }
      if (state.drawerOpen) setDrawerOpen(false);
    });

    els.modalOk.addEventListener('click', submitCreate);
    els.modalCancel.addEventListener('click', closeCreateModal);
    els.modalInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        submitCreate();
      }
    });
    els.modal.addEventListener('click', (event) => {
      if (event.target === els.modal) closeCreateModal();
    });

    document.addEventListener('visibilitychange', markRead);
    window.addEventListener('focus', markRead);

    window.addEventListener('beforeunload', () => {
      window.clearTimeout(refreshTimer);
      window.clearTimeout(toastTimer);
      clearStopTimer();
      for (const unsubscribe of unsubs) {
        try {
          unsubscribe();
        } catch (error) {
          // 窗口正在关闭，忽略
        }
      }
      unsubs.length = 0;
    });
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  async function boot() {
    bindUi();
    if (!API) {
      showEmpty('界面没有连上主进程', '请关掉应用重新打开。', '', null);
      updateComposer();
      return;
    }
    try {
      bindApiEvents();
      refreshOnboarding();

      await loadSettingsSummary();
      const characters = await refreshCharacters();
      if (characters.length === 0) {
        state.activeId = null;
        state.loadingHistory = false;
        renderAll();
        setHeader();
        updateEmptyState();
        updateComposer();
        return;
      }

      const settings = await safeInvoke('settings:get');
      const wanted = settings && typeof settings.activeCharacterId === 'string' ? settings.activeCharacterId : '';
      const preferred = characters.some((character) => character.id === wanted) ? wanted : characters[0].id;
      await selectCharacter(preferred);
    } catch (error) {
      // 启动阶段任何异常都不要留下整块空白：给出可见的失败提示和重试入口
      console.error('[chat] 启动失败：', error);
      showEmpty(
        '聊天窗口没能加载出来',
        `点下面重试；还不行就重启应用。（${msgOf(error)}）`,
        '重新加载',
        () => window.location.reload(),
      );
      updateComposer();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
