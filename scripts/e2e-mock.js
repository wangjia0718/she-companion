'use strict';

// 端到端验收（不启动 Electron）：真实主进程模块 + 本地假 OpenAI 兼容服务。
//
// 链路：写 settings（baseUrl 指向 mock）→ 建角色 → chat:send 流式 → 消息落盘
//       → usage.json 记账 → 满 extractEveryTurns 触发记忆抽取并落盘
//       → 再聊一次，断言 prompt 里真的带上了上一轮抽出的记忆卡。
//
// 用法：node scripts/e2e-mock.js
// 成功输出 E2E PASS 与耗时（退出码 0）；任一步断言失败输出原因并退出码 1。
// 数据写在系统临时目录，结束后删除，不碰项目 data/。

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ipc = require('../src/main/ipc');
const config = require('../src/main/config');
const store = require('../src/main/store');
const usage = require('../src/main/usage');
const llm = require('../src/main/llm');

const RENDERER_PAGE = path.join(__dirname, '..', 'src', 'renderer', 'chat', 'chat.html');
const PROFILE_ID = 'mock';
const MODEL = 'mock-model';
const REPLY_CHUNKS = ['嗯…', '我记下了，', '下周的季度方案。'];
const CARD_TEXT = '用户下周要交一份季度方案';
const EXTRACT_JSON = JSON.stringify([{ kind: 'event', text: CARD_TEXT, importance: 4 }]);
const FIRST_TEXT = '我下周要交一份季度方案，还没想好结构';
const SECOND_TEXT = '那个季度方案我还是没动';

const EXTRACT_MARKER = '记忆整理器';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-e2e-'));
}

/** 假 OpenAI 兼容服务：/chat/completions 走 SSE，/embeddings 走一次性 JSON */
function startMockServer() {
  const state = {
    chatRequests: [],
    extractionRequests: 0,
    embeddingRequests: 0,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }

      const url = String(req.url || '');

      if (url.endsWith('/embeddings')) {
        state.embeddingRequests += 1;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          object: 'list',
          model: body.model || MODEL,
          data: [{ object: 'embedding', index: 0, embedding: [0.12, -0.34, 0.56] }],
        }));
        return;
      }

      if (!url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: `unknown path: ${url}` } }));
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const isExtraction = messages.some((message) => (
        message
        && message.role === 'system'
        && typeof message.content === 'string'
        && message.content.includes(EXTRACT_MARKER)
      ));
      state.chatRequests.push({ isExtraction, body, raw });
      if (isExtraction) state.extractionRequests += 1;

      const chunks = isExtraction ? [EXTRACT_JSON] : REPLY_CHUNKS;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      // 每个 chunk 单独写一次，确保真的走跨 chunk 的 SSE 解析
      let index = 0;
      const timer = setInterval(() => {
        if (index < chunks.length) {
          res.write(`data: ${JSON.stringify({
            model: MODEL,
            choices: [{ index: 0, delta: { content: chunks[index] } }],
          })}\n\n`);
          index += 1;
          return;
        }
        res.write(`data: ${JSON.stringify({
          model: MODEL,
          choices: [],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        clearInterval(timer);
        res.end();
      }, 5);

      res.on('close', () => clearInterval(timer));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        state,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
    });
  });
}

function fakeIpcMain() {
  const table = new Map();
  return {
    table,
    handle(channel, listener) {
      table.set(channel, listener);
    },
    invoke(channel, payload) {
      const listener = table.get(channel);
      if (!listener) throw new Error(`no handler: ${channel}`);
      return listener(
        { sender: {}, senderFrame: { url: pathToFileURL(RENDERER_PAGE).href } },
        payload,
      );
    },
  };
}

async function main() {
  const started = Date.now();
  const dir = tmpDir();
  const { server, state, baseUrl } = await startMockServer();

  try {
    // 1) 设置：baseUrl 指向 mock，key / model 随便填；1 轮就触发抽取，方便断言
    config.saveSettings(dir, {
      onboarded: true,
      api: {
        profiles: [{
          id: PROFILE_ID,
          name: '本地 mock',
          baseUrl,
          apiKey: 'sk-e2e-mock-key',
          model: MODEL,
          temperature: 0.7,
          maxTokens: 256,
          capabilities: ['chat', 'embedding'],
        }],
        chat: PROFILE_ID,
        background: PROFILE_ID,
        embedding: PROFILE_ID,
      },
      memory: { extractEveryTurns: 1, extractIdleMinutes: 10 },
    });

    // 2) 角色（真实 store，落盘到临时目录）
    const character = store.createCharacter(dir, {
      name: '阿澜',
      persona: {
        traits: ['安静', '爱观察'],
        speechStyle: '短句、口语',
        background: '杭州，做陶',
      },
    });
    assert(store.listCharacters(dir).length === 1, '角色没有落盘');
    config.saveSettings(dir, { activeCharacterId: character.id });
    console.log(`[1/6] settings 与角色已写入：${character.id}`);

    // 3) 真实 IPC 通道表（fake ipcMain 只为过 senderFrame 校验）
    const events = [];
    const tasks = [];
    const handlers = ipc.createHandlers({
      dir,
      emit: (event, payload) => events.push({ event, payload }),
      now: () => new Date(),
      onBackgroundTask: (promise) => tasks.push(promise),
      windows: { get: () => ({}) },
    });
    const ipcMain = fakeIpcMain();
    ipc.register(ipcMain, handlers);

    // 4) 第一次聊天：流式 3 段 + done + 落盘 + 用量
    const first = await ipcMain.invoke('chat:send', { characterId: character.id, text: FIRST_TEXT });
    assert(first && first.ok === true, `chat:send 第一次失败：${JSON.stringify(first)}`);

    const deltas = events.filter((item) => item.event === 'chat:delta').map((item) => item.payload.text);
    assert(deltas.length === REPLY_CHUNKS.length, `delta 数量应为 ${REPLY_CHUNKS.length}，实际 ${deltas.length}`);
    assert(deltas.join('') === REPLY_CHUNKS.join(''), `delta 拼接不一致：${deltas.join('')}`);

    const doneEvents = events.filter((item) => item.event === 'chat:done');
    assert(doneEvents.length === 1, `chat:done 应收到 1 次，实际 ${doneEvents.length}`);
    assert(doneEvents[0].payload.message.text === REPLY_CHUNKS.join(''), 'chat:done 里的完整文本不对');
    assert(!events.some((item) => item.event === 'chat:error'), '不该出现 chat:error');
    console.log(`[2/6] 收到 ${deltas.length} 个 delta 与 chat:done：${deltas.join('')}`);

    let messages = store.readMessages(dir, character.id);
    assert(messages.length === 2, `chat.jsonl 应有 2 条消息，实际 ${messages.length}`);
    assert(messages[0].role === 'user' && messages[0].text === FIRST_TEXT, '用户消息没有正确落盘');
    assert(messages[1].role === 'assistant' && messages[1].text === REPLY_CHUNKS.join(''), '助手消息没有正确落盘');

    assert(usage.today(dir).chat === 1, `usage.json chat 应为 1 次，实际 ${usage.today(dir).chat}`);
    assert(usage.today(dir).promptTokens >= 42, 'prompt token 没有记账');
    assert(usage.today(dir).completionTokens >= 7, 'completion token 没有记账');
    console.log(`[3/6] chat.jsonl 2 条；usage chat=${usage.today(dir).chat} tokens=${usage.today(dir).promptTokens}/${usage.today(dir).completionTokens}`);

    // 5) 记忆抽取：由 chat:send 的轮次触发，等后台任务结算
    assert(tasks.length >= 1, '满 1 轮却没有触发记忆抽取');
    await Promise.allSettled(tasks);
    assert(state.extractionRequests >= 1, 'mock 没有收到记忆抽取请求');

    const memory = store.readMemory(dir, character.id);
    assert(memory.cards.length === 1, `memory.json 应有 1 张卡，实际 ${memory.cards.length}`);
    assert(memory.cards[0].text === CARD_TEXT, `记忆卡文本不对：${memory.cards[0].text}`);
    assert(memory.cards[0].kind === 'event', `记忆卡 kind 不对：${memory.cards[0].kind}`);
    assert(memory.lastExtractedMessageId === messages[1].id, '抽取游标没有推进到最后一条消息');
    assert(usage.today(dir).background >= 1, '记忆抽取没有记 background 用量');
    console.log(`[4/6] 记忆抽取落盘：${memory.cards.length} 张卡，background=${usage.today(dir).background}`);

    // 6) 第二次聊天：prompt 必须带上刚才的记忆卡
    const chatRequestsBefore = state.chatRequests.filter((item) => !item.isExtraction).length;
    const second = await ipcMain.invoke('chat:send', { characterId: character.id, text: SECOND_TEXT });
    await Promise.allSettled(tasks);
    assert(second && second.ok === true, `chat:send 第二次失败：${JSON.stringify(second)}`);

    const chatRequests = state.chatRequests.filter((item) => !item.isExtraction);
    assert(chatRequests.length === chatRequestsBefore + 1, '第二次聊天没有打到 mock');
    const bodiesBefore = chatRequests.slice(0, chatRequestsBefore).map((item) => item.raw);
    const secondBody = chatRequests[chatRequests.length - 1].raw;
    assert(bodiesBefore.every((body) => !body.includes(CARD_TEXT)), '第一次请求里不该已经有记忆卡');
    assert(secondBody.includes(CARD_TEXT), '第二次请求的 prompt 里没有带上记忆卡');
    console.log('[5/6] 第二次 prompt 已包含记忆卡');

    messages = store.readMessages(dir, character.id);
    assert(messages.length === 4, `第二轮后 chat.jsonl 应有 4 条消息，实际 ${messages.length}`);
    assert(usage.today(dir).chat === 2, `usage.json chat 应为 2 次，实际 ${usage.today(dir).chat}`);

    // 7) /embeddings 也真实请求一次，确认 mock 的两条路径都可用
    const profile = config.loadSettings(dir).api.profiles[0];
    const vector = await llm.embeddings({ profile, input: '测试向量' });
    assert(Array.isArray(vector) && vector.length === 3, `embeddings 返回异常：${JSON.stringify(vector)}`);
    assert(state.embeddingRequests === 1, `embeddings 请求次数应为 1，实际 ${state.embeddingRequests}`);
    console.log(`[6/6] /embeddings 正常：${vector.length} 维`);

    console.log('E2E PASS');
    console.log(`耗时: ${Date.now() - started} ms`);
  } finally {
    // 先断开 keep-alive 空闲连接，避免 server.close() 一直等
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`E2E FAIL: ${error && error.message ? error.message : error}`);
  if (process.env.E2E_DEBUG && error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
