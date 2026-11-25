'use strict';

// 设置窗口渲染层（经典 script，不用 module；只经 preload 暴露的 window.api 通主进程）。
//
// 五个 Tab：
//   模型   配置组增删改、默认聊天/后台/embedding、Key（只回显 keyHint）、测试连接
//   角色   角色切换/新建/删除、persona 全字段、生活设定
//   形象   形象包增删改、六个帧位上传（characters:importFrame）、缩放（pet:scale）与预览
//   生活   总开关、静默时段、每周主动消息、后台预算、今日用量（只读）
//   数据   数据目录/打开、导出文件夹、清空会话、删除角色、开机自启/置顶/鼠标穿透
//
// 约定：
//   - 所有用户可见文本一律走 textContent（h() 的 text 参数），绝不拼 innerHTML；
//   - 校验错误就地显示在字段下方，不弹 alert；
//   - 保存成功底部 toast「已保存」；开关类（自启/置顶/穿透）即时生效。

(function () {
  const API = window.api || null;

  const FRAMES = [
    { key: 'idle', label: '站立', required: true },
    { key: 'happy', label: '开心' },
    { key: 'sad', label: '难过' },
    { key: 'think', label: '思考' },
    { key: 'angry', label: '生气' },
    { key: 'sleepy', label: '困倦' },
  ];

  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const URL_RE = /^https?:\/\/[^\s/]+/i;
  const PREVIEW_BASE_HEIGHT = 96;
  const PROFILE_KEYS = ['social', 'structure', 'openness', 'pace', 'expressiveness'];
  const PROFILE_LABELS = {
    social: '社交',
    structure: '规律',
    openness: '开放',
    pace: '节奏',
    expressiveness: '表达',
  };
  const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const PROJECT_KINDS = {
    book: '读书',
    music: '练琴',
    drawing: '画画',
    fitness: '健身',
    other: '其他',
  };
  const PROJECT_DEFAULT_UNITS = {
    book: '页',
    music: '首',
    drawing: '张',
    fitness: '次',
    other: '次',
  };

  const el = {
    tabs: document.getElementById('tabs'),
    content: document.getElementById('content'),

    modelGuide: document.getElementById('model-guide'),
    profileList: document.getElementById('profile-list'),
    btnAddProfile: document.getElementById('btn-add-profile'),
    selChat: document.getElementById('sel-chat'),
    selBackground: document.getElementById('sel-background'),
    selEmbedding: document.getElementById('sel-embedding'),

    selCharacter: document.getElementById('sel-character'),
    btnNewCharacter: document.getElementById('btn-new-character'),
    btnDeleteCharacter: document.getElementById('btn-delete-character'),
    characterEmpty: document.getElementById('character-empty'),
    characterForm: document.getElementById('character-form'),
    charName: document.getElementById('char-name'),
    charTraits: document.getElementById('char-traits'),
    charSpeech: document.getElementById('char-speech'),
    charCatchphrases: document.getElementById('char-catchphrases'),
    charBackground: document.getElementById('char-background'),
    charRelationship: document.getElementById('char-relationship'),
    charBoundaries: document.getElementById('char-boundaries'),
    charLikes: document.getElementById('char-likes'),
    charDislikes: document.getElementById('char-dislikes'),
    charCity: document.getElementById('char-city'),
    charHome: document.getElementById('char-home'),
    charOccupation: document.getElementById('char-occupation'),
    charTone: document.getElementById('char-tone'),
    charHobbies: document.getElementById('char-hobbies'),
    charBirthYear: document.getElementById('char-birth-year'),
    charBirthMonth: document.getElementById('char-birth-month'),
    charBirthDay: document.getElementById('char-birth-day'),
    btnGenerateInner: document.getElementById('btn-generate-inner'),
    innerSource: document.getElementById('inner-source'),
    innerProfileError: document.getElementById('inner-profile-error'),
    charInnerTraits: document.getElementById('char-inner-traits'),
    charInnerBoundaries: document.getElementById('char-inner-boundaries'),
    projectList: document.getElementById('project-list'),
    projectEmpty: document.getElementById('project-empty'),
    projectTitle: document.getElementById('project-title'),
    projectKind: document.getElementById('project-kind'),
    projectProgress: document.getElementById('project-progress'),
    projectTotal: document.getElementById('project-total'),
    projectUnit: document.getElementById('project-unit'),
    btnProjectSave: document.getElementById('btn-project-save'),
    btnProjectCancel: document.getElementById('btn-project-cancel'),
    projectHint: document.getElementById('project-hint'),
    innerRanges: {
      social: document.getElementById('inner-social'),
      structure: document.getElementById('inner-structure'),
      openness: document.getElementById('inner-openness'),
      pace: document.getElementById('inner-pace'),
      expressiveness: document.getElementById('inner-expressiveness'),
    },
    innerValues: {
      social: document.getElementById('inner-social-value'),
      structure: document.getElementById('inner-structure-value'),
      openness: document.getElementById('inner-openness-value'),
      pace: document.getElementById('inner-pace-value'),
      expressiveness: document.getElementById('inner-expressiveness-value'),
    },

    imageEmpty: document.getElementById('image-empty'),
    imageBody: document.getElementById('image-body'),
    selPack: document.getElementById('sel-pack'),
    btnNewPack: document.getElementById('btn-new-pack'),
    btnRenamePack: document.getElementById('btn-rename-pack'),
    btnDeletePack: document.getElementById('btn-delete-pack'),
    scaleValue: document.getElementById('scale-value'),
    scaleRange: document.getElementById('scale-range'),
    scalePreviewImage: document.getElementById('scale-preview-image'),
  flipToggle: document.getElementById('flip-toggle'),
    scalePreviewEmpty: document.getElementById('scale-preview-empty'),
    framesGrid: document.getElementById('frames-grid'),

    lifeEnabled: document.getElementById('life-enabled'),
    lifeFrom: document.getElementById('life-from'),
    lifeTo: document.getElementById('life-to'),
    lifeProactiveMin: document.getElementById('life-proactive-min'),
    lifeProactiveMax: document.getElementById('life-proactive-max'),
    lifeBudget: document.getElementById('life-budget'),
    lifeDiaryHour: document.getElementById('life-diary-hour'),
    lifeUseWeather: document.getElementById('life-useweather'),
    lifeScheduleReview: document.getElementById('life-schedule-review'),
    lifeSilentEnd: document.getElementById('life-silent-end'),
    lifeToday: document.getElementById('life-today'),
    usageList: document.getElementById('usage-list'),
    stateBars: document.getElementById('state-bars'),
    stateSummary: document.getElementById('state-summary'),

    dataDir: document.getElementById('data-dir'),
    btnOpenDir: document.getElementById('btn-open-dir'),
    btnExport: document.getElementById('btn-export'),
    exportError: document.getElementById('export-error'),
    btnClearChat: document.getElementById('btn-clear-chat'),
    btnDangerDelete: document.getElementById('btn-danger-delete'),
    uiAutostart: document.getElementById('ui-autostart'),
    uiAlwaysTop: document.getElementById('ui-always-top'),
    uiClickThrough: document.getElementById('ui-click-through'),
    uiLanguage: document.getElementById('ui-language'),
    voiceEnabled: document.getElementById('voice-enabled'),
    voiceEngine: document.getElementById('voice-engine'),
    voiceKokoro: document.getElementById('voice-kokoro'),
    voiceRate: document.getElementById('voice-rate'),
    voiceRateValue: document.getElementById('voice-rate-value'),
    voicePreview: document.getElementById('voice-preview'),
    voiceStatus: document.getElementById('voice-status'),

    footHint: document.getElementById('foot-hint'),
    btnSave: document.getElementById('btn-save'),
    toast: document.getElementById('toast'),

    modal: document.getElementById('modal'),
    modalTitle: document.getElementById('modal-title'),
    modalMessage: document.getElementById('modal-message'),
    modalField: document.getElementById('modal-field'),
    modalFieldLabel: document.getElementById('modal-field-label'),
    modalInput: document.getElementById('modal-input'),
    modalError: document.getElementById('modal-error'),
    modalOk: document.getElementById('modal-ok'),
    modalAlt: document.getElementById('modal-alt'),
    modalCancel: document.getElementById('modal-cancel'),
  };

  const state = {
    tab: 'general',
    settings: null,
    apiDraft: null,
    lifeDraft: null,
    uiDraft: null,
    usage: null,
    lifeState: null,
    characters: [],
    characterId: null,
    characterDraft: null,
    characterDirty: false,
    innerGeneratedBy: null,
    projectEditingId: null,
    packId: 'default',
    frames: {},
    frameVersion: 0,
    scale: 1,
    profileControls: [],
  };

  let modalState = null;
  let toastTimer = null;
  let scaleTimer = null;

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'value') node.value = String(value);
        else if (key === 'on') {
          for (const [event, handler] of Object.entries(value)) {
            node.addEventListener(event, handler);
          }
        } else if (key === 'checked' || key === 'disabled' || key === 'hidden') {
          node[key] = Boolean(value);
        } else {
          node.setAttribute(key, String(value));
        }
      }
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function msgOf(error) {
    if (error && typeof error.message === 'string' && error.message) return error.message;
    return String(error || '未知错误');
  }

  function invoke(channel, payload) {
    if (!API || typeof API.invoke !== 'function') {
      return Promise.reject(new Error('界面没有连上主进程（preload 未加载）'));
    }
    return API.invoke(channel, payload);
  }

  function splitLines(value) {
    return String(value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  function toFloat(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    return text === '' ? NaN : Number(text);
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      el.toast.hidden = true;
    }, 2600);
  }

  function setFootHint(text, isError) {
    el.footHint.textContent = text || '';
    el.footHint.classList.toggle('is-error', Boolean(isError));
  }

  function errorElOf(control) {
    const field = control && typeof control.closest === 'function' ? control.closest('.field') : null;
    return field ? field.querySelector('.field-error') : null;
  }

  function setError(control, message) {
    const error = errorElOf(control);
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
    if (control && typeof control.setAttribute === 'function') {
      control.setAttribute('aria-invalid', 'true');
    }
  }

  function clearErrors() {
    for (const error of document.querySelectorAll('.field-error')) {
      if (error === el.modalError) continue;
      error.hidden = true;
      error.textContent = '';
    }
    for (const control of document.querySelectorAll('[aria-invalid="true"]')) {
      control.removeAttribute('aria-invalid');
    }
  }

  function labeledField(labelText, control) {
    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: labelText }),
      control,
      h('span', { class: 'field-error', role: 'alert', hidden: true }),
    );
  }

  function cacheBusted(url) {
    if (typeof url !== 'string' || url === '') return url;
    return `${url}${url.includes('?') ? '&' : '?'}v=${state.frameVersion}`;
  }

  // ---------------------------------------------------------------------------
  // 弹层（确认 / 单行输入）
  // ---------------------------------------------------------------------------

  function openModal(options) {
    const config = options || {};
    return new Promise((resolve) => {
      modalState = {
        resolve,
        hasField: Boolean(config.fieldLabel),
        validate: typeof config.validate === 'function' ? config.validate : null,
      };
      el.modalTitle.textContent = config.title || '确认';
      el.modalMessage.textContent = config.message || '';
      el.modalMessage.hidden = !config.message;
      el.modalField.hidden = !config.fieldLabel;
      if (config.fieldLabel) {
        el.modalFieldLabel.textContent = config.fieldLabel;
        el.modalInput.value = config.value || '';
        el.modalInput.placeholder = config.placeholder || '';
        el.modalInput.removeAttribute('aria-invalid');
      }
      el.modalError.hidden = true;
      el.modalError.textContent = '';
      el.modalOk.textContent = config.okText || '确定';
      el.modalOk.classList.toggle('btn-primary', !config.danger);
      el.modalOk.classList.toggle('btn-danger', Boolean(config.danger));
      el.modalAlt.hidden = !config.altText;
      el.modalAlt.textContent = config.altText || '';
      el.modalCancel.textContent = config.cancelText || '取消';
      el.modal.hidden = false;
      window.setTimeout(() => {
        if (modalState && config.fieldLabel) el.modalInput.focus();
        else if (modalState) el.modalOk.focus();
      }, 20);
    });
  }

  function closeModal(result) {
    if (!modalState) return;
    const pending = modalState;
    modalState = null;
    el.modal.hidden = true;
    el.modalError.hidden = true;
    el.modalError.textContent = '';
    pending.resolve(result);
  }

  function submitModal() {
    if (!modalState) return;
    if (modalState.hasField && modalState.validate) {
      const message = modalState.validate(el.modalInput.value);
      if (message) {
        el.modalError.textContent = message;
        el.modalError.hidden = false;
        el.modalInput.setAttribute('aria-invalid', 'true');
        el.modalInput.focus();
        return;
      }
    }
    closeModal(modalState.hasField ? el.modalInput.value.trim() : true);
  }

  // ---------------------------------------------------------------------------
  // 设置 / Tab
  // ---------------------------------------------------------------------------

  function applySettings(pub) {
    state.settings = pub;
    state.apiDraft = clone(pub.api);
    state.lifeDraft = clone(pub.life);
    state.uiDraft = clone(pub.ui);
    state.scale = pub.ui.petScale;
    const lang = pub.ui && pub.ui.language === 'en' ? 'en' : 'zh';
    if (window.SheI18n) window.SheI18n.apply(lang);
    renderModel();
    renderLife();
    renderData();
    if (state.characterDraft) renderImage();
  }

  function switchTab(tab) {
    state.tab = tab;
    const buttons = Array.from(el.tabs.querySelectorAll('.tab'));
    for (const button of buttons) {
      const active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const panel of document.querySelectorAll('.panel')) {
      panel.hidden = panel.dataset.panel !== tab;
    }
    el.btnSave.hidden = tab === 'data';
    setFootHint('', false);
    el.content.scrollTop = 0;

    if (tab === 'model') renderModel();
    if (tab === 'character') renderCharacter();
    if (tab === 'image') renderImage();
    if (tab === 'life') {
      renderLife();
      loadUsage();
      loadLifeState();
    }
    if (tab === 'data') {
      renderData();
      loadUsage();
    }
  }

  async function loadUsage() {
    try {
      state.usage = await invoke('usage:today');
    } catch (error) {
      state.usage = null;
    }
    renderUsage();
  }

  async function loadLifeState() {
    try {
      state.lifeState = await invoke('state:get');
    } catch (error) {
      state.lifeState = null;
    }
    renderLifeState();
  }

  /** 只读状态条：心情 / 体力 / 专注 + 一句中文描述 */
  function renderLifeState() {
    const value = state.lifeState;
    if (!value) {
      el.stateBars.replaceChildren();
      el.stateSummary.textContent = '还没有状态数据。';
      renderToday(null);
      return;
    }
    renderToday(value);
    const rows = [
      ['心情', value.mood],
      ['体力', value.energy],
      ['专注', value.focus],
    ];
    el.stateBars.replaceChildren(...rows.map(([label, amount]) => {
      const score = Math.max(0, Math.min(100, Number(amount) || 0));
      const fill = h('span', { class: 'state-fill' });
      fill.style.width = `${score}%`;
      return h(
        'div',
        { class: 'state-bar' },
        h('span', { class: 'state-label', text: label }),
        h('span', { class: 'state-track' }, fill),
        h('span', { class: 'state-value', text: String(score) }),
      );
    }));
    el.stateSummary.textContent = value.description ? `她现在：${value.description}` : '—';
  }

  // ---------------------------------------------------------------------------
  // 模型
  // ---------------------------------------------------------------------------

  function keyStatusText(profile) {
    if (!profile.hasKey) return '还没有填 Key';
    if (!profile.keyHint) return '已保存';
    if (/^\*+$/.test(profile.keyHint)) return '已保存（Key 较短）';
    return `已保存 · 尾号 ${profile.keyHint}`;
  }

  function fillProfileSelect(select, allowEmpty, currentId) {
    const profiles = state.apiDraft.profiles;
    const options = [];
    if (allowEmpty) options.push(h('option', { value: '', text: '不使用' }));
    for (const profile of profiles) {
      options.push(h('option', { value: profile.id, text: profile.name || profile.id }));
    }
    select.replaceChildren(...options);
    const ids = profiles.map((profile) => profile.id);
    if (currentId && ids.includes(currentId)) select.value = currentId;
    else select.value = allowEmpty ? '' : (ids[0] || '');
  }

  function renderModel() {
    const api = state.apiDraft;
    if (!api) return;
    const configured = api.profiles.some(
      (profile) => profile.hasKey && Array.isArray(profile.capabilities) && profile.capabilities.includes('chat'),
    );
    el.modelGuide.hidden = configured;

    state.profileControls = [];
    el.profileList.replaceChildren(...api.profiles.map(buildProfileCard));

    fillProfileSelect(el.selChat, false, api.chat);
    fillProfileSelect(el.selBackground, false, api.background);
    fillProfileSelect(el.selEmbedding, true, api.embedding || '');
  }

  function buildProfileCard(profile) {
    const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : ['chat'];
    // 新加的配置组还没落盘：先保存一次才能设置 Key / 测试（setKey 按 id 找磁盘配置）
    const persisted = Boolean(
      state.settings
      && state.settings.api
      && Array.isArray(state.settings.api.profiles)
      && state.settings.api.profiles.some((item) => item.id === profile.id),
    );
    const nameInput = h('input', {
      class: 'input', type: 'text', maxlength: '40', value: profile.name || '', autocomplete: 'off',
    });
    const baseUrlInput = h('input', {
      class: 'input', type: 'text', value: profile.baseUrl || '', autocomplete: 'off', spellcheck: 'false',
    });
    const modelInput = h('input', {
      class: 'input', type: 'text', value: profile.model || '', autocomplete: 'off', spellcheck: 'false',
    });
    const temperatureInput = h('input', {
      class: 'input', type: 'number', min: '0', max: '2', step: '0.1',
      value: Number.isFinite(profile.temperature) ? String(profile.temperature) : '',
    });
    const maxTokensInput = h('input', {
      class: 'input', type: 'number', min: '1', max: '1000000', step: '1',
      value: Number.isFinite(profile.maxTokens) ? String(profile.maxTokens) : '',
    });

    const capChat = h('input', { type: 'checkbox', checked: capabilities.includes('chat') });
    const capEmbedding = h('input', { type: 'checkbox', checked: capabilities.includes('embedding') });
    const capError = h('span', { class: 'field-error', role: 'alert', hidden: true });

    const titleName = h('span', { class: 'profile-title-name', text: profile.name || '未命名配置组' });
    const caps = h('span', { class: 'profile-caps' });

    function refreshTitle() {
      titleName.textContent = profile.name || '未命名配置组';
      caps.replaceChildren(...profile.capabilities.map(
        (cap) => h('span', { class: 'tag tag-muted', text: cap === 'embedding' ? 'embedding' : 'chat' }),
      ));
    }
    refreshTitle();

    nameInput.addEventListener('input', () => {
      profile.name = nameInput.value;
      refreshTitle();
    });
    baseUrlInput.addEventListener('input', () => {
      profile.baseUrl = baseUrlInput.value;
    });
    modelInput.addEventListener('input', () => {
      profile.model = modelInput.value;
    });
    temperatureInput.addEventListener('input', () => {
      profile.temperature = toFloat(temperatureInput.value);
    });
    maxTokensInput.addEventListener('input', () => {
      profile.maxTokens = toFloat(maxTokensInput.value);
    });

    function readCapabilities() {
      const list = [];
      if (capChat.checked) list.push('chat');
      if (capEmbedding.checked) list.push('embedding');
      profile.capabilities = list;
      refreshTitle();
    }
    capChat.addEventListener('change', readCapabilities);
    capEmbedding.addEventListener('change', readCapabilities);

    const capabilitiesField = h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label', text: '能力标签' }),
      h(
        'div',
        { class: 'capabilities' },
        h('label', { class: 'check' }, capChat, h('span', { text: 'chat（聊天）' })),
        h('label', { class: 'check' }, capEmbedding, h('span', { text: 'embedding（向量）' })),
      ),
      capError,
    );

    // ---- Key ----
    const keyStatus = persisted
      ? keyStatusText(profile)
      : '先保存配置组，再填 Key';
    const status = h('span', {
      class: `key-status${profile.hasKey && persisted ? ' is-set' : ''}`,
      text: keyStatus,
    });
    const keyInput = h('input', {
      class: 'input',
      type: 'password',
      placeholder: persisted ? '留空表示不修改' : '先保存配置组',
      autocomplete: 'new-password',
      spellcheck: 'false',
      disabled: !persisted,
    });
    const saveKeyBtn = h('button', {
      class: 'btn', type: 'button', text: '保存 Key', disabled: true,
    });
    const clearKeyBtn = h('button', {
      class: 'btn btn-danger', type: 'button', text: '清除', disabled: !persisted || !profile.hasKey,
    });

    function syncKeyUi() {
      status.textContent = persisted ? keyStatusText(profile) : '先保存配置组，再填 Key';
      status.classList.toggle('is-set', Boolean(profile.hasKey) && persisted);
      clearKeyBtn.disabled = !persisted || !profile.hasKey;
    }

    keyInput.addEventListener('input', () => {
      saveKeyBtn.disabled = !persisted || keyInput.value.trim() === '';
    });

    saveKeyBtn.addEventListener('click', async () => {
      const apiKey = keyInput.value.trim();
      if (!apiKey || !persisted) return;
      saveKeyBtn.disabled = true;
      try {
        const pub = await invoke('settings:setKey', { profileId: profile.id, apiKey });
        const fresh = (pub.api.profiles || []).find((item) => item.id === profile.id);
        if (fresh) {
          profile.hasKey = Boolean(fresh.hasKey);
          profile.keyHint = fresh.keyHint || '';
        }
        keyInput.value = '';
        syncKeyUi();
        toast('已保存');
      } catch (error) {
        toast(`保存 Key 失败：${msgOf(error)}`);
      } finally {
        saveKeyBtn.disabled = keyInput.value.trim() === '';
      }
    });

    clearKeyBtn.addEventListener('click', async () => {
      const ok = await openModal({
        title: '清除 API Key',
        message: `清除「${profile.name || profile.id}」的 Key 之后，她暂时就不能回话了。`,
        okText: '清除',
        danger: true,
      });
      if (!ok) return;
      try {
        const pub = await invoke('settings:setKey', { profileId: profile.id, apiKey: '' });
        const fresh = (pub.api.profiles || []).find((item) => item.id === profile.id);
        if (fresh) {
          profile.hasKey = Boolean(fresh.hasKey);
          profile.keyHint = fresh.keyHint || '';
        }
        syncKeyUi();
        toast('已清除');
      } catch (error) {
        toast(`清除失败：${msgOf(error)}`);
      }
    });

    const keyRow = h(
      'div',
      { class: 'key-row' },
      status,
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: 'API Key' }),
        keyInput,
        h('span', { class: 'field-error', role: 'alert', hidden: true }),
      ),
      saveKeyBtn,
      clearKeyBtn,
    );

    const testResult = h('div', { class: 'test-result', hidden: true });
    const testBtn = h('button', {
      class: 'btn', type: 'button', text: '测试连接', disabled: !persisted,
    });
    testBtn.title = persisted ? '使用已保存的配置测试' : '先保存配置组再测试';
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testResult.hidden = false;
      testResult.className = 'test-result';
      testResult.textContent = '正在测试连接…';
      try {
        const result = await invoke('settings:testProfile', { profileId: profile.id });
        if (result && result.ok) {
          const model = result.model ? ` · ${result.model}` : '';
          testResult.className = 'test-result is-ok';
          testResult.textContent = `连接成功 · ${Math.round(Number(result.latencyMs) || 0)}ms${model}`;
        } else {
          testResult.className = 'test-result is-error';
          testResult.textContent = `连接失败：${(result && result.error) || '模型没有回应'}`;
        }
      } catch (error) {
        testResult.className = 'test-result is-error';
        testResult.textContent = `连接失败：${msgOf(error)}`;
      } finally {
        testBtn.disabled = false;
      }
    });

    const deleteBtn = h('button', { class: 'btn btn-danger', type: 'button', text: '删除' });
    if (state.apiDraft.profiles.length <= 1) {
      deleteBtn.disabled = true;
      deleteBtn.title = '至少保留一个配置组';
    }
    deleteBtn.addEventListener('click', () => removeProfile(profile.id));

    state.profileControls.push({
      id: profile.id,
      name: nameInput,
      baseUrl: baseUrlInput,
      model: modelInput,
      temperature: temperatureInput,
      maxTokens: maxTokensInput,
      capability: capChat,
    });

    return h(
      'article',
      { class: 'profile' },
      h(
        'div',
        { class: 'profile-head' },
        h('div', { class: 'profile-title' }, titleName, caps),
        h('div', { class: 'profile-actions' }, testBtn, deleteBtn),
      ),
      h(
        'div',
        { class: 'field-grid' },
        labeledField('名称', nameInput),
        labeledField('baseUrl', baseUrlInput),
        labeledField('模型名', modelInput),
      ),
      h(
        'div',
        { class: 'field-grid' },
        labeledField('温度（0–2）', temperatureInput),
        labeledField('最大 token', maxTokensInput),
        capabilitiesField,
      ),
      keyRow,
      testResult,
    );
  }

  function addProfile() {
    const ids = new Set(state.apiDraft.profiles.map((profile) => profile.id));
    let id = `p${Date.now().toString(36)}`;
    while (ids.has(id)) id = `${id}x`;
    state.apiDraft.profiles.push({
      id,
      name: `新配置 ${state.apiDraft.profiles.length + 1}`,
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      temperature: 0.8,
      maxTokens: 1024,
      capabilities: ['chat'],
      hasKey: false,
      keyHint: '',
    });
    renderModel();
  }

  function removeProfile(id) {
    const profiles = state.apiDraft.profiles;
    if (profiles.length <= 1) {
      toast('至少保留一个配置组');
      return;
    }
    state.apiDraft.profiles = profiles.filter((profile) => profile.id !== id);
    const rest = state.apiDraft.profiles.map((profile) => profile.id);
    if (!rest.includes(state.apiDraft.chat)) state.apiDraft.chat = rest[0];
    if (!rest.includes(state.apiDraft.background)) state.apiDraft.background = rest[0];
    if (state.apiDraft.embedding && !rest.includes(state.apiDraft.embedding)) state.apiDraft.embedding = null;
    renderModel();
  }

  // ---------------------------------------------------------------------------
  // 角色
  // ---------------------------------------------------------------------------

  function normalizeCharacters(list) {
    return Array.isArray(list)
      ? list.filter((character) => character && typeof character.id === 'string' && character.id !== '')
      : [];
  }

  async function refreshCharacters() {
    try {
      state.characters = normalizeCharacters(await invoke('characters:list'));
    } catch (error) {
      toast(`读取角色失败：${msgOf(error)}`);
    }
    const ids = state.characters.map((character) => character.id);
    const next = ids.includes(state.characterId)
      ? state.characterId
      : (ids[0] || null);
    await selectCharacter(next);
  }

  async function selectCharacter(id) {
    const character = state.characters.find((item) => item.id === id) || null;
    state.characterId = character ? character.id : null;
    state.characterDraft = character ? clone(character) : null;
    state.characterDirty = false;
    state.innerGeneratedBy = null;
    resetProjectForm();
    const appearance = character && character.appearance ? character.appearance : {};
    const packs = Array.isArray(appearance.packs) ? appearance.packs : [];
    const activePack = packs.find((pack) => pack && pack.id === appearance.activePack) || packs[0] || null;
    state.packId = activePack ? activePack.id : 'default';
    await loadFrames();
    renderCharacter();
    renderImage();
  }

  async function loadFrames() {
    if (!state.characterId) {
      state.frames = {};
      return;
    }
    try {
      state.frames = (await invoke('characters:frames', { characterId: state.characterId })) || {};
    } catch (error) {
      state.frames = {};
    }
  }

  function replaceCharacterInList(character) {
    if (!character || typeof character.id !== 'string') return;
    const index = state.characters.findIndex((item) => item.id === character.id);
    if (index >= 0) state.characters[index] = { ...state.characters[index], ...character };
    else state.characters.push(character);
  }

  function renderCharacter() {
    el.selCharacter.replaceChildren(...state.characters.map(
      (character) => h('option', { value: character.id, text: character.name || character.id }),
    ));
    if (state.characterId) el.selCharacter.value = state.characterId;

    const draft = state.characterDraft;
    el.characterEmpty.hidden = Boolean(draft);
    el.characterForm.hidden = !draft;
    el.btnDeleteCharacter.disabled = !draft;
    if (!draft) return;

    const persona = draft.persona || {};
    const life = draft.life || {};
    el.charName.value = draft.name || '';
    el.charTraits.value = Array.isArray(persona.traits) ? persona.traits.join('\n') : '';
    el.charSpeech.value = persona.speechStyle || '';
    el.charCatchphrases.value = Array.isArray(persona.catchphrases) ? persona.catchphrases.join('\n') : '';
    el.charBackground.value = persona.background || '';
    el.charRelationship.value = persona.relationship || '';
    el.charBoundaries.value = Array.isArray(persona.boundaries) ? persona.boundaries.join('\n') : '';
    el.charLikes.value = Array.isArray(persona.likes) ? persona.likes.join('\n') : '';
    el.charDislikes.value = Array.isArray(persona.dislikes) ? persona.dislikes.join('\n') : '';
    el.charCity.value = life.city || '';
    el.charHome.value = life.home || '';
    el.charOccupation.value = life.occupation || '';
    el.charTone.value = life.tone || '';
    el.charHobbies.value = Array.isArray(life.hobbies) ? life.hobbies.join('\n') : '';
    renderInner(draft);
    renderProjects(draft);
  }

  // ---------- 生日 / 五维 / 内在设定 ----------

  function intOrNull(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? Math.round(number) : NaN;
  }

  function readBirthdayInputs() {
    const year = intOrNull(el.charBirthYear.value);
    const month = intOrNull(el.charBirthMonth.value);
    const day = intOrNull(el.charBirthDay.value);
    if (year === null && month === null && day === null) return null;
    return { calendar: 'solar', year, month, day };
  }

  function birthdayOkClient(birthday) {
    if (!birthday || typeof birthday !== 'object') return true;
    const month = birthday.month;
    const day = birthday.day;
    if (!Number.isInteger(month) || month < 1 || month > 12) return false;
    if (!Number.isInteger(day) || day < 1 || day > MONTH_MAX_DAYS[month - 1]) return false;
    if (birthday.year !== null && birthday.year !== undefined) {
      if (!Number.isInteger(birthday.year) || birthday.year < 1900 || birthday.year > 2100) return false;
    }
    return true;
  }

  function innerView(draft) {
    const persona = draft && draft.persona ? draft.persona : {};
    const inner = persona.inner && typeof persona.inner === 'object' ? persona.inner : null;
    const profile = inner && inner.profile && typeof inner.profile === 'object' ? inner.profile : {};
    return {
      inner,
      profile,
      traits: inner && Array.isArray(inner.traits) ? inner.traits : [],
      boundaries: inner && Array.isArray(inner.boundaries) ? inner.boundaries : [],
    };
  }

  /** 确保草稿里有 persona.inner（只在用户编辑或生成后调用，渲染时不要改草稿） */
  function ensureInner(draft) {
    if (!draft.persona) draft.persona = {};
    if (!draft.persona.inner || typeof draft.persona.inner !== 'object') {
      draft.persona.inner = {
        zodiac: '',
        profile: {},
        traits: [],
        boundaries: [],
        generatedAt: null,
        source: 'auto',
      };
    }
    const inner = draft.persona.inner;
    if (!inner.profile || typeof inner.profile !== 'object') inner.profile = {};
    for (const key of PROFILE_KEYS) {
      const value = Number(inner.profile[key]);
      inner.profile[key] = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 50;
    }
    if (!Array.isArray(inner.traits)) inner.traits = [];
    if (!Array.isArray(inner.boundaries)) inner.boundaries = [];
    return inner;
  }

  function innerSourceLabel(draft) {
    const view = innerView(draft);
    if (!view.inner) return '还没生成';
    if (view.inner.source === 'manual') return '来源：手动调整';
    if (state.innerGeneratedBy === 'model') return '来源：模型';
    if (state.innerGeneratedBy === 'auto') return '来源：内置规则';
    if (view.inner.generatedAt) return '已生成，可手改';
    return '还没生成';
  }

  function renderInner(draft) {
    const birthday = draft && draft.persona && draft.persona.birthday ? draft.persona.birthday : {};
    el.charBirthYear.value = birthday.year === null || birthday.year === undefined ? '' : String(birthday.year);
    el.charBirthMonth.value = birthday.month === null || birthday.month === undefined ? '' : String(birthday.month);
    el.charBirthDay.value = birthday.day === null || birthday.day === undefined ? '' : String(birthday.day);

    const view = innerView(draft);
    for (const key of PROFILE_KEYS) {
      const value = Number.isFinite(Number(view.profile[key])) ? Number(view.profile[key]) : 50;
      el.innerRanges[key].value = String(value);
      el.innerValues[key].textContent = String(value);
    }
    el.charInnerTraits.value = view.traits.join('\n');
    el.charInnerBoundaries.value = view.boundaries.join('\n');
    el.innerSource.textContent = innerSourceLabel(draft);
    el.innerProfileError.hidden = true;
    el.innerProfileError.textContent = '';
  }

  function bindBirthdayInputs() {
    const handler = () => {
      if (!state.characterDraft) return;
      state.characterDirty = true;
      if (!state.characterDraft.persona) state.characterDraft.persona = {};
      state.characterDraft.persona.birthday = readBirthdayInputs();
    };
    for (const input of [el.charBirthYear, el.charBirthMonth, el.charBirthDay]) {
      input.addEventListener('input', handler);
    }
  }

  function bindInnerControls() {
    for (const key of PROFILE_KEYS) {
      el.innerRanges[key].addEventListener('input', () => {
        if (!state.characterDraft) return;
        state.characterDirty = true;
        const inner = ensureInner(state.characterDraft);
        const value = Math.max(0, Math.min(100, Math.round(Number(el.innerRanges[key].value) || 0)));
        inner.profile[key] = value;
        inner.source = 'manual';
        el.innerValues[key].textContent = String(value);
        el.innerSource.textContent = innerSourceLabel(state.characterDraft);
      });
    }

    el.charInnerTraits.addEventListener('input', () => {
      if (!state.characterDraft) return;
      state.characterDirty = true;
      const inner = ensureInner(state.characterDraft);
      inner.traits = splitLines(el.charInnerTraits.value);
      inner.source = 'manual';
      el.innerSource.textContent = innerSourceLabel(state.characterDraft);
    });

    el.charInnerBoundaries.addEventListener('input', () => {
      if (!state.characterDraft) return;
      state.characterDirty = true;
      const inner = ensureInner(state.characterDraft);
      inner.boundaries = splitLines(el.charInnerBoundaries.value);
      inner.source = 'manual';
      el.innerSource.textContent = innerSourceLabel(state.characterDraft);
    });
  }

  async function generateInner() {
    const draft = state.characterDraft;
    if (!draft) return;

    const birthday = readBirthdayInputs();
    if (!birthday || birthday.month === null || birthday.day === null) {
      el.innerProfileError.textContent = '先填生日（月和日），再根据生日生成';
      el.innerProfileError.hidden = false;
      el.charBirthMonth.focus();
      return;
    }
    if (!birthdayOkClient(birthday)) {
      el.innerProfileError.textContent = '生日不完整或日期不合法';
      el.innerProfileError.hidden = false;
      el.charBirthMonth.focus();
      return;
    }

    // 先把生日等草稿落盘：生成用的是主进程里的角色数据
    if (!(await saveCharacterDraft())) return;

    el.btnGenerateInner.disabled = true;
    el.innerProfileError.hidden = true;
    setFootHint('正在根据生日生成内在设定…', false);
    try {
      const result = await invoke('characters:generateInner', { characterId: state.characterDraft.id });
      const character = result && result.character ? result.character : null;
      if (character) {
        state.characterDraft = clone(character);
        replaceCharacterInList(character);
      }
      state.innerGeneratedBy = result && result.source ? result.source : 'auto';
      state.characterDirty = false;
      renderCharacter();
      setFootHint('', false);
      toast(state.innerGeneratedBy === 'model' ? '已根据生日生成（来自模型）' : '已根据生日生成（内置规则）');
    } catch (error) {
      setFootHint('', false);
      el.innerProfileError.textContent = `生成失败：${msgOf(error)}`;
      el.innerProfileError.hidden = false;
    } finally {
      el.btnGenerateInner.disabled = false;
    }
  }

  // ---------- 长期项目（P5） ----------

  function projectKindLabel(kind) {
    return PROJECT_KINDS[kind] || PROJECT_KINDS.other;
  }

  function projectInt(value, min, max, fallback) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text === '') return fallback;
    const number = Number(text);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  function projectTodayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function projectListOf(draft) {
    const life = draft && typeof draft.life === 'object' && draft.life ? draft.life : {};
    return Array.isArray(life.projects) ? life.projects.filter((item) => item && typeof item === 'object') : [];
  }

  /** 展示 / 写回用的项目视图：把进度、状态、单位补齐，不依赖主进程也能显示 */
  function projectView(raw, index) {
    const title = String(raw.title || '').trim();
    if (!title) return null;
    const kind = PROJECT_KINDS[raw.kind] ? raw.kind : 'other';
    const total = projectInt(raw.total, 1, 100000, 1);
    let progress = projectInt(raw.progress, 0, total, 0);
    if (raw.status === 'done') progress = total;
    return {
      id: String(raw.id || `p${index + 1}`),
      title,
      kind,
      progress,
      total,
      startedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.startedAt || '')) ? raw.startedAt : projectTodayKey(),
      status: progress >= total ? 'done' : 'active',
      unit: String(raw.unit || '').trim() || PROJECT_DEFAULT_UNITS[kind],
    };
  }

  function currentProjectViews() {
    return projectListOf(state.characterDraft)
      .map((item, index) => projectView(item, index))
      .filter(Boolean);
  }

  function renderProjects(draft) {
    if (!el.projectList) return;
    const projects = projectListOf(draft)
      .map((item, index) => projectView(item, index))
      .filter(Boolean);
    el.projectEmpty.hidden = projects.length > 0;
    el.projectList.replaceChildren(...projects.map((project) => {
      const done = project.status === 'done';
      const row = h('li', { class: `project-item${done ? ' is-done' : ''}` });
      row.append(
        h('div', { class: 'project-main' },
          h('span', { class: 'project-title', text: project.title }),
          h('span', {
            class: 'project-meta',
            text: `${projectKindLabel(project.kind)} · ${project.progress}/${project.total} ${project.unit} · ${done ? '已完成' : '进行中'}`,
          })),
        h('div', { class: 'project-actions' },
          h('button', {
            type: 'button',
            class: 'btn',
            text: '编辑',
            on: { click: () => startProjectEdit(project) },
          }),
          h('button', {
            type: 'button',
            class: 'btn',
            text: '＋1',
            disabled: done,
            on: { click: () => stepProject(project.id) },
          }),
          h('button', {
            type: 'button',
            class: 'btn',
            text: '删除',
            on: { click: () => removeProject(project.id) },
          })),
      );
      return row;
    }));
  }

  function resetProjectForm() {
    state.projectEditingId = null;
    if (!el.projectTitle) return;
    el.projectTitle.value = '';
    el.projectKind.value = 'book';
    el.projectProgress.value = '0';
    el.projectTotal.value = '10';
    el.projectUnit.value = PROJECT_DEFAULT_UNITS.book;
    el.btnProjectSave.textContent = '添加项目';
    el.btnProjectCancel.hidden = true;
    el.projectHint.textContent = '';
  }

  function startProjectEdit(project) {
    state.projectEditingId = project.id;
    el.projectTitle.value = project.title;
    el.projectKind.value = project.kind;
    el.projectProgress.value = String(project.progress);
    el.projectTotal.value = String(project.total);
    el.projectUnit.value = project.unit;
    el.btnProjectSave.textContent = '保存修改';
    el.btnProjectCancel.hidden = false;
    el.projectHint.textContent = `正在编辑「${project.title}」`;
    el.projectTitle.focus();
  }

  /** 项目单独落盘：用磁盘上的角色打底，避免把草稿里其它未保存的字段一起提交 */
  async function persistProjects(projects) {
    const draft = state.characterDraft;
    if (!draft) return false;
    const base = state.characters.find((item) => item.id === draft.id) || draft;
    const baseLife = base.life && typeof base.life === 'object' ? base.life : {};
    const next = { ...base, life: { ...baseLife, projects } };
    try {
      const saved = await invoke('characters:save', next);
      replaceCharacterInList(saved);
      if (!draft.life || typeof draft.life !== 'object') draft.life = {};
      draft.life.projects = Array.isArray(saved.life && saved.life.projects) ? saved.life.projects : projects;
      renderProjects(draft);
      return true;
    } catch (error) {
      toast(`保存项目失败：${msgOf(error)}`);
      return false;
    }
  }

  async function saveProjectForm() {
    if (!state.characterDraft) return;
    const title = String(el.projectTitle.value || '').trim();
    if (!title) {
      toast('先填项目标题');
      el.projectTitle.focus();
      return;
    }
    const kind = PROJECT_KINDS[el.projectKind.value] ? el.projectKind.value : 'other';
    const total = projectInt(el.projectTotal.value, 0, 100000, 0);
    if (total < 1) {
      toast('目标要是大于 0 的整数');
      el.projectTotal.focus();
      return;
    }
    const progress = projectInt(el.projectProgress.value, 0, total, 0);
    const unit = String(el.projectUnit.value || '').trim() || PROJECT_DEFAULT_UNITS[kind];
    const status = progress >= total ? 'done' : 'active';
    const list = currentProjectViews();
    const editingId = state.projectEditingId;

    if (editingId) {
      const index = list.findIndex((project) => project.id === editingId);
      if (index < 0) {
        resetProjectForm();
        return;
      }
      list[index] = {
        ...list[index], title, kind, progress, total, unit, status,
      };
    } else {
      list.push({
        id: `p-${Date.now().toString(36)}-${list.length + 1}`,
        title,
        kind,
        progress,
        total,
        unit,
        startedAt: projectTodayKey(),
        status,
      });
    }

    if (await persistProjects(list)) {
      const wasEditing = Boolean(editingId);
      resetProjectForm();
      toast(wasEditing ? '项目已更新' : '项目已添加');
    }
  }

  async function stepProject(id) {
    const list = currentProjectViews();
    const index = list.findIndex((project) => project.id === id);
    if (index < 0) return;
    const project = list[index];
    if (project.status === 'done') return;
    const progress = Math.min(project.total, project.progress + 1);
    list[index] = {
      ...project,
      progress,
      status: progress >= project.total ? 'done' : 'active',
    };
    if (await persistProjects(list)) {
      const next = list[index];
      toast(`${next.title}：${next.progress}/${next.total}${next.unit}`);
    }
  }

  async function removeProject(id) {
    const project = currentProjectViews().find((item) => item.id === id);
    if (!project) return;
    const choice = await openModal({
      title: '删除项目',
      message: `删掉「${project.title}」？当前进度 ${project.progress}/${project.total} ${project.unit} 不会写进记忆。`,
      okText: '删除',
      danger: true,
    });
    if (choice !== true) return;
    const list = currentProjectViews().filter((item) => item.id !== id);
    if (state.projectEditingId === id) resetProjectForm();
    if (await persistProjects(list)) toast('项目已删除');
  }

  function bindProjectControls() {
    if (!el.projectList) return;
    el.btnProjectSave.addEventListener('click', () => {
      saveProjectForm();
    });
    el.btnProjectCancel.addEventListener('click', () => {
      resetProjectForm();
    });
    el.projectKind.addEventListener('change', () => {
      const kind = PROJECT_KINDS[el.projectKind.value] ? el.projectKind.value : 'other';
      el.projectUnit.value = PROJECT_DEFAULT_UNITS[kind];
    });
  }

  function bindPersonaLines(input, key) {
    input.addEventListener('input', () => {
      if (!state.characterDraft) return;
      state.characterDirty = true;
      if (!state.characterDraft.persona) state.characterDraft.persona = {};
      state.characterDraft.persona[key] = splitLines(input.value);
    });
  }

  function bindLifeLines(input, key) {
    input.addEventListener('input', () => {
      if (!state.characterDraft) return;
      state.characterDirty = true;
      if (!state.characterDraft.life) state.characterDraft.life = {};
      state.characterDraft.life[key] = splitLines(input.value);
    });
  }

  function bindCharacterText(input, target, key) {
    input.addEventListener('input', () => {
      if (!state.characterDraft) return;
      state.characterDirty = true;
      if (target === 'life') {
        if (!state.characterDraft.life) state.characterDraft.life = {};
        state.characterDraft.life[key] = input.value;
      } else if (target === 'persona') {
        if (!state.characterDraft.persona) state.characterDraft.persona = {};
        state.characterDraft.persona[key] = input.value;
      } else {
        state.characterDraft[key] = input.value;
      }
    });
  }

  /** 名字比较：英文大小写不敏感（toLocaleLowerCase），中文原样比较 */
  function sameCharacterName(left, right) {
    return String(left || '').trim().toLocaleLowerCase()
      === String(right || '').trim().toLocaleLowerCase();
  }

  /** 只保存角色草稿（切换角色前的「保存并切换」用，不校验模型/生活页） */
  async function saveCharacterDraft() {
    const draft = state.characterDraft;
    if (!draft) return true;
    const name = String(draft.name || '').trim();
    if (!name) {
      setError(el.charName, '名字不能为空');
      return false;
    }
    draft.name = name;
    try {
      const saved = await invoke('characters:save', draft);
      replaceCharacterInList(saved);
      state.characterDraft = clone(saved);
      state.characterDirty = false;
      renderCharacter();
      toast('已保存');
      return true;
    } catch (error) {
      toast(`保存失败：${msgOf(error)}`);
      return false;
    }
  }

  /** 有未保存修改时拦截切换：保存 / 放弃 / 取消 */
  async function guardCharacterSwitch() {
    if (!state.characterDirty || !state.characterDraft) return true;
    const choice = await openModal({
      title: '有未保存的修改',
      message: `「${state.characterDraft.name || '这个角色'}」有还没保存的修改。要保存后再切换吗？`,
      okText: '保存并切换',
      altText: '放弃修改',
      cancelText: '取消',
    });
    if (choice === null) return false;
    if (choice === 'alt') return true;
    return saveCharacterDraft();
  }

  async function createCharacter() {
    if (!(await guardCharacterSwitch())) return;
    const name = await openModal({
      title: '新建角色',
      message: '给她起个名字。之后可以在「角色」里改性格、说话方式和生活的城市。',
      fieldLabel: '名字',
      value: '她',
      okText: '创建',
      validate: (value) => (value.trim() ? null : '名字不能为空'),
    });
    if (name === null) return;
    try {
      const created = await invoke('characters:create', { name });
      state.characters = normalizeCharacters(await invoke('characters:list'));
      await selectCharacter(created.id);
      toast('已创建');
    } catch (error) {
      toast(`新建角色失败：${msgOf(error)}`);
    }
  }

  async function deleteCharacterConfirmed(draft) {
    const typed = await openModal({
      title: '删除角色',
      message: `删除「${draft.name}」会连她的记忆、聊天记录、形象一起删掉，无法恢复。\n请输入角色名「${draft.name}」确认。`,
      fieldLabel: `输入「${draft.name}」`,
      value: '',
      okText: '删除',
      danger: true,
      validate: (value) => (sameCharacterName(value, draft.name) ? null : '名字不一致，不能删除'),
    });
    if (typed === null) return;
    try {
      await invoke('characters:delete', { id: draft.id });
      state.characterId = null;
      state.characterDirty = false;
      await refreshCharacters();
      toast('角色已删除');
    } catch (error) {
      toast(`删除失败：${msgOf(error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 形象
  // ---------------------------------------------------------------------------

  function ensurePacks(draft) {
    if (!draft.appearance) draft.appearance = { activePack: 'default', scale: 1, packs: [] };
    if (!Array.isArray(draft.appearance.packs)) draft.appearance.packs = [];
    if (draft.appearance.packs.length === 0) {
      draft.appearance.packs = [{ id: 'default', name: '默认形象', frames: {} }];
    }
    // 缩放 / 朝向跟着形象包走：旧数据没有就继承当前全局缩放与角色级朝向。
    // 只在真的需要补值时换新对象，避免每次 render 都把 packs 数组整个换掉。
    const globalScale = state.settings && state.settings.ui && Number.isFinite(Number(state.settings.ui.petScale))
      ? Number(state.settings.ui.petScale)
      : 1;
    const fallbackFlip = draft.appearance.flip === true;
    let changed = false;
    draft.appearance.packs = draft.appearance.packs.map((pack) => {
      const scale = Number.isFinite(Number(pack.scale)) ? Number(pack.scale) : globalScale;
      const flip = typeof pack.flip === 'boolean' ? pack.flip : fallbackFlip;
      if (scale !== pack.scale || flip !== pack.flip) {
        changed = true;
        return { ...pack, scale, flip };
      }
      return pack;
    });
    return changed ? draft.appearance.packs : draft.appearance.packs;
  }

  function currentPack(packs) {
    return packs.find((pack) => pack && pack.id === state.packId) || packs[0] || null;
  }

  function renderImage() {
    const draft = state.characterDraft;
    el.imageEmpty.hidden = Boolean(draft);
    el.imageBody.hidden = !draft;
    if (!draft) return;

    const packs = ensurePacks(draft);
    if (!packs.some((pack) => pack.id === state.packId)) {
      state.packId = packs[0].id;
      loadFrames();
    }
    renderPackOptions(packs);
    renderPackBody(packs, draft);
  }

  /** 只重建 <option>：列表没变就不动原生下拉，避免下拉展开时重建导致卡住 */
  function renderPackOptions(packs) {
    const signature = packs.map((pack) => `${pack.id}:${pack.name || ''}`).join('|');
    if (signature !== state.packOptionsSignature) {
      state.packOptionsSignature = signature;
      el.selPack.replaceChildren(...packs.map(
        (pack) => h('option', { value: pack.id, text: pack.name || pack.id }),
      ));
    }
    el.selPack.value = state.packId;
    el.btnDeletePack.disabled = packs.length <= 1;
    el.btnRenamePack.disabled = packs.length === 0;
  }

  /** 切换形象包时只刷新区（帧位 + 缩放预览），不碰下拉本身 */
  function renderPackBody(packs, draft) {
    renderFrames(packs);
    renderScale(packs, draft);
  }

  function renderFrames(packs) {
    const urls = state.frames && state.frames[state.packId] ? state.frames[state.packId] : {};
    el.framesGrid.replaceChildren(...FRAMES.map((frame) => {
      const url = urls[frame.key] || '';
      const thumb = url
        ? h('img', { src: cacheBusted(url), alt: `${frame.label}帧预览` })
        : h('div', { class: 'frame-thumb-empty', text: '还没有图片' });
      const button = h('button', {
        class: 'btn', type: 'button', text: url ? '更换图片…' : '选择 PNG…',
      });
      button.addEventListener('click', () => uploadFrame(frame.key, button));
      return h(
        'article',
        { class: `frame-slot${url ? '' : ' is-empty'}` },
        h(
          'div',
          { class: 'frame-head' },
          h('span', { class: 'frame-name', text: `${frame.label}${frame.required ? '（必需）' : ''}` }),
          h('span', { class: 'frame-key', text: frame.key }),
        ),
        h('div', { class: 'frame-thumb' }, thumb),
        button,
      );
    }));
  }

  function renderScale(packsArg, draftArg) {
    const draft = draftArg || state.characterDraft;
    if (!draft) return;
    const packs = Array.isArray(packsArg) ? packsArg : ensurePacks(draft);
    const pack = currentPack(packs);
    const scale = Number.isFinite(Number(pack && pack.scale))
      ? Number(pack.scale)
      : (Number.isFinite(Number(state.scale)) ? Number(state.scale) : 1);
    state.scale = scale;
    el.scaleRange.value = String(scale);
    el.scaleValue.textContent = `${scale.toFixed(2)}×`;

    const flip = Boolean(pack && pack.flip === true);
    el.flipToggle.checked = flip;

    const urls = state.frames && state.frames[state.packId] ? state.frames[state.packId] : {};
    const previewUrl = urls.idle || urls.happy || urls.sad || urls.think || urls.angry || urls.sleepy || '';
    if (previewUrl) {
      el.scalePreviewImage.hidden = false;
      el.scalePreviewEmpty.hidden = true;
      el.scalePreviewImage.src = cacheBusted(previewUrl);
      el.scalePreviewImage.style.height = `${Math.round(PREVIEW_BASE_HEIGHT * scale)}px`;
      el.scalePreviewImage.style.transform = flip ? 'scaleX(-1)' : '';
    } else {
      el.scalePreviewImage.hidden = true;
      el.scalePreviewEmpty.hidden = false;
    }
  }

  async function uploadFrame(frameKey, button) {
    if (!state.characterId || !state.characterDraft) return;
    button.disabled = true;
    try {
      const picked = await invoke('dialog:pickImage');
      if (!picked || picked.canceled || !picked.path) return;
      if (!/\.png$/i.test(picked.path)) {
        toast('请选择 PNG 图片');
        return;
      }
      const result = await invoke('characters:importFrame', {
        characterId: state.characterId,
        packId: state.packId,
        frameKey,
        sourcePath: picked.path,
      });
      // 主进程把校验失败也当正常返回（不抛错），这里必须显式提示原因
      if (result && result.ok === false) {
        toast(`没导入：${result.error || '这张图片不能用'}`);
        return;
      }
      if (result && result.character && result.character.appearance) {
        state.characterDraft.appearance = result.character.appearance;
        replaceCharacterInList(result.character);
      }
      state.frameVersion += 1;
      await loadFrames();
      renderImage();
      toast('已导入，立绘立即更新');
    } catch (error) {
      toast(`导入失败：${msgOf(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  async function saveAppearanceSilently(label = '设置') {
    if (!state.characterDraft) return;
    try {
      const saved = await invoke('characters:save', state.characterDraft);
      replaceCharacterInList(saved);
      state.characterDraft.appearance = saved.appearance;
      state.characterDirty = false;
    } catch (error) {
      setFootHint(`${label}没有保存：${msgOf(error)}`, true);
    }
  }

  async function persistAppearance() {
    if (!state.characterDraft) return;
    try {
      const saved = await invoke('characters:save', state.characterDraft);
      replaceCharacterInList(saved);
      state.characterDraft.appearance = saved.appearance;
      state.characterDirty = false;
      toast('已保存');
    } catch (error) {
      toast(`保存失败：${msgOf(error)}`);
      throw error;
    }
  }

  async function createPack() {
    if (!state.characterDraft) return;
    const name = await openModal({
      title: '新建形象包',
      message: '一个形象包装一套帧位，比如「常服」「冬装」。',
      fieldLabel: '名字',
      value: '新形象',
      okText: '创建',
      validate: (value) => (value.trim() ? null : '名字不能为空'),
    });
    if (name === null) return;
    const packs = ensurePacks(state.characterDraft);
    let id = `pack${Date.now().toString(36)}`;
    while (packs.some((pack) => pack.id === id)) id = `${id}x`;
    const inherited = currentPack(packs);
    packs.push({
      id,
      name: name.trim(),
      frames: {},
      scale: inherited && Number.isFinite(Number(inherited.scale)) ? Number(inherited.scale) : 1,
      flip: inherited ? inherited.flip === true : false,
    });
    state.characterDraft.appearance.activePack = id;
    state.packId = id;
    try {
      await persistAppearance();
    } catch (error) {
      return;
    }
    await loadFrames();
    renderImage();
  }

  async function renamePack() {
    if (!state.characterDraft) return;
    const packs = ensurePacks(state.characterDraft);
    const pack = currentPack(packs);
    if (!pack) return;
    const name = await openModal({
      title: '重命名形象包',
      fieldLabel: '名字',
      value: pack.name || pack.id,
      okText: '保存',
      validate: (value) => (value.trim() ? null : '名字不能为空'),
    });
    if (name === null) return;
    pack.name = name.trim();
    try {
      await persistAppearance();
    } catch (error) {
      return;
    }
    renderImage();
  }

  async function deletePack() {
    if (!state.characterDraft) return;
    const packs = ensurePacks(state.characterDraft);
    if (packs.length <= 1) {
      toast('至少保留一个形象包');
      return;
    }
    const pack = currentPack(packs);
    if (!pack) return;
    const ok = await openModal({
      title: '删除形象包',
      message: `删除「${pack.name || pack.id}」？这个包里的帧位会从列表里去掉（图片文件留在数据目录，不会删）。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    state.characterDraft.appearance.packs = packs.filter((item) => item.id !== pack.id);
    const rest = state.characterDraft.appearance.packs;
    if (!rest.some((item) => item.id === state.characterDraft.appearance.activePack)) {
      state.characterDraft.appearance.activePack = rest[0].id;
    }
    state.packId = state.characterDraft.appearance.activePack;
    try {
      await persistAppearance();
    } catch (error) {
      return;
    }
    state.frameVersion += 1;
    await loadFrames();
    renderImage();
  }

  // ---------------------------------------------------------------------------
  // 生活 / 用量
  // ---------------------------------------------------------------------------

  function renderLife() {
    const life = state.lifeDraft;
    if (!life) return;
    el.lifeEnabled.checked = life.enabled !== false;
    el.lifeFrom.value = life.quietFrom || '';
    el.lifeTo.value = life.quietTo || '';
    el.lifeProactiveMin.value = Number.isFinite(life.proactiveWeekMin) ? String(life.proactiveWeekMin) : '';
    el.lifeProactiveMax.value = Number.isFinite(life.proactiveWeekMax) ? String(life.proactiveWeekMax) : '';
    el.lifeBudget.value = Number.isFinite(life.maxBackgroundCallsPerDay)
      ? String(life.maxBackgroundCallsPerDay)
      : '';
    el.lifeDiaryHour.value = Number.isInteger(life.diaryHour) ? String(life.diaryHour) : '';
    el.lifeUseWeather.checked = life.useWeather !== false;
    el.lifeScheduleReview.checked = life.scheduleReview !== false;
    el.lifeSilentEnd.value = Array.isArray(life.silentEndPhrases) ? life.silentEndPhrases.join('\n') : '';
    renderUsage();
  }

  const WEATHER_LABELS = {
    clear: '晴',
    cloudy: '多云',
    fog: '雾',
    rain: '雨',
    snow: '雪',
    shower: '阵雨',
    thunder: '雷雨',
  };

  /** P4：今天卡片——天气（真实温度或季节估算）、节日、节气、季节 */
  function renderToday(value) {
    const translate = (text) => (window.SheI18n ? window.SheI18n.t(text) : text);
    const en = window.SheI18n && window.SheI18n.getLanguage() === 'en';
    if (!value) {
      el.lifeToday.replaceChildren(h('div', { class: 'usage-item' }, h('dt', { text: translate('今天') }), h('dd', { text: '—' })));
      return;
    }
    const weather = value.weather;
    const label = weather ? translate(weather.label || WEATHER_LABELS[weather.code] || '天气') : '';
    const temp = weather && Number.isFinite(Number(weather.tempC)) ? ` · ${Math.round(Number(weather.tempC))}°C` : '';
    const weatherText = weather && weather.source === 'open-meteo'
      ? `${label}${temp}`
      : en
        ? `Seasonal estimate${label ? ` (${label})` : ''}`
        : `按季节估算${label ? `（${label}）` : ''}`;
    const season = value.season
      ? (en ? translate(value.season) : `${value.season}天`)
      : '—';
    const rows = [
      [translate('天气'), weatherText],
      [translate('节日'), value.holiday ? translate(value.holiday.name) : '—'],
      [translate('节气'), value.term ? translate(value.term) : '—'],
      [translate('季节'), season],
    ];
    el.lifeToday.replaceChildren(...rows.map(([key, text]) => h(
      'div',
      { class: 'usage-item' },
      h('dt', { text: key }),
      h('dd', { text: text }),
    )));
  }

  function renderUsage() {
    const usage = state.usage || {
      chat: 0, background: 0, embedding: 0, promptTokens: 0, completionTokens: 0,
    };
    const rows = [
      ['聊天次数', usage.chat],
      ['后台次数', usage.background],
      ['embedding', usage.embedding],
      ['输入 tokens', usage.promptTokens],
      ['输出 tokens', usage.completionTokens],
    ];
    el.usageList.replaceChildren(...rows.map(([label, value]) => h(
      'div',
      { class: 'usage-item' },
      h('dt', { text: label }),
      h('dd', { text: String(value) }),
    )));
  }

  // ---------------------------------------------------------------------------
  // 数据 / 通用
  // ---------------------------------------------------------------------------

  function renderData() {
    if (!state.settings) return;
    el.dataDir.textContent = state.settings.dataDir || '（未知）';
    const ui = state.uiDraft || {};
    el.uiAutostart.checked = Boolean(ui.autostart);
    el.uiAlwaysTop.checked = Boolean(ui.alwaysOnTop);
    el.uiClickThrough.checked = Boolean(ui.clickThrough);
    el.uiLanguage.value = ui.language === 'en' ? 'en' : 'zh';
    renderVoice();
  }

  /** 声音：开关 / 引擎 / 音色 / 语速 + 当前机器可用性 */
  function renderVoice() {
    const voice = (state.settings && state.settings.voice) || {};
    el.voiceEnabled.checked = voice.enabled !== false;
    el.voiceEngine.value = ['auto', 'kokoro', 'piper', 'sapi'].includes(voice.engine) ? voice.engine : 'auto';
    const kokoroVoice = voice.kokoroVoice || 'zf_xiaoxiao';
    if (![...el.voiceKokoro.options].some((item) => item.value === kokoroVoice)) {
      fillKokoroVoices([{ id: kokoroVoice, label: kokoroVoice }]);
    }
    el.voiceKokoro.value = kokoroVoice;
    const rate = Number.isFinite(Number(voice.rate)) ? Number(voice.rate) : 1;
    el.voiceRate.value = String(rate);
    el.voiceRateValue.textContent = `${rate.toFixed(2).replace(/0$/, '')}×`;
    const off = voice.enabled === false;
    const engine = el.voiceEngine.value;
    [el.voiceEngine, el.voiceRate, el.voicePreview].forEach((node) => {
      node.disabled = off;
    });
    el.voiceKokoro.disabled = off || (engine !== 'auto' && engine !== 'kokoro');
  }

  function fillKokoroVoices(list) {
    const current = el.voiceKokoro.value;
    el.voiceKokoro.textContent = '';
    for (const item of list) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label;
      el.voiceKokoro.appendChild(option);
    }
    if (current && [...el.voiceKokoro.options].some((option) => option.value === current)) {
      el.voiceKokoro.value = current;
    }
  }

  async function saveVoice(patch, input) {
    if (input) input.disabled = true;
    try {
      const pub = await invoke('settings:save', { voice: patch });
      state.settings.voice = pub.voice;
      renderVoice();
      toast('已保存');
    } catch (error) {
      toast(`设置失败：${msgOf(error)}`);
      renderVoice();
    } finally {
      if (input) input.disabled = false;
    }
  }

  function describeVoiceStatus(info) {
    const t = (window.SheI18n && typeof window.SheI18n.t === 'function')
      ? window.SheI18n.t.bind(window.SheI18n)
      : (text) => text;
    if (!info || info.ok === false) return t('状态未知');
    const kokoroOk = info.kokoro && info.kokoro.ok;
    const piperOk = info.piper && info.piper.ok;
    if (kokoroOk) return t('Kokoro 可用（离线，多音色）');
    if (piperOk) return t('Kokoro 不可用，改用 piper');
    return t('Kokoro / piper 都不可用，用系统语音');
  }

  async function refreshVoiceStatus() {
    try {
      const info = await invoke('tts:status');
      if (info && info.voice) {
        state.settings.voice = info.voice;
        renderVoice();
      }
      if (info && info.kokoro && Array.isArray(info.kokoro.voices) && info.kokoro.voices.length > 0) {
        fillKokoroVoices(info.kokoro.voices.map((item) => ({ id: item.id, label: item.label })));
        renderVoice();
      }
      el.voiceStatus.textContent = describeVoiceStatus(info);
    } catch (error) {
      el.voiceStatus.textContent = `状态读取失败：${msgOf(error)}`;
    }
  }

  async function previewVoice() {
    const Voice = window.SheVoice;
    if (!Voice || typeof Voice.say !== 'function') {
      toast('这个窗口不支持试听');
      return;
    }
    el.voicePreview.disabled = true;
    try {
      const ok = await Voice.say('嗯，我在。要不要试着跟我说句话？', { kind: 'preview' });
      if (!ok) toast('没合成出声音，看看声音引擎那条提示');
    } catch (error) {
      toast(`试听失败：${msgOf(error)}`);
    } finally {
      el.voicePreview.disabled = false;
    }
  }

  async function saveUiFlag(key, value, input) {
    input.disabled = true;
    try {
      const pub = await invoke('settings:save', { ui: { [key]: value } });
      state.settings.ui = pub.ui;
      state.uiDraft[key] = pub.ui[key];
      input.checked = Boolean(pub.ui[key]);
      toast('已保存');
    } catch (error) {
      input.checked = !value;
      toast(`设置失败：${msgOf(error)}`);
    } finally {
      input.disabled = false;
    }
  }

  async function setAutostart() {
    const enabled = el.uiAutostart.checked;
    el.uiAutostart.disabled = true;
    try {
      const result = await invoke('settings:setAutostart', { enabled });
      const saved = result && result.settings ? result.settings : null;
      const actual = saved ? saved.ui.autostart : enabled;
      if (saved) state.settings.ui = saved.ui;
      state.uiDraft.autostart = actual;
      el.uiAutostart.checked = Boolean(actual);
      if (result && result.warning) toast(result.warning);
      else toast('已保存');
    } catch (error) {
      el.uiAutostart.checked = !enabled;
      toast(`设置失败：${msgOf(error)}`);
    } finally {
      el.uiAutostart.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 保存与校验
  // ---------------------------------------------------------------------------

  function validateModel(problems) {
    const api = state.apiDraft;
    if (!api) return;
    const ids = api.profiles.map((profile) => profile.id);

    for (const control of state.profileControls) {
      const profile = api.profiles.find((item) => item.id === control.id);
      if (!profile) continue;

      const name = String(profile.name || '').trim();
      if (!name) {
        setError(control.name, '名称不能为空');
        problems.push(control.name);
      }

      const baseUrl = String(profile.baseUrl || '').trim();
      if (!URL_RE.test(baseUrl)) {
        setError(control.baseUrl, '要填 http(s):// 开头的地址');
        problems.push(control.baseUrl);
      }

      const model = String(profile.model || '').trim();
      if (!model) {
        setError(control.model, '模型名不能为空');
        problems.push(control.model);
      }

      if (!Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2) {
        setError(control.temperature, '温度应在 0–2 之间');
        problems.push(control.temperature);
      }

      if (!Number.isInteger(profile.maxTokens) || profile.maxTokens < 1 || profile.maxTokens > 1000000) {
        setError(control.maxTokens, '最大 token 应为 1–1000000 的整数');
        problems.push(control.maxTokens);
      }

      if (!Array.isArray(profile.capabilities) || profile.capabilities.length === 0) {
        setError(control.capability, '至少选一个能力标签');
        problems.push(control.capability);
      }
    }

    if (ids.length === 0) {
      problems.push(el.btnAddProfile);
      return;
    }

    if (!ids.includes(el.selChat.value)) {
      setError(el.selChat, '请选择一个聊天模型');
      problems.push(el.selChat);
    } else {
      api.chat = el.selChat.value;
    }

    if (!ids.includes(el.selBackground.value)) {
      setError(el.selBackground, '请选择一个后台模型');
      problems.push(el.selBackground);
    } else {
      api.background = el.selBackground.value;
    }

    const embedding = el.selEmbedding.value;
    if (embedding && !ids.includes(embedding)) {
      setError(el.selEmbedding, 'embedding 指向的配置组不存在');
      problems.push(el.selEmbedding);
    } else {
      api.embedding = embedding || null;
    }
  }

  function validateCharacter(problems) {
    const draft = state.characterDraft;
    if (!draft) return;
    const name = String(draft.name || '').trim();
    if (!name) {
      setError(el.charName, '名字不能为空');
      problems.push(el.charName);
    } else {
      draft.name = name;
    }

    if (!draft.persona) draft.persona = {};
    const birthday = readBirthdayInputs();
    draft.persona.birthday = birthday;
    if (birthday && !birthdayOkClient(birthday)) {
      setError(el.charBirthMonth, '生日不完整或日期不合法');
      problems.push(el.charBirthMonth);
    }
  }

  function validateLife(problems) {
    const life = state.lifeDraft;
    if (!life) return;

    if (!TIME_RE.test(el.lifeFrom.value)) {
      setError(el.lifeFrom, '时间格式应为 HH:MM');
      problems.push(el.lifeFrom);
    } else {
      life.quietFrom = el.lifeFrom.value;
    }

    if (!TIME_RE.test(el.lifeTo.value)) {
      setError(el.lifeTo, '时间格式应为 HH:MM');
      problems.push(el.lifeTo);
    } else {
      life.quietTo = el.lifeTo.value;
    }

    const weekMin = Number(el.lifeProactiveMin.value);
    const weekMax = Number(el.lifeProactiveMax.value);
    let weekRangeOk = true;
    if (!Number.isInteger(weekMin) || weekMin < 0 || weekMin > 63) {
      setError(el.lifeProactiveMin, '范围下限应为 0–63 的整数');
      problems.push(el.lifeProactiveMin);
      weekRangeOk = false;
    }
    if (!Number.isInteger(weekMax) || weekMax < 0 || weekMax > 63) {
      setError(el.lifeProactiveMax, '范围上限应为 0–63 的整数');
      problems.push(el.lifeProactiveMax);
      weekRangeOk = false;
    }
    if (weekRangeOk && weekMin > weekMax) {
      setError(el.lifeProactiveMin, '下限不能大于上限');
      setError(el.lifeProactiveMax, '上限不能小于下限');
      problems.push(el.lifeProactiveMin);
      weekRangeOk = false;
    }
    if (weekRangeOk) {
      life.proactiveWeekMin = weekMin;
      life.proactiveWeekMax = weekMax;
      delete life.proactivePerWeek;
    }

    const budget = Number(el.lifeBudget.value);
    if (!Number.isInteger(budget) || budget < 0 || budget > 100) {
      setError(el.lifeBudget, '后台上限应为 0–100 的整数');
      problems.push(el.lifeBudget);
    } else {
      life.maxBackgroundCallsPerDay = budget;
    }

    const diaryHour = Number(el.lifeDiaryHour.value);
    if (!Number.isInteger(diaryHour) || diaryHour < 0 || diaryHour > 23) {
      setError(el.lifeDiaryHour, '写日记时间应为 0–23 的整数');
      problems.push(el.lifeDiaryHour);
    } else {
      life.diaryHour = diaryHour;
    }

    life.enabled = el.lifeEnabled.checked;
    life.useWeather = el.lifeUseWeather.checked;
    life.scheduleReview = el.lifeScheduleReview.checked;
    life.silentEndPhrases = splitLines(el.lifeSilentEnd.value);
  }

  function toProfilePatch(profile) {
    return {
      id: profile.id,
      name: String(profile.name || '').trim(),
      baseUrl: String(profile.baseUrl || '').trim(),
      model: String(profile.model || '').trim(),
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      capabilities: Array.isArray(profile.capabilities) ? profile.capabilities.slice() : ['chat'],
    };
  }

  async function saveAll() {
    clearErrors();
    setFootHint('', false);

    const problems = [];
    validateModel(problems);
    validateCharacter(problems);
    validateLife(problems);

    if (problems.length > 0) {
      setFootHint(`有 ${problems.length} 处需要修改`, true);
      const first = problems.find((control) => control && typeof control.focus === 'function');
      if (first) first.focus();
      return;
    }

    el.btnSave.disabled = true;
    try {
      const patch = {
        api: {
          profiles: state.apiDraft.profiles.map(toProfilePatch),
          chat: state.apiDraft.chat,
          background: state.apiDraft.background,
          embedding: state.apiDraft.embedding || null,
        },
        life: { ...state.lifeDraft },
        ui: { language: el.uiLanguage.value === 'en' ? 'en' : 'zh' },
      };
      const saved = await invoke('settings:save', patch);
      applySettings(saved);

      if (state.characterDraft) {
        // 先把内在设定单独落盘（标记 manual），再保存整个角色，避免 draft 里的旧 inner 覆盖
        const persona = state.characterDraft.persona || {};
        if (persona.inner && typeof persona.inner === 'object') {
          const innerResult = await invoke('characters:saveInner', {
            characterId: state.characterDraft.id,
            inner: {
              zodiac: persona.inner.zodiac,
              profile: persona.inner.profile,
              traits: persona.inner.traits,
              boundaries: persona.inner.boundaries,
              generatedAt: persona.inner.generatedAt,
            },
          });
          if (innerResult && innerResult.inner) {
            if (!state.characterDraft.persona) state.characterDraft.persona = {};
            state.characterDraft.persona.inner = innerResult.inner;
          }
        }

        const savedCharacter = await invoke('characters:save', state.characterDraft);
        replaceCharacterInList(savedCharacter);
        state.characterDraft = clone(savedCharacter);
        state.characterDirty = false;
        renderCharacter();
      }
      toast('已保存');
    } catch (error) {
      setFootHint(`保存失败：${msgOf(error)}`, true);
    } finally {
      el.btnSave.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 事件绑定
  // ---------------------------------------------------------------------------

  function bindEvents() {
    el.tabs.addEventListener('click', (event) => {
      const button = event.target.closest('.tab');
      if (!button) return;
      switchTab(button.dataset.tab);
    });

    el.btnSave.addEventListener('click', () => {
      saveAll();
    });

    el.btnAddProfile.addEventListener('click', addProfile);
    el.selChat.addEventListener('change', () => {
      if (state.apiDraft) state.apiDraft.chat = el.selChat.value;
    });
    el.selBackground.addEventListener('change', () => {
      if (state.apiDraft) state.apiDraft.background = el.selBackground.value;
    });
    el.selEmbedding.addEventListener('change', () => {
      if (state.apiDraft) state.apiDraft.embedding = el.selEmbedding.value || null;
    });

    el.selCharacter.addEventListener('change', async () => {
      const id = el.selCharacter.value;
      if (!id || id === state.characterId) return;
      if (!(await guardCharacterSwitch())) {
        el.selCharacter.value = state.characterId || '';
        return;
      }
      try {
        const pub = await invoke('characters:setActive', { id });
        state.settings = pub;
        await selectCharacter(id);
      } catch (error) {
        toast(`切换角色失败：${msgOf(error)}`);
        el.selCharacter.value = state.characterId || '';
      }
    });
    el.btnNewCharacter.addEventListener('click', () => {
      createCharacter();
    });
    el.btnDeleteCharacter.addEventListener('click', async () => {
      const draft = state.characterDraft;
      if (!draft) return;
      await deleteCharacterConfirmed(draft);
    });

    bindCharacterText(el.charName, 'name', 'name');
    el.charName.addEventListener('input', () => {
      const option = el.selCharacter.selectedOptions[0];
      if (option && state.characterDraft) option.textContent = state.characterDraft.name || '未命名';
    });
    bindPersonaLines(el.charTraits, 'traits');
    bindCharacterText(el.charSpeech, 'persona', 'speechStyle');
    bindPersonaLines(el.charCatchphrases, 'catchphrases');
    bindCharacterText(el.charBackground, 'persona', 'background');
    bindCharacterText(el.charRelationship, 'persona', 'relationship');
    bindPersonaLines(el.charBoundaries, 'boundaries');
    bindPersonaLines(el.charLikes, 'likes');
    bindPersonaLines(el.charDislikes, 'dislikes');

    bindCharacterText(el.charCity, 'life', 'city');
    bindCharacterText(el.charHome, 'life', 'home');
    bindCharacterText(el.charOccupation, 'life', 'occupation');
    bindCharacterText(el.charTone, 'life', 'tone');
    bindLifeLines(el.charHobbies, 'hobbies');

    bindBirthdayInputs();
    bindInnerControls();
    bindProjectControls();
    el.btnGenerateInner.addEventListener('click', () => {
      generateInner();
    });

    el.selPack.addEventListener('change', () => {
      state.packId = el.selPack.value;
      if (state.characterDraft && state.characterDraft.appearance) {
        state.characterDraft.appearance.activePack = state.packId;
      }
      // 原生下拉刚关闭时不要重建 <option>（Windows 上会卡住）；延后只刷新内容区
      window.setTimeout(() => {
        if (!state.characterDraft) return;
        const packs = ensurePacks(state.characterDraft);
        renderPackBody(packs, state.characterDraft);
      }, 0);
    });
    el.btnNewPack.addEventListener('click', () => {
      createPack();
    });
    el.btnRenamePack.addEventListener('click', () => {
      renamePack();
    });
    el.btnDeletePack.addEventListener('click', () => {
      deletePack();
    });

    el.scaleRange.addEventListener('input', () => {
      if (!state.characterDraft) return;
      state.scale = Number(el.scaleRange.value);
      const packs = ensurePacks(state.characterDraft);
      const pack = currentPack(packs);
      if (pack) pack.scale = state.scale;
      renderScale();
      window.clearTimeout(scaleTimer);
      scaleTimer = window.setTimeout(() => {
        saveAppearanceSilently('缩放');
      }, 320);
    });

    el.flipToggle.addEventListener('change', async () => {
      if (!state.characterDraft) return;
      const flip = el.flipToggle.checked;
      const packs = ensurePacks(state.characterDraft);
      const pack = currentPack(packs);
      if (!pack) return;
      pack.flip = flip;
      renderScale();
      try {
        const saved = await invoke('characters:save', state.characterDraft);
        if (saved && saved.appearance) state.characterDraft.appearance = saved.appearance;
        replaceCharacterInList(saved);
        setFootHint(flip ? '已镜像这个形象包' : '已恢复这个形象包的原始朝向');
      } catch (error) {
        el.flipToggle.checked = !flip;
        setFootHint(`翻转没有生效：${msgOf(error)}`, true);
      }
    });

    el.lifeEnabled.addEventListener('change', () => {
      if (state.lifeDraft) state.lifeDraft.enabled = el.lifeEnabled.checked;
    });
    el.lifeFrom.addEventListener('input', () => {
      if (state.lifeDraft) state.lifeDraft.quietFrom = el.lifeFrom.value;
    });
    el.lifeTo.addEventListener('input', () => {
      if (state.lifeDraft) state.lifeDraft.quietTo = el.lifeTo.value;
    });
    el.lifeProactiveMin.addEventListener('input', () => {
      const value = Number(el.lifeProactiveMin.value);
      if (state.lifeDraft) state.lifeDraft.proactiveWeekMin = Number.isFinite(value) ? value : NaN;
    });
    el.lifeProactiveMax.addEventListener('input', () => {
      const value = Number(el.lifeProactiveMax.value);
      if (state.lifeDraft) state.lifeDraft.proactiveWeekMax = Number.isFinite(value) ? value : NaN;
    });
    el.lifeBudget.addEventListener('input', () => {
      const value = Number(el.lifeBudget.value);
      if (state.lifeDraft) state.lifeDraft.maxBackgroundCallsPerDay = Number.isFinite(value) ? value : NaN;
    });
    el.lifeDiaryHour.addEventListener('input', () => {
      const value = Number(el.lifeDiaryHour.value);
      if (state.lifeDraft) state.lifeDraft.diaryHour = Number.isFinite(value) ? value : NaN;
    });
    el.lifeScheduleReview.addEventListener('change', () => {
      if (state.lifeDraft) state.lifeDraft.scheduleReview = el.lifeScheduleReview.checked;
    });
    el.lifeSilentEnd.addEventListener('input', () => {
      if (state.lifeDraft) state.lifeDraft.silentEndPhrases = splitLines(el.lifeSilentEnd.value);
    });

    el.lifeUseWeather.addEventListener('change', () => {
      if (state.lifeDraft) state.lifeDraft.useWeather = el.lifeUseWeather.checked;
    });

    el.btnOpenDir.addEventListener('click', async () => {
      try {
        await invoke('data:openDataDir');
      } catch (error) {
        toast(`打开目录失败：${msgOf(error)}`);
      }
    });

    el.btnExport.addEventListener('click', async () => {
      el.btnExport.disabled = true;
      el.btnExport.textContent = '正在导出…';
      el.exportError.hidden = true;
      el.exportError.textContent = '';
      try {
        const result = await invoke('data:export');
        if (result && result.canceled) return;
        if (!result || result.ok !== true) throw new Error('导出没有完成');
        toast(`已导出到 ${result.path}`);
      } catch (error) {
        el.exportError.textContent = `导出失败：${msgOf(error)}`;
        el.exportError.hidden = false;
      } finally {
        el.btnExport.disabled = false;
        el.btnExport.textContent = '导出全部数据…';
      }
    });

    el.btnClearChat.addEventListener('click', async () => {
      const draft = state.characterDraft;
      if (!draft) {
        toast('还没有角色');
        return;
      }
      const ok = await openModal({
        title: '清空会话',
        message: `清空你和「${draft.name}」的聊天记录？她的记忆和形象会保留。`,
        okText: '清空',
        danger: true,
      });
      if (!ok) return;
      try {
        await invoke('chat:clear', { characterId: draft.id });
        toast('会话已清空');
      } catch (error) {
        toast(`清空失败：${msgOf(error)}`);
      }
    });

    el.btnDangerDelete.addEventListener('click', async () => {
      const draft = state.characterDraft;
      if (!draft) {
        toast('还没有角色');
        return;
      }
      await deleteCharacterConfirmed(draft);
    });

    el.uiAutostart.addEventListener('change', setAutostart);
    el.uiAlwaysTop.addEventListener('change', () => {
      saveUiFlag('alwaysOnTop', el.uiAlwaysTop.checked, el.uiAlwaysTop);
    });
    el.uiClickThrough.addEventListener('change', () => {
      saveUiFlag('clickThrough', el.uiClickThrough.checked, el.uiClickThrough);
    });

    el.voiceEnabled.addEventListener('change', () => {
      saveVoice({ enabled: el.voiceEnabled.checked });
    });
    el.voiceEngine.addEventListener('change', () => {
      saveVoice({ engine: el.voiceEngine.value });
      renderVoice();
      refreshVoiceStatus();
    });
    el.voiceKokoro.addEventListener('change', () => {
      saveVoice({ kokoroVoice: el.voiceKokoro.value });
    });
    el.voiceRate.addEventListener('input', () => {
      const value = Number(el.voiceRate.value);
      el.voiceRateValue.textContent = `${(Number.isFinite(value) ? value : 1).toFixed(2).replace(/0$/, '')}×`;
    });
    el.voiceRate.addEventListener('change', () => {
      saveVoice({ rate: Number(el.voiceRate.value) });
    });
    el.voicePreview.addEventListener('click', previewVoice);

    el.modalOk.addEventListener('click', submitModal);
    el.modalAlt.addEventListener('click', () => closeModal('alt'));
    el.modalCancel.addEventListener('click', () => closeModal(null));
    el.modal.addEventListener('click', (event) => {
      if (event.target === el.modal) closeModal(null);
    });
    el.modalInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitModal();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modalState) {
        event.preventDefault();
        closeModal(null);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  async function loadAll() {
    try {
      const pub = await invoke('settings:get');
      applySettings(pub);
      // 声音状态是延迟探测的（要起子进程），不挡住设置页首屏
      refreshVoiceStatus();
    } catch (error) {
      setFootHint(`读取设置失败：${msgOf(error)}`, true);
      el.btnSave.disabled = true;
      return;
    }

    try {
      state.characters = normalizeCharacters(await invoke('characters:list'));
    } catch (error) {
      state.characters = [];
      toast(`读取角色失败：${msgOf(error)}`);
    }

    const settings = state.settings || {};
    const preferred = state.characters.find((item) => item.id === settings.activeCharacterId)
      || state.characters[0]
      || null;
    await selectCharacter(preferred ? preferred.id : null);
    await loadUsage();
    await loadLifeState();
    renderModel();
    renderCharacter();
    renderImage();
    renderLife();
    renderData();
  }

  async function init() {
    bindEvents();
    switchTab('general');
    if (!API) {
      setFootHint('界面没有连上主进程（preload 未加载）', true);
      el.btnSave.disabled = true;
      return;
    }
    await loadAll();
    switchTab('general');
  }

  init();
}());
