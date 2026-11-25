'use strict';

// 首次引导（Task 13 / Spec 11「未配置 API / 无 key → 首次使用进引导」）。
//
// 行为：
//   - settings:get 的 onboarded 为 true → 什么都不显示；
//   - 否则在聊天区顶部显示三步卡片：① 填模型 ② 建角色 ③ 传立绘；
//   - 每步按 settings.api.chat 是否配好、characters:list 是否非空、
//     当前角色是否有 idle 帧（characters:frames）自动打勾；
//   - 三步都完成 → settings:save { onboarded:true } 并自动收起；
//   - 卡片不挡输入框：用户可以先去聊天，没配模型时 chat:error 会给提示。
//
// chat.js 只需在角色/设置变化后调 window.Onboarding.refresh()。

(function () {
  const API = window.api || null;
  const STYLE_ID = 'onboarding-style';
  const STYLE = `
    .onboarding { padding: 10px 16px 0; }
    .onboarding-card {
      border: 1px solid var(--divider, #EDE4D8);
      background: var(--card-soft, #FFFDF9);
      border-radius: var(--radius-sm, 12px);
      padding: 10px 12px;
      box-shadow: var(--shadow-sm, 0 1px 3px rgba(58, 50, 44, 0.06));
    }
    .onboarding-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--ink, #3A322C);
      margin-bottom: 6px;
    }
    .onboarding-hint { font-weight: 400; font-size: 12px; color: var(--ink-soft, #8A7E74); }
    .onboarding-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    .onboarding-step {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      color: var(--ink, #3A322C);
      min-height: 30px;
    }
    .onboarding-mark {
      flex: none;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1px solid var(--divider, #EDE4D8);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      color: transparent;
      background: #fff;
    }
    .onboarding-step.is-done .onboarding-mark {
      border-color: #9DBF9D;
      background: #EDF6ED;
      color: #4B7F4B;
    }
    .onboarding-step.is-done .onboarding-text { color: var(--ink-soft, #8A7E74); }
    .onboarding-text { flex: 1 1 auto; }
    .onboarding-text small { display: block; color: var(--ink-soft, #8A7E74); font-size: 11.5px; }
    .onboarding-action {
      flex: none;
      border: 1px solid var(--accent-line, #E4CBB4);
      background: #fff;
      color: var(--ink, #3A322C);
      border-radius: 8px;
      padding: 2px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    .onboarding-action:hover { background: var(--accent-soft, #F3E3D4); }
    .onboarding-step.is-done .onboarding-action { display: none; }
  `;

  const STEPS = [
    {
      key: 'model',
      title: '① 填模型',
      desc: '填一个 API 地址和 Key，她才能说话。',
      action: '去填模型',
      tab: 'model',
    },
    {
      key: 'character',
      title: '② 建角色',
      desc: '给她起个名字，性格可以慢慢改。',
      action: '去建角色',
      tab: 'character',
    },
    {
      key: 'look',
      title: '③ 传立绘',
      desc: '传一张带透明背景的 PNG（idle 帧必需）。',
      action: '去传立绘',
      tab: 'image',
    },
  ];

  const state = {
    el: null,
    busy: false,
    pending: false,
    token: 0,
    visible: false,
    onboarded: false,
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function container() {
    if (state.el && state.el.isConnected) return state.el;
    state.el = document.getElementById('onboarding');
    if (state.el) return state.el;
    // 页面里没有预留容器时自己补一个（放在消息区前面，不挡输入）
    const box = document.createElement('div');
    box.id = 'onboarding';
    box.className = 'onboarding';
    box.setAttribute('aria-label', '首次使用引导');
    box.hidden = true;
    const messages = document.getElementById('messages');
    if (messages && messages.parentNode) messages.parentNode.insertBefore(box, messages);
    else document.body.appendChild(box);
    state.el = box;
    return box;
  }

  function hide() {
    state.visible = false;
    const el = container();
    el.hidden = true;
    el.textContent = '';
  }

  function openSettings(tab) {
    if (!API) return;
    // tab 目前只是提示（主进程的 window:open 只认 target），设置窗打开后按 Tab 找
    API.invoke('window:open', { target: 'settings', tab }).catch(() => {});
  }

  function render(done) {
    const el = container();
    el.textContent = '';

    const card = document.createElement('div');
    card.className = 'onboarding-card';

    const head = document.createElement('div');
    head.className = 'onboarding-head';
    const title = document.createElement('span');
    title.textContent = '三步把她接回家';
    const hint = document.createElement('span');
    hint.className = 'onboarding-hint';
    hint.textContent = '也可以先聊两句';
    head.append(title, hint);

    const list = document.createElement('ol');
    list.className = 'onboarding-steps';
    for (const step of STEPS) {
      const item = document.createElement('li');
      item.className = 'onboarding-step' + (done[step.key] ? ' is-done' : '');
      item.dataset.step = step.key;

      const mark = document.createElement('span');
      mark.className = 'onboarding-mark';
      mark.textContent = '✓';
      mark.setAttribute('aria-label', done[step.key] ? '已完成' : '未完成');

      const text = document.createElement('div');
      text.className = 'onboarding-text';
      text.textContent = step.title;
      if (!done[step.key]) {
        const small = document.createElement('small');
        small.textContent = step.desc;
        text.appendChild(small);
      }

      item.append(mark, text);
      if (!done[step.key]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'onboarding-action';
        button.textContent = step.action;
        button.title = `打开设置 · ${step.tab}`;
        button.addEventListener('click', () => openSettings(step.tab));
        item.appendChild(button);
      }
      list.appendChild(item);
    }

    card.append(head, list);
    el.appendChild(card);
    el.hidden = false;
    state.visible = true;
  }

  /** 只读地判断三步是否完成；任何一步读失败都按「未完成」显示，不影响聊天 */
  async function computeDone(settings) {
    const done = { model: false, character: false, look: false };

    const apiCfg = settings && settings.api && typeof settings.api === 'object' ? settings.api : {};
    const profiles = Array.isArray(apiCfg.profiles) ? apiCfg.profiles : [];
    const profile = profiles.find((item) => item && item.id === apiCfg.chat) || profiles[0] || null;
    done.model = !!profile
      && profile.hasKey === true
      && typeof profile.baseUrl === 'string' && profile.baseUrl.trim() !== ''
      && typeof profile.model === 'string' && profile.model.trim() !== '';

    let characters = [];
    try {
      const list = await API.invoke('characters:list');
      characters = Array.isArray(list)
        ? list.filter((item) => item && typeof item.id === 'string' && item.id !== '')
        : [];
    } catch {
      characters = [];
    }
    done.character = characters.length > 0;

    if (characters.length > 0) {
      const wanted = settings && typeof settings.activeCharacterId === 'string'
        ? settings.activeCharacterId
        : '';
      const character = characters.find((item) => item.id === wanted) || characters[0];
      try {
        const frames = await API.invoke('characters:frames', { characterId: character.id });
        const packs = frames && typeof frames === 'object' ? Object.values(frames) : [];
        done.look = packs.some((pack) => pack && typeof pack.idle === 'string' && pack.idle !== '');
      } catch {
        done.look = false;
      }
    }
    return done;
  }

  async function persistOnboarded() {
    if (state.onboarded) return;
    state.onboarded = true;
    try {
      await API.invoke('settings:save', { onboarded: true });
    } catch {
      // 写不进设置不算致命：下次启动再提示一次而已
    }
  }

  async function refresh() {
    if (!API) return;
    // 同一时刻只跑一次；期间又收到变化就记下来，结束后补跑一遍（避免漏掉最新状态）
    if (state.busy) {
      state.pending = true;
      return;
    }
    state.busy = true;
    const token = ++state.token;
    try {
      const settings = await API.invoke('settings:get');
      if (token !== state.token) return;
      if (!settings || typeof settings !== 'object') {
        hide();
        return;
      }
      if (settings.onboarded === true) {
        state.onboarded = true;
        hide();
        return;
      }

      const done = await computeDone(settings);
      if (token !== state.token) return;

      if (done.model && done.character && done.look) {
        await persistOnboarded();
        hide();
        return;
      }
      ensureStyle();
      render(done);
    } catch {
      // 读不到设置（IPC 未就绪等）就不显示引导，别让它挡住用户
      hide();
    } finally {
      state.busy = false;
      if (state.pending) {
        state.pending = false;
        refresh();
      }
    }
  }

  window.Onboarding = {
    refresh,
    hide,
    /** 测试/调试用：当前是否显示 */
    isVisible: () => state.visible,
  };
}());
