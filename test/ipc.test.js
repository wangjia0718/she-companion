'use strict';

// Task 9：IPC 通道表的行为测试。不启动 Electron，用 fake ipcMain + 临时数据目录。
// 覆盖：通道全覆盖 / 未知通道 / 设置脱敏 / 角色 CRUD / 流式成功与失败 / 停止 /
//       记忆改盘 / timeline 空数据 / 窗口穿透参数 / preload 白名单不漂移。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ipc = require('../src/main/ipc');
const config = require('../src/main/config');
const store = require('../src/main/store');
const memory = require('../src/main/memory');
const usage = require('../src/main/usage');

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const RENDERER_PAGE = path.join(__dirname, '..', 'src', 'renderer', 'chat', 'chat.html');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-ipc-'));
}

/** 最小合法 RGBA PNG（签名 + IHDR，1×1，colorType 6）：importFrame 只校验结构，不解压像素 */
function validPng() {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(1, 16);
  buf.writeUInt32BE(1, 20);
  buf[24] = 8; // bitDepth
  buf[25] = 6; // colorType RGBA
  return buf;
}

function fakeIpcMain() {
  const table = new Map();
  return {
    table,
    handle(channel, listener) {
      table.set(channel, listener);
    },
    invoke(channel, payload, senderUrl = pathToFileURL(RENDERER_PAGE).href) {
      const listener = table.get(channel);
      if (!listener) throw new Error(`no handler: ${channel}`);
      return listener({ sender: {}, senderFrame: { url: senderUrl } }, payload);
    },
  };
}

function makeEmit() {
  const events = [];
  const emit = (event, payload) => {
    events.push({ event, payload });
  };
  emit.events = events;
  emit.names = () => events.map((item) => item.event);
  return emit;
}

function makeWindows() {
  const calls = [];
  const pet = {
    isDestroyed: () => false,
    setIgnoreMouseEvents(flag, options) {
      calls.push({ method: 'setIgnoreMouseEvents', flag, options });
    },
    setPosition(x, y) {
      calls.push({ method: 'setPosition', x, y });
    },
    getBounds() {
      return { x: 0, y: 0, width: 220, height: 380 };
    },
    setContentSize(width, height) {
      calls.push({ method: 'setContentSize', width, height });
    },
    setAlwaysOnTop(value, level) {
      calls.push({ method: 'setAlwaysOnTop', value, level });
    },
  };
  const windows = {
    pet,
    chat: { isDestroyed: () => false },
    settings: { isDestroyed: () => false },
    calls,
    get() {
      return windows;
    },
    open(target, options) {
      calls.push({ method: 'open', target, options });
    },
  };
  return windows;
}

function defaultLlm() {
  return {
    chat: async () => ({
      text: '嗯。',
      usage: { promptTokens: 10, completionTokens: 2, estimated: false },
      model: 'mock',
    }),
    testProfile: async () => ({ ok: true, latencyMs: 5, model: 'mock', error: null }),
  };
}

function setup(options = {}) {
  const dir = options.dir || tmpDir();
  const nowDate = options.now || new Date('2026-10-26T21:00:00+08:00');
  const emit = makeEmit();
  const windows = makeWindows();
  const tasks = [];
  const system = { opened: [], autostart: [] };

  const handlers = ipc.createHandlers({
    dir,
    emit,
    windows,
    now: () => nowDate,
    onBackgroundTask: (promise) => tasks.push(promise),
    config: options.config || config,
    store: options.store || store,
    usage: options.usage || usage,
    llm: options.llm || defaultLlm(),
    memory: options.memory || { ...memory, extractFromChat: async () => [] },
    workArea: options.workArea,
    openPath: options.openPath || ((target) => {
      system.opened.push(target);
      return Promise.resolve('');
    }),
    pickDirectory: options.pickDirectory,
    pickImage: options.pickImage,
    setAutostart: options.setAutostart || ((enabled) => {
      system.autostart.push(enabled);
    }),
    isPackaged: options.isPackaged,
  });

  const ipcMain = fakeIpcMain();
  ipc.register(ipcMain, handlers);

  return {
    dir, nowDate, emit, windows, tasks, handlers, ipcMain, system,
  };
}

test('通道清单全覆盖，未知通道与缺实现都报错', () => {
  const ctx = setup();
  for (const channel of ipc.CHANNELS) {
    assert.equal(typeof ctx.handlers[channel], 'function', `缺少通道 ${channel}`);
  }
  assert.equal(Object.keys(ctx.handlers).length, ipc.CHANNELS.length);

  // preload 白名单不能和主进程漂移
  const preload = fs.readFileSync(PRELOAD, 'utf8');
  for (const channel of ipc.CHANNELS) {
    assert.ok(preload.includes(`'${channel}'`), `preload 缺少通道 ${channel}`);
  }
  for (const event of ipc.EVENTS) {
    assert.ok(preload.includes(`'${event}'`), `preload 缺少事件 ${event}`);
  }

  assert.throws(
    () => ipc.dispatch(ctx.handlers, 'nope:channel', {}, {}),
    /unknown channel/,
  );

  const incomplete = { ...ctx.handlers };
  delete incomplete['chat:stop'];
  assert.throws(() => ipc.register(fakeIpcMain(), incomplete), /chat:stop/);
});

test('settings:get 返回脱敏结果，不含 apiKey', () => {
  const ctx = setup();
  config.saveSettings(ctx.dir, {
    api: {
      profiles: [{
        id: 'p1',
        name: '测试',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret-abcd1234',
        model: 'm',
        capabilities: ['chat'],
      }],
    },
  });

  const pub = ctx.ipcMain.invoke('settings:get');
  assert.equal(pub.api.profiles[0].apiKey, undefined);
  assert.ok(!JSON.stringify(pub).includes('sk-secret-abcd1234'));
  assert.equal(pub.api.profiles[0].hasKey, true);
  assert.equal(pub.api.profiles[0].keyHint, '1234');
});

test('settings:setKey 只改目标配置组，回传仍是脱敏结果', () => {
  const ctx = setup();
  const pub = ctx.ipcMain.invoke('settings:setKey', { profileId: 'p1', apiKey: 'sk-new-key-9999' });
  assert.ok(!JSON.stringify(pub).includes('sk-new-key-9999'));
  const disk = config.loadSettings(ctx.dir);
  assert.equal(disk.api.profiles.find((p) => p.id === 'p1').apiKey, 'sk-new-key-9999');
});

test('characters:create → list 可见，delete 后不可见', () => {
  const ctx = setup();
  const created = ctx.ipcMain.invoke('characters:create', { name: '小满' });
  assert.equal(created.name, '小满');

  const list = ctx.ipcMain.invoke('characters:list');
  assert.ok(list.some((item) => item.id === created.id));
  // 新建后没有 active 时自动设成当前角色
  assert.equal(config.loadSettings(ctx.dir).activeCharacterId, created.id);

  ctx.ipcMain.invoke('characters:delete', { id: created.id });
  const after = ctx.ipcMain.invoke('characters:list');
  assert.ok(!after.some((item) => item.id === created.id));
  assert.equal(config.loadSettings(ctx.dir).activeCharacterId, null);
});

test('characters:importFrame 复制图片并写回帧位', () => {
  const ctx = setup();
  const created = ctx.ipcMain.invoke('characters:create', { name: '她' });
  const source = path.join(ctx.dir, 'frame.png');
  fs.writeFileSync(source, validPng());

  const result = ctx.ipcMain.invoke('characters:importFrame', {
    characterId: created.id,
    packId: 'default',
    frameKey: 'happy',
    sourcePath: source,
  });

  assert.equal(result.ok, true);
  assert.equal(result.relPath, path.posix.join('assets', 'pack-default', 'happy.png'));
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  const target = path.join(ctx.dir, 'characters', created.id, result.relPath);
  assert.ok(fs.existsSync(target));
  const saved = store.listCharacters(ctx.dir).find((item) => item.id === created.id);
  assert.equal(saved.appearance.packs[0].frames.happy, result.relPath);

  // 帧位 URL 带文件修改时间做缓存戳，换图后小人窗无需重启
  const frames = ctx.ipcMain.invoke('characters:frames', { characterId: created.id });
  const url = frames && frames.default && frames.default.happy;
  assert.ok(typeof url === 'string' && url.startsWith('file://'));
  assert.match(url, /\?v=\d+/);
});

test('characters:importFrame 校验失败返回 ok:false 中文原因，不写文件', () => {
  const ctx = setup();
  const created = ctx.ipcMain.invoke('characters:create', { name: '她' });

  const jpeg = path.join(ctx.dir, 'photo.png'); // 扩展名伪装成 PNG，内容仍是 JPEG
  fs.writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]));
  const bad = ctx.ipcMain.invoke('characters:importFrame', {
    characterId: created.id,
    packId: 'default',
    frameKey: 'idle',
    sourcePath: jpeg,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /PNG/);

  const opaque = path.join(ctx.dir, 'opaque.png');
  const opaqueBytes = validPng();
  opaqueBytes[24] = 8; // bitDepth
  opaqueBytes[25] = 2; // colorType 2 = 无 alpha
  fs.writeFileSync(opaque, opaqueBytes);
  const noAlpha = ctx.ipcMain.invoke('characters:importFrame', {
    characterId: created.id,
    packId: 'default',
    frameKey: 'idle',
    sourcePath: opaque,
  });
  assert.equal(noAlpha.ok, false);
  assert.match(noAlpha.error, /透明/);

  assert.equal(fs.existsSync(path.join(ctx.dir, 'characters', created.id, 'assets', 'pack-default')), false);
});

test('chat:send 成功：三个 delta 后 chat:done，消息落盘并记账', async () => {
  const deltas = ['你', '好', '呀'];
  const ctx = setup({
    llm: {
      chat: async ({ onDelta }) => {
        for (const delta of deltas) onDelta(delta);
        return {
          text: deltas.join(''),
          usage: { promptTokens: 20, completionTokens: 3, estimated: false },
          model: 'mock',
        };
      },
      testProfile: async () => ({ ok: true }),
    },
  });
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });

  const result = await ctx.ipcMain.invoke('chat:send', { text: '在吗' });
  await Promise.all(ctx.tasks);

  assert.equal(result.ok, true);
  assert.equal(result.stopped, false);

  const chatEvents = ctx.emit.events.filter((item) => item.event.startsWith('chat:'));
  assert.deepEqual(chatEvents.map((item) => item.event), [
    'chat:delta', 'chat:delta', 'chat:delta', 'chat:done',
  ]);
  assert.deepEqual(
    chatEvents.slice(0, 3).map((item) => item.payload.text),
    deltas,
  );
  assert.equal(chatEvents[3].payload.stopped, false);

  const messages = store.readMessages(ctx.dir, character.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, '在吗');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].text, '你好呀');
  assert.equal(messages[1].tokens, 3);

  assert.equal(usage.today(ctx.dir, ctx.nowDate).chat, 1);
});

test('chat:send 失败：发 chat:error，用户消息仍保留', async () => {
  const ctx = setup({
    llm: {
      chat: async () => {
        const error = new Error('密钥无效或权限不足（HTTP 401）');
        error.code = 'AUTH';
        throw error;
      },
      testProfile: async () => ({ ok: false }),
    },
  });
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });

  const result = await ctx.ipcMain.invoke('chat:send', { text: '在吗' });
  await Promise.all(ctx.tasks);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTH');

  const chatEvents = ctx.emit.events.filter((item) => item.event.startsWith('chat:'));
  assert.deepEqual(chatEvents.map((item) => item.event), ['chat:error']);
  assert.equal(chatEvents[0].payload.code, 'AUTH');
  assert.match(chatEvents[0].payload.message, /密钥无效/);

  const messages = store.readMessages(ctx.dir, character.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, '在吗');
  assert.equal(usage.today(ctx.dir, ctx.nowDate).chat, 0);
});

test('chat:stop 中断流并保留已生成内容、标注（中断）', async () => {
  let sawAbort = false;
  const ctx = setup({
    llm: {
      chat: ({ onDelta, signal }) => new Promise((resolve, reject) => {
        onDelta('我');
        signal.addEventListener('abort', () => {
          sawAbort = true;
          const error = new Error('已取消本次请求');
          error.code = 'ABORTED';
          error.partialText = '我';
          reject(error);
        }, { once: true });
      }),
      testProfile: async () => ({ ok: false }),
    },
  });
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });

  const pending = ctx.ipcMain.invoke('chat:send', { text: '说点啥' });
  await new Promise((resolve) => setImmediate(resolve));

  const stopped = ctx.ipcMain.invoke('chat:stop');
  assert.equal(stopped.stopped, true);

  const result = await pending;
  await Promise.all(ctx.tasks);

  assert.equal(sawAbort, true);
  assert.equal(result.ok, true);
  assert.equal(result.stopped, true);
  assert.ok(result.message.text.includes('我'));
  assert.ok(result.message.text.includes('（中断）'));
  assert.equal(result.message.stopped, true);

  const messages = store.readMessages(ctx.dir, character.id);
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'assistant');
  assert.ok(last.text.includes('（中断）'));

  const done = ctx.emit.events.find((item) => item.event === 'chat:done');
  assert.ok(done);
  assert.equal(done.payload.stopped, true);
  assert.ok(!ctx.emit.names().includes('chat:error'));
});

test('memory:update / memory:delete 改到磁盘，删除写入 suppressed', () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });

  const added = ctx.ipcMain.invoke('memory:add', {
    text: '用户下周要交季度方案',
    kind: 'event',
    importance: 3,
  });
  assert.equal(added.cards.length, 1);
  const card = added.cards[0];

  ctx.ipcMain.invoke('memory:update', {
    id: card.id,
    text: '用户下周三要交季度方案',
    importance: 5,
    kind: 'fact',
  });

  const updated = store.readMemory(ctx.dir, character.id);
  assert.equal(updated.cards[0].id, card.id);
  assert.equal(updated.cards[0].text, '用户下周三要交季度方案');
  assert.equal(updated.cards[0].importance, 5);
  assert.equal(updated.cards[0].kind, 'fact');
  assert.equal(updated.cards[0].variants[updated.cards[0].variants.length - 1], '用户下周三要交季度方案');

  ctx.ipcMain.invoke('memory:delete', { id: card.id });

  const after = store.readMemory(ctx.dir, character.id);
  assert.equal(after.cards.length, 0);
  assert.ok(Array.isArray(after.suppressed));
  assert.equal(after.suppressed.length, 1);
  assert.equal(after.suppressed[0].norm, memory.normalizeText('用户下周三要交季度方案'));
  assert.ok(after.suppressed[0].until);
});

test('timeline:get 无数据时返回空结构不抛', () => {
  const ctx = setup();
  ctx.ipcMain.invoke('characters:create', { name: '她' });

  const timeline = ctx.ipcMain.invoke('timeline:get');
  assert.deepEqual(timeline.days, {});
  assert.equal(timeline.today, null);
});

test('timeline:deleteDiary 只删指定日期日记，保留当天其他数据且不自动补写', () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  const events = [{ time: '08:00', text: '保留了这一条事件' }];
  store.writeTimeline(ctx.dir, character.id, {
    days: {
      '2026-10-24': { diary: '前天的日记', diaryAt: '2026-10-24T23:00:00+08:00' },
      '2026-10-25': { diary: '昨天的日记', diaryAt: '2026-10-25T23:00:00+08:00', events },
      '2026-10-26': { diary: '今天的日记', diaryAt: '2026-10-26T21:00:00+08:00' },
    },
  });

  const result = ctx.ipcMain.invoke('timeline:deleteDiary', { date: '2026-10-25' });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);

  const after = store.readTimeline(ctx.dir, character.id);
  assert.equal(after.days['2026-10-25'].diary, undefined);
  assert.equal(after.days['2026-10-25'].diaryAt, undefined);
  assert.equal(after.days['2026-10-25'].diaryAttempted, true);
  assert.deepEqual(after.days['2026-10-25'].events, events);
  assert.equal(after.days['2026-10-24'].diary, '前天的日记');
  assert.equal(after.days['2026-10-26'].diary, '今天的日记');

  const file = path.join(ctx.dir, 'characters', character.id, 'timeline.json');
  const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.equal(backup.days['2026-10-25'].diary, undefined, '.bak 也不应留下刚删的日记');

  assert.throws(
    () => ctx.ipcMain.invoke('timeline:deleteDiary', { date: '2026-02-31' }),
    /日期不合法/,
  );
});

test('state:get 返回默认状态与一句中文描述，且不写盘', () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });

  const value = ctx.ipcMain.invoke('state:get');
  assert.equal(value.characterId, character.id);
  assert.equal(value.mood, 62);
  assert.equal(value.energy, 60);
  assert.equal(value.focus, 55);
  assert.match(value.description, /心情/);
  assert.equal(
    fs.existsSync(path.join(ctx.dir, 'characters', character.id, 'state.json')),
    false,
    '只读接口不应该创建 state.json',
  );
});

test('chat:send 成功后微调状态（正面 +2 心情 / -1 体力）', async () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });

  await ctx.ipcMain.invoke('chat:send', { text: '今天天气真好' });
  const saved = store.readJSON(
    path.join(ctx.dir, 'characters', character.id, 'state.json'),
    null,
  );
  assert.ok(saved, '聊天后应写入 state.json');
  assert.equal(saved.mood, 64);
  assert.equal(saved.energy, 59);
  assert.equal(saved.focus, 55);
});

test('createExtractor 合并抽取结果并带 suppressed 落盘', async () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  await ctx.ipcMain.invoke('chat:send', { text: '我最近在学做手冲咖啡' });
  await Promise.all(ctx.tasks);

  const extractor = ipc.createExtractor({
    dir: ctx.dir,
    config,
    store,
    now: () => ctx.nowDate,
    memory: {
      ...memory,
      extractFromChat: async () => [{ kind: 'preference', text: '用户最近在学做手冲咖啡', importance: 4 }],
    },
  });
  await extractor(character.id);

  const saved = store.readMemory(ctx.dir, character.id);
  assert.equal(saved.cards.length, 1);
  assert.equal(saved.cards[0].text, '用户最近在学做手冲咖啡');
  assert.ok(Array.isArray(saved.suppressed));
  assert.ok(saved.lastExtractedMessageId);
  assert.ok(saved.lastExtractedAt);
});

test('pet:setIgnore 调 setIgnoreMouseEvents(flag, { forward: true })', () => {
  const ctx = setup();
  const result = ctx.ipcMain.invoke('pet:setIgnore', true);
  assert.equal(result.ignore, true);

  const call = ctx.windows.calls.find((item) => item.method === 'setIgnoreMouseEvents');
  assert.ok(call);
  assert.equal(call.flag, true);
  assert.deepEqual(call.options, { forward: true });
});

test('window:open 只接受三个窗口白名单', () => {
  const ctx = setup();
  assert.deepEqual(ctx.ipcMain.invoke('window:open', { target: 'chat' }), { ok: true, target: 'chat' });
  assert.ok(ctx.windows.calls.some((item) => item.method === 'open' && item.target === 'chat'));
  assert.throws(() => ctx.ipcMain.invoke('window:open', { target: 'evil' }), /未知的窗口/);
});

test('window:open 带 characterId 时把角色传给主进程，托盘浮层可直达对应聊天', () => {
  const ctx = setup();
  const result = ctx.ipcMain.invoke('window:open', { target: 'chat', characterId: 'char-1' });
  assert.deepEqual(result, { ok: true, target: 'chat', characterId: 'char-1' });
  const call = ctx.windows.calls.filter((item) => item.method === 'open').pop();
  assert.equal(call.target, 'chat');
  assert.deepEqual(call.options, { characterId: 'char-1' });
});

test('chat:markRead 推进已读水位，tray:unread 汇总未读角色', () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '小满' });
  store.appendMessage(ctx.dir, character.id, {
    role: 'assistant',
    text: '在吗',
    ts: '2026-10-26T09:00:00+08:00',
    unread: true,
  });

  const before = ctx.ipcMain.invoke('tray:unread');
  assert.equal(before.total, 1);
  assert.equal(before.items[0].name, '小满');

  const at = Date.parse('2026-10-26T09:30:00+08:00');
  const result = ctx.ipcMain.invoke('chat:markRead', { characterId: character.id, at });
  assert.equal(result.readAt, at);
  assert.equal(ctx.ipcMain.invoke('tray:unread').total, 0);
});

// ---------------------------------------------------------------------------
// 11 个通道的行为断言（不只检查“存在”）
// ---------------------------------------------------------------------------

test('settings:save 合并写入磁盘并应用置顶设置', () => {
  const ctx = setup();
  const pub = ctx.ipcMain.invoke('settings:save', { ui: { petScale: 1.3, alwaysOnTop: false } });

  assert.equal(pub.ui.petScale, 1.3);
  assert.equal(pub.ui.alwaysOnTop, false);
  assert.equal(config.loadSettings(ctx.dir).ui.petScale, 1.3);
  assert.ok(ctx.windows.calls.some((item) => item.method === 'setAlwaysOnTop' && item.value === false));
  assert.ok(ctx.emit.names().includes('state:changed'));
});

test('settings:testProfile 用磁盘上完整配置（含 key）测试连接', async () => {
  let received = null;
  const ctx = setup({
    llm: {
      chat: defaultLlm().chat,
      testProfile: async (profile) => {
        received = profile;
        return { ok: true, latencyMs: 7, model: profile.model, error: null };
      },
    },
  });
  config.saveSettings(ctx.dir, {
    api: {
      profiles: [{
        id: 'p1',
        name: '测试',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-abc-1234',
        model: 'm',
        capabilities: ['chat'],
      }],
    },
  });

  const result = await ctx.ipcMain.invoke('settings:testProfile', { profileId: 'p1' });
  assert.equal(result.ok, true);
  assert.equal(result.latencyMs, 7);
  assert.equal(received.apiKey, 'sk-abc-1234');
  assert.equal(received.model, 'm');
  await assert.rejects(
    ctx.ipcMain.invoke('settings:testProfile', { profileId: 'nope' }),
    /找不到这个配置组/,
  );
});

test('characters:save 改名字后磁盘与列表同步', () => {
  const ctx = setup();
  const created = ctx.ipcMain.invoke('characters:create', { name: '她' });
  const saved = ctx.ipcMain.invoke('characters:save', { ...created, name: '小满' });

  assert.equal(saved.name, '小满');
  const fromDisk = store.listCharacters(ctx.dir).find((item) => item.id === created.id);
  assert.equal(fromDisk.name, '小满');
});

test('characters:setActive 切换当前角色并持久化', () => {
  const ctx = setup();
  const first = ctx.ipcMain.invoke('characters:create', { name: '一' });
  const second = ctx.ipcMain.invoke('characters:create', { name: '二' });

  const pub = ctx.ipcMain.invoke('characters:setActive', { id: second.id });
  assert.equal(pub.activeCharacterId, second.id);
  assert.equal(config.loadSettings(ctx.dir).activeCharacterId, second.id);
  assert.notEqual(first.id, second.id);
});

test('chat:history 返回刚聊过的两条消息', async () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  await ctx.ipcMain.invoke('chat:send', { text: '在吗' });

  const history = ctx.ipcMain.invoke('chat:history', { characterId: character.id });
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((item) => item.role), ['user', 'assistant']);
  assert.equal(history[0].text, '在吗');
});

test('chat:clear 清空当前角色会话', async () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  await ctx.ipcMain.invoke('chat:send', { text: '在吗' });
  assert.equal(store.readMessages(ctx.dir, character.id).length, 2);

  const result = ctx.ipcMain.invoke('chat:clear', { characterId: character.id });
  assert.deepEqual(result, { ok: true, characterId: character.id });
  assert.equal(store.readMessages(ctx.dir, character.id).length, 0);
});

test('memory:list 返回卡片与 suppressed 数组', () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  ctx.ipcMain.invoke('memory:add', { text: '用户养了一只猫', kind: 'fact' });

  const listed = ctx.ipcMain.invoke('memory:list', { characterId: character.id });
  assert.equal(listed.characterId, character.id);
  assert.equal(listed.cards.length, 1);
  assert.equal(listed.cards[0].text, '用户养了一只猫');
  assert.ok(Array.isArray(listed.suppressed));
});

test('pet:getState 返回缩放、位置与当前角色', () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });

  const state = ctx.ipcMain.invoke('pet:getState');
  assert.equal(state.scale, 1.0);
  assert.deepEqual(state.pos, { x: null, y: null });
  assert.equal(state.character.id, character.id);
  assert.equal(state.ui.clickThrough, false);
  assert.equal(state.bubble, null);
});

test('pet:move 保存坐标并移动窗口', () => {
  const ctx = setup();
  const result = ctx.ipcMain.invoke('pet:move', { x: 12.6, y: -4.2 });

  assert.deepEqual(result, { x: 13, y: -4 });
  assert.deepEqual(config.loadSettings(ctx.dir).ui.petPos, { x: 13, y: -4 });
  assert.ok(ctx.windows.calls.some(
    (item) => item.method === 'setPosition' && item.x === 13 && item.y === -4,
  ));
});

test('pet:scale 保存到当前形象包并拒绝越界值', () => {
  const ctx = setup();
  ctx.ipcMain.invoke('characters:create', { name: '她' });
  assert.deepEqual(ctx.ipcMain.invoke('pet:scale', { scale: 1.5 }), { scale: 1.5 });
  const character = store.listCharacters(ctx.dir)[0];
  const pack = (character.appearance.packs || []).find(
    (item) => item.id === character.appearance.activePack,
  );
  assert.equal(pack.scale, 1.5);
  assert.throws(() => ctx.ipcMain.invoke('pet:scale', { scale: 3 }), /0.2–2.0/);
  assert.throws(() => ctx.ipcMain.invoke('pet:scale', { scale: 0.1 }), /0.2–2.0/);
});

// ---------------------------------------------------------------------------
// 小人拖动：commit / clamp（reviewer 非阻塞 2）
// ---------------------------------------------------------------------------

test('pet:move commit:false 只移动窗口，不写 settings.ui.petPos', () => {
  const ctx = setup();
  const moved = ctx.ipcMain.invoke('pet:move', { x: 40, y: 30, clamp: true, commit: false });

  assert.deepEqual(moved, { x: 40, y: 30 });
  assert.deepEqual(config.loadSettings(ctx.dir).ui.petPos, { x: null, y: null });
  assert.ok(ctx.windows.calls.some(
    (item) => item.method === 'setPosition' && item.x === 40 && item.y === 30,
  ));
});

test('pet:move 松手（默认 commit）写回 settings.ui.petPos', () => {
  const ctx = setup();
  ctx.ipcMain.invoke('pet:move', { x: 40, y: 30, clamp: true, commit: false });
  const saved = ctx.ipcMain.invoke('pet:move', { x: 40, y: 30, clamp: true });

  assert.deepEqual(saved, { x: 40, y: 30 });
  assert.deepEqual(config.loadSettings(ctx.dir).ui.petPos, { x: 40, y: 30 });
});

test('pet:move clamp:true 时越界坐标被钳制在 workArea 内（留 8px）并保存钳制值', () => {
  const ctx = setup({ workArea: () => ({ x: 0, y: 0, width: 800, height: 600 }) });
  const result = ctx.ipcMain.invoke('pet:move', { x: 5000, y: 5000, clamp: true });

  assert.deepEqual(result, { x: 800 - 220 - 8, y: 600 - 380 - 8 });
  assert.deepEqual(config.loadSettings(ctx.dir).ui.petPos, { x: 572, y: 212 });
  assert.ok(ctx.windows.calls.some(
    (item) => item.method === 'setPosition' && item.x === 572 && item.y === 212,
  ));
});

// ---------------------------------------------------------------------------
// 小人尺寸下限跟 petScale 走（reviewer 非阻塞 3）
// ---------------------------------------------------------------------------

test('pet:scale 带 size 只调窗口尺寸、不写设置，0.5 倍最小宽 110', () => {
  const ctx = setup();
  const result = ctx.ipcMain.invoke('pet:scale', { scale: 0.5, size: { width: 90, height: 120 } });

  assert.deepEqual(result, { scale: 0.5 });
  assert.equal(config.loadSettings(ctx.dir).ui.petScale, 1.0, '带 size 时不应改保存的缩放');
  assert.ok(!ctx.emit.names().includes('state:changed'));
  assert.deepEqual(
    ctx.windows.calls.find((item) => item.method === 'setContentSize'),
    { method: 'setContentSize', width: 110, height: 190 },
  );
});

test('pet:scale 带 size 时窗口不小于默认尺寸 × scale', () => {
  const ctx = setup();
  ctx.ipcMain.invoke('pet:scale', { scale: 1.5, size: { width: 300, height: 450 } });

  assert.deepEqual(
    ctx.windows.calls.find((item) => item.method === 'setContentSize'),
    { method: 'setContentSize', width: 330, height: 570 },
  );
});

test('pet:bubbleDismissed 清掉气泡并返回 ok', () => {
  const ctx = setup();
  assert.deepEqual(ctx.ipcMain.invoke('pet:bubbleDismissed'), { ok: true });
  assert.equal(ctx.ipcMain.invoke('pet:getState').bubble, null);
});

// ---------------------------------------------------------------------------
// 抽取：轮次触发、预算闸门、失败退避、真实落盘
// ---------------------------------------------------------------------------

test('chat:send 按 extractEveryTurns 触发抽取，卡片真的落盘并记后台用量', async () => {
  const calls = [];
  const ctx = setup({
    memory: {
      ...memory,
      extractFromChat: async ({ onUsage }) => {
        calls.push(Date.now());
        if (onUsage) onUsage({ promptTokens: 6, completionTokens: 2 });
        return [{ kind: 'preference', text: '用户喜欢喝手冲咖啡', importance: 4 }];
      },
    },
  });
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  config.saveSettings(ctx.dir, { memory: { extractEveryTurns: 2 } });

  await ctx.ipcMain.invoke('chat:send', { text: '我最近在学手冲' });
  await Promise.all(ctx.tasks);
  assert.equal(calls.length, 0, '只聊 1 轮不应触发抽取');

  await ctx.ipcMain.invoke('chat:send', { text: '每天都会喝一杯' });
  await Promise.all(ctx.tasks);
  assert.equal(calls.length, 1, '满 2 轮应触发一次抽取');

  const saved = store.readMemory(ctx.dir, character.id);
  assert.equal(saved.cards.length, 1);
  assert.equal(saved.cards[0].text, '用户喜欢喝手冲咖啡');
  assert.equal(saved.cards[0].importance, 4);
  assert.ok(Array.isArray(saved.suppressed));
  assert.ok(saved.lastExtractedMessageId);
  assert.ok(saved.lastExtractedAt);
  assert.equal(saved.lastExtractAttemptAt, null);

  const day = usage.today(ctx.dir, ctx.nowDate);
  assert.equal(day.background, 1);
  // 当天还有聊天用量，只断言后台那次的 token 已计入
  assert.ok(day.promptTokens >= 6);
  assert.ok(day.completionTokens >= 2);
});

test('抽取受后台预算闸门限制：预算为 0 时不调用模型', async () => {
  let calls = 0;
  const ctx = setup({
    memory: {
      ...memory,
      extractFromChat: async () => {
        calls += 1;
        return [{ kind: 'fact', text: '不该被写入', importance: 3 }];
      },
    },
  });
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  config.saveSettings(ctx.dir, { life: { maxBackgroundCallsPerDay: 0 }, memory: { extractEveryTurns: 1 } });
  store.appendMessage(ctx.dir, character.id, {
    id: 'msg-budget-1',
    role: 'user',
    text: '你好',
    ts: '2026-10-26T21:00:00+08:00',
  });

  const extractor = ipc.createExtractor({
    dir: ctx.dir,
    config,
    store,
    usage,
    now: () => ctx.nowDate,
    memory: {
      ...memory,
      extractFromChat: async () => {
        calls += 1;
        return [{ kind: 'fact', text: '不该被写入', importance: 3 }];
      },
    },
  });
  await extractor(character.id);

  assert.equal(calls, 0);
  assert.equal(store.readMemory(ctx.dir, character.id).cards.length, 0);
});

test('抽取失败写 lastExtractAttemptAt，10 分钟内不重试', async () => {
  let calls = 0;
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  store.appendMessage(ctx.dir, character.id, {
    id: 'msg-backoff-1',
    role: 'user',
    text: '你好',
    ts: '2026-10-26T21:00:00+08:00',
  });

  const extractor = ipc.createExtractor({
    dir: ctx.dir,
    config,
    store,
    usage,
    now: () => ctx.nowDate,
    memory: {
      ...memory,
      extractFromChat: async ({ onFailure }) => {
        calls += 1;
        if (onFailure) onFailure(new Error('密钥无效或权限不足（HTTP 401）'));
        return [];
      },
    },
  });

  await extractor(character.id);
  await extractor(character.id); // 同一时刻第二次：应被退避挡住

  assert.equal(calls, 1);
  const saved = store.readMemory(ctx.dir, character.id);
  assert.equal(saved.cards.length, 0);
  assert.ok(saved.lastExtractAttemptAt);
  assert.equal(saved.lastExtractedAt, undefined);
});

test('抽取第一次失败、第二次成功时仍合并卡片（不被退避误伤）', async () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  store.appendMessage(ctx.dir, character.id, {
    id: 'msg-retry-1',
    role: 'user',
    text: '我住在上海',
    ts: '2026-10-26T21:00:00+08:00',
  });

  const extractor = ipc.createExtractor({
    dir: ctx.dir,
    config,
    store,
    usage,
    now: () => ctx.nowDate,
    memory: {
      ...memory,
      extractFromChat: async ({ onFailure }) => {
        // 模拟 extractFromChat 内部第一次失败、重试后成功
        if (onFailure) onFailure(new Error('第一次请求失败'));
        return [{ kind: 'fact', text: '用户住在上海', importance: 3 }];
      },
    },
  });
  await extractor(character.id);

  const saved = store.readMemory(ctx.dir, character.id);
  assert.equal(saved.cards.length, 1);
  assert.equal(saved.cards[0].text, '用户住在上海');
  assert.equal(saved.lastExtractAttemptAt, null);
  assert.ok(saved.lastExtractedMessageId);
});

test('register 拒绝不在应用渲染目录的 IPC 来源', () => {
  const ctx = setup();
  assert.equal(ipc.isAppRendererUrl(pathToFileURL(RENDERER_PAGE).href), true);
  assert.equal(ipc.isAppRendererUrl('https://evil.example/app'), false);
  assert.equal(ipc.isAppRendererUrl(pathToFileURL(path.join(os.tmpdir(), 'evil.html')).href), false);

  assert.throws(
    () => ctx.ipcMain.invoke('settings:get', undefined, 'https://evil.example/app'),
    /来源不在应用渲染目录/,
  );
});

// ---------------------------------------------------------------------------
// Task 12：设置窗口新增通道（dataDir / 自启 / 用量 / 导出 / 选图 / 帧 URL）
// ---------------------------------------------------------------------------

test('settings:get 附带 dataDir；settings:setAutostart 写盘并同步系统登录项', () => {
  const ctx = setup();
  const initial = ctx.ipcMain.invoke('settings:get');
  assert.equal(initial.dataDir, ctx.dir);
  assert.equal(initial.ui.autostart, false);

  const result = ctx.ipcMain.invoke('settings:setAutostart', { enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.warning, null);
  assert.equal(result.settings.ui.autostart, true);
  assert.equal(config.loadSettings(ctx.dir).ui.autostart, true);
  assert.deepEqual(ctx.system.autostart, [true]);

  const off = ctx.ipcMain.invoke('settings:setAutostart', false);
  assert.equal(off.ok, true);
  assert.equal(off.settings.ui.autostart, false);
  assert.deepEqual(ctx.system.autostart, [true, false]);
  assert.throws(
    () => ctx.ipcMain.invoke('settings:setAutostart', { enabled: 'yes' }),
    /true\/false/,
  );
});

test('settings:setAutostart 在开发态返回 warning（否则界面只会说已保存）', () => {
  const ctx = setup({ isPackaged: false });
  const result = ctx.ipcMain.invoke('settings:setAutostart', { enabled: true });
  assert.equal(result.ok, true);
  assert.match(result.warning, /开发态无法真正开机自启/);
  assert.equal(config.loadSettings(ctx.dir).ui.autostart, true);
  assert.deepEqual(ctx.system.autostart, [true]);
});

test('settings:setAutostart 打包态无 warning；系统接口抛错时回传失败原因', () => {
  const packaged = setup({ isPackaged: true });
  assert.equal(packaged.ipcMain.invoke('settings:setAutostart', { enabled: false }).warning, null);

  const failing = setup({
    isPackaged: true,
    setAutostart: () => {
      throw new Error('拒绝访问');
    },
  });
  const result = failing.ipcMain.invoke('settings:setAutostart', { enabled: true });
  assert.equal(result.ok, true);
  assert.match(result.warning, /系统登录项设置失败.*拒绝访问/);
});

test('settings:save 改 ui.autostart / clickThrough 时同步系统副作用', () => {
  const ctx = setup();
  ctx.ipcMain.invoke('settings:save', { ui: { autostart: true, clickThrough: false } });

  assert.deepEqual(ctx.system.autostart, [true]);
  const call = ctx.windows.calls.filter((item) => item.method === 'setIgnoreMouseEvents').pop();
  assert.ok(call, '应该调用 setIgnoreMouseEvents');
  assert.equal(call.flag, false);
  assert.deepEqual(call.options, { forward: true });
});

test('usage:today 返回今日只读用量', () => {
  const ctx = setup();
  usage.record(ctx.dir, 'chat', { promptTokens: 12, completionTokens: 3 }, ctx.nowDate);
  usage.record(ctx.dir, 'background', { promptTokens: 5, completionTokens: 1 }, ctx.nowDate);

  assert.deepEqual(ctx.ipcMain.invoke('usage:today'), {
    chat: 1,
    background: 1,
    embedding: 0,
    promptTokens: 17,
    completionTokens: 4,
  });
});

test('data:openDataDir 调系统打开目录', () => {
  const ctx = setup();
  assert.deepEqual(ctx.ipcMain.invoke('data:openDataDir'), { ok: true, path: ctx.dir });
  assert.deepEqual(ctx.system.opened, [ctx.dir]);
});

test('data:export 递归复制 data/ 到 she-export-<yyyymmdd-HHMM>', async () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  fs.writeFileSync(path.join(ctx.dir, 'usage.json'), '{"days":{}}');
  fs.mkdirSync(path.join(ctx.dir, 'characters', character.id, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'characters', character.id, 'assets', 'idle.png'), 'x');

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'she-export-'));
  const result = await ctx.ipcMain.invoke('data:export', { targetDir: target });

  assert.equal(result.ok, true);
  assert.equal(result.canceled, false);
  assert.equal(path.basename(result.path), 'she-export-20261026-2100');
  assert.equal(path.dirname(result.path), target);
  const charFile = path.join(result.path, 'characters', character.id, 'character.json');
  assert.ok(fs.readFileSync(charFile, 'utf8').includes('她'));
  assert.ok(fs.existsSync(path.join(result.path, 'usage.json')));
  assert.ok(fs.existsSync(path.join(result.path, 'characters', character.id, 'assets', 'idle.png')));

  fs.rmSync(target, { recursive: true, force: true });
});

test('data:export 取消选择返回 canceled，拒绝导出到数据目录内部', async () => {
  const canceled = setup({ pickDirectory: async () => null });
  assert.deepEqual(await canceled.ipcMain.invoke('data:export'), {
    canceled: true,
    ok: false,
    path: null,
  });

  const ctx = setup();
  await assert.rejects(
    ctx.ipcMain.invoke('data:export', { targetDir: path.join(ctx.dir, 'inside') }),
    /数据目录里面/,
  );
  assert.equal(fs.existsSync(path.join(ctx.dir, 'inside')), false);
});

test('data:export 大小写变体的数据目录也拒绝自复制（Windows）', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows 磁盘大小写不敏感，其它平台没有这个问题');
    return;
  }
  const ctx = setup();
  const upper = ctx.dir.toUpperCase();
  await assert.rejects(
    ctx.ipcMain.invoke('data:export', { targetDir: upper }),
    /数据目录里面/,
  );
  // 不能留下半成品导出目录（否则就说明真的开始复制了）
  assert.equal(fs.existsSync(path.join(ctx.dir, 'she-export-20261026-2100')), false);
});

test('data:export 通过 junction 指向数据目录时也拒绝（realpath 等价路径）', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('junction 只在 Windows 上验证');
    return;
  }
  const ctx = setup();
  const base = tmpDir();
  const link = path.join(base, 'data-link');
  try {
    fs.symlinkSync(ctx.dir, link, 'junction');
  } catch (error) {
    t.skip(`当前环境不能创建 junction：${error.code || error.message}`);
    return;
  }
  try {
    await assert.rejects(
      ctx.ipcMain.invoke('data:export', { targetDir: link }),
      /数据目录里面/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('data:export 拒绝把导出目录放在数据目录的上级（dest 会是 source 的祖先）', async () => {
  const base = tmpDir();
  const parent = path.join(base, 'she-export-20261026-2100');
  const dataDir = path.join(parent, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  config.saveSettings(dataDir, { ui: { petScale: 1.2 } });

  const ctx = setup({ dir: dataDir });
  await assert.rejects(
    ctx.ipcMain.invoke('data:export', { targetDir: base }),
    /上级目录/,
  );
  // 不能生成嵌套的导出目录
  assert.equal(fs.existsSync(path.join(parent, 'she-export-20261026-2100')), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('data:export 的 settings.json 与 .bak 已脱敏，原始 data/ 不动', async () => {
  const ctx = setup();
  config.saveSettings(ctx.dir, {
    api: {
      profiles: [{
        id: 'p1',
        name: '测试',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-first-1111',
        model: 'm1',
        capabilities: ['chat'],
      }],
    },
  });
  config.saveSettings(ctx.dir, {
    api: {
      profiles: [{
        id: 'p1',
        name: '测试',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret-2222',
        model: 'm2',
        capabilities: ['chat'],
      }],
    },
  });
  // 第二次写盘后：settings.json 是 secret，.bak 是 first
  assert.match(fs.readFileSync(path.join(ctx.dir, 'settings.json'), 'utf8'), /sk-secret-2222/);
  assert.match(fs.readFileSync(path.join(ctx.dir, 'settings.json.bak'), 'utf8'), /sk-first-1111/);

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'she-export-'));
  const result = await ctx.ipcMain.invoke('data:export', { targetDir: target });

  const exported = fs.readFileSync(path.join(result.path, 'settings.json'), 'utf8');
  const backup = fs.readFileSync(path.join(result.path, 'settings.json.bak'), 'utf8');
  assert.ok(!exported.includes('sk-secret-2222'));
  assert.ok(!backup.includes('sk-first-1111'));
  const parsed = JSON.parse(exported);
  assert.equal(parsed.api.profiles[0].apiKey, '');
  assert.equal(parsed.api.profiles[0].model, 'm2');
  assert.equal(JSON.parse(backup).api.profiles[0].apiKey, '');

  // 原始数据绝不能被改动
  assert.match(fs.readFileSync(path.join(ctx.dir, 'settings.json'), 'utf8'), /sk-secret-2222/);
  assert.match(fs.readFileSync(path.join(ctx.dir, 'settings.json.bak'), 'utf8'), /sk-first-1111/);

  fs.rmSync(target, { recursive: true, force: true });
});

test('data:export 遇到解析不了的 settings 文件宁可不导出（避免明文 Key 泄漏）', async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.dir, 'settings.json'), '{ "api": { "profiles": [');
  fs.writeFileSync(path.join(ctx.dir, 'settings.json.bak'), '\u0000broken');

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'she-export-'));
  const result = await ctx.ipcMain.invoke('data:export', { targetDir: target });

  assert.equal(fs.existsSync(path.join(result.path, 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(result.path, 'settings.json.bak')), false);

  fs.rmSync(target, { recursive: true, force: true });
});

test('characters:frames 返回各形象包帧位 URL，越界路径跳过', () => {
  const ctx = setup();
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });
  const source = path.join(ctx.dir, 'idle.png');
  fs.writeFileSync(source, validPng());
  ctx.ipcMain.invoke('characters:importFrame', {
    characterId: character.id,
    packId: 'default',
    frameKey: 'idle',
    sourcePath: source,
  });

  const frames = ctx.ipcMain.invoke('characters:frames', { characterId: character.id });
  assert.ok(frames.default);
  assert.ok(frames.default.idle.startsWith('file:'));
  assert.equal(frames.default.happy, undefined);

  const saved = store.listCharacters(ctx.dir).find((item) => item.id === character.id);
  store.saveCharacter(ctx.dir, {
    ...saved,
    appearance: {
      ...saved.appearance,
      packs: [{ id: 'default', name: '常服', frames: { idle: '../../settings.json' } }],
    },
  });
  assert.deepEqual(ctx.ipcMain.invoke('characters:frames', { characterId: character.id }), { default: {} });
});

test('dialog:pickImage 透传绝对路径，取消返回 canceled', async () => {
  const ctx = setup({ pickImage: async () => 'C:\\pics\\idle.png' });
  assert.deepEqual(await ctx.ipcMain.invoke('dialog:pickImage'), {
    canceled: false,
    path: 'C:\\pics\\idle.png',
  });

  const canceled = setup({ pickImage: () => null });
  assert.deepEqual(await canceled.ipcMain.invoke('dialog:pickImage'), {
    canceled: true,
    path: null,
  });
});


test('pet:getState 返回水平翻转状态，characters:save 能持久化', () => {
  const ctx = setup();
  const created = ctx.ipcMain.invoke('characters:create', { name: '翻转测试' });
  assert.equal(ctx.ipcMain.invoke('pet:getState').flip, false);

  const saved = ctx.ipcMain.invoke('characters:save', {
    ...created,
    appearance: {
      activePack: 'default',
      scale: 1,
      flip: true,
      packs: [{ id: 'default', name: '默认', frames: {} }],
    },
  });
  assert.equal(saved.appearance.flip, true);
  assert.equal(ctx.ipcMain.invoke('pet:getState').flip, true);
});

test('chat:send：对方说「安～」后不再回复', async () => {
  let calls = 0;
  const ctx = setup({
    llm: {
      chat: async () => {
        calls += 1;
        return { text: '不该出现的回复', usage: {} };
      },
      testProfile: async () => ({ ok: true }),
    },
  });
  const character = ctx.ipcMain.invoke('characters:create', { name: '她' });

  const result = await ctx.ipcMain.invoke('chat:send', { text: '安～' });
  await Promise.all(ctx.tasks);

  assert.equal(result.ok, true);
  assert.equal(result.silent, true);
  assert.equal(calls, 0, '不应调用模型');

  const chatEvents = ctx.emit.events.filter((item) => item.event.startsWith('chat:'));
  assert.deepEqual(chatEvents.map((item) => item.event), ['chat:done']);
  assert.equal(chatEvents[0].payload.message, null);

  const messages = store.readMessages(ctx.dir, character.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, '安～');
});

test('chat:send：结束语可在设置里改', async () => {
  let calls = 0;
  const ctx = setup({
    llm: {
      chat: async () => {
        calls += 1;
        return { text: '好', usage: {} };
      },
      testProfile: async () => ({ ok: true }),
    },
  });
  ctx.ipcMain.invoke('characters:create', { name: '她' });
  ctx.ipcMain.invoke('settings:save', { life: { silentEndPhrases: ['睡了'] } });

  const silent = await ctx.ipcMain.invoke('chat:send', { text: '睡了' });
  assert.equal(silent.silent, true);
  assert.equal(calls, 0);

  await ctx.ipcMain.invoke('chat:send', { text: '安～' });
  assert.equal(calls, 1, '不在列表里的内容仍正常回复');

  const saved = config.loadSettings(ctx.dir);
  assert.deepEqual(saved.life.silentEndPhrases, ['睡了']);
});
