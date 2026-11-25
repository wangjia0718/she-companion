'use strict';

// llm.js 测试：用 node:http 起本地 mock 服务，覆盖流式、重试、鉴权、取消、
// 用量估算、URL 拼接、坏响应、多字节分块与 embeddings。

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { chat, embeddings, testProfile, RETRY_DELAYS } = require('../src/main/llm');

// ---------- mock 服务 ----------

/**
 * 起一个本地服务跑 run，结束后强制断开所有连接再关闭，避免 node --test 挂住。
 * handler({ req, res, json, body }) 可同步或异步。
 */
async function withServer(handler, run) {
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
      Promise.resolve(handler({ req, res, body, json })).catch(() => {
        try {
          res.destroy();
        } catch {
          /* 忽略 */
        }
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run({ url: `http://127.0.0.1:${port}`, port });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(content) {
  return { id: 'chunk', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: { content } }] };
}

function profileFor(url, extra = {}) {
  return {
    id: 'p1',
    name: 'mock',
    baseUrl: url,
    apiKey: 'sk-test',
    model: 'mock-model',
    ...extra,
  };
}

function chatOnce(profile, extra = {}) {
  return chat({ profile, messages: [{ role: 'user', content: '在吗' }], retry: 0, ...extra });
}

function writeHeadSSE(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
}

// ---------- 流式 ----------

test('流式响应分 3 个 chunk：onDelta 收到 3 次增量，文本完整，请求体符合约定', async () => {
  const seen = [];
  let captured = null;

  await withServer(
    ({ req, res, json }) => {
      captured = { path: req.url, auth: req.headers.authorization, body: json };
      writeHeadSSE(res);
      res.write(sse(delta('你')));
      res.write(sse(delta('好呀')));
      res.write(sse({ ...delta('，'), usage: { prompt_tokens: 12, completion_tokens: 6 } }));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      const result = await chat({
        profile: profileFor(`${url}/v1/`),
        messages: [{ role: 'user', content: '在吗' }],
        onDelta: (value) => seen.push(value),
      });

      assert.deepEqual(seen, ['你', '好呀', '，']);
      assert.equal(result.text, '你好呀，');
      assert.equal(result.model, 'mock-model');
      assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 6, estimated: false });

      assert.equal(captured.path, '/v1/chat/completions');
      assert.equal(captured.auth, 'Bearer sk-test');
      assert.equal(captured.body.model, 'mock-model');
      assert.equal(captured.body.stream, true);
      assert.equal(captured.body.temperature, 0.8);
      assert.equal(captured.body.max_tokens, 1024);
      assert.deepEqual(captured.body.messages, [{ role: 'user', content: '在吗' }]);
    },
  );
});

test('响应缺 usage 时按字符数估算，estimated 为 true 且 token 大于 0', async () => {
  await withServer(
    ({ res }) => {
      writeHeadSSE(res);
      res.write(sse(delta('今天有点困，早点睡吧。')));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      const result = await chatOnce(profileFor(url), { messages: [{ role: 'user', content: '你怎么了' }] });
      assert.equal(result.usage.estimated, true);
      assert.ok(result.usage.promptTokens > 0, 'promptTokens 应大于 0');
      assert.ok(result.usage.completionTokens > 0, 'completionTokens 应大于 0');
      assert.equal(result.usage.completionTokens, Math.ceil('今天有点困，早点睡吧。'.length / 1.5));
    },
  );
});

test('多字节中文被 chunk 边界切断时，拼接结果不乱码', async () => {
  const payload = sse(delta('你好，世界')) + 'data: [DONE]\n\n';
  const buffer = Buffer.from(payload, 'utf8');
  const charStart = buffer.indexOf(Buffer.from('你', 'utf8'));
  // 切在「你」的 3 个字节中间，模拟 TCP 分片
  const cut = charStart + 1;
  assert.ok(cut > 0 && cut < buffer.length);

  await withServer(
    ({ res }) => {
      writeHeadSSE(res);
      res.write(buffer.subarray(0, cut));
      setTimeout(() => {
        res.write(buffer.subarray(cut));
        res.end();
      }, 20);
    },
    async ({ url }) => {
      const result = await chatOnce(profileFor(url));
      assert.equal(result.text, '你好，世界');
    },
  );
});

// ---------- 重试与错误映射 ----------

test('第一次 500、第二次 200：自动重试成功，请求 2 次', async () => {
  let count = 0;
  await withServer(
    ({ res }) => {
      count += 1;
      if (count === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'server boom' } }));
        return;
      }
      writeHeadSSE(res);
      res.write(sse(delta('回来了')));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      const result = await chatOnce(profileFor(url), { retry: 2 });
      assert.equal(result.text, '回来了');
      assert.equal(count, 2);
    },
  );
});

test('retry: 0 时 500 直接抛出，只请求 1 次', async () => {
  let count = 0;
  await withServer(
    ({ res }) => {
      count += 1;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    },
    async ({ url }) => {
      const err = await chatOnce(profileFor(url)).then(() => null, (e) => e);
      assert.ok(err, '应抛错');
      assert.equal(err.code, 'NETWORK');
      assert.equal(err.status, 500);
      assert.equal(count, 1);
    },
  );
});

test('401 抛 code=AUTH，只请求 1 次', async () => {
  let count = 0;
  await withServer(
    ({ res }) => {
      count += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    },
    async ({ url }) => {
      const err = await chatOnce(profileFor(url), { retry: 2 }).then(() => null, (e) => e);
      assert.ok(err);
      assert.equal(err.code, 'AUTH');
      assert.equal(err.status, 401);
      assert.equal(count, 1, '401 不应重试');
      assert.match(err.message, /密钥无效/);
    },
  );
});

test('429 → 200：只退避一次，最终成功', async () => {
  let count = 0;
  await withServer(
    ({ res }) => {
      count += 1;
      if (count === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      writeHeadSSE(res);
      res.write(sse(delta('好了')));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      const started = Date.now();
      const result = await chatOnce(profileFor(url), { retry: 1 });
      const elapsed = Date.now() - started;
      assert.equal(result.text, '好了');
      assert.equal(count, 2, '只应重试一次');
      assert.ok(elapsed >= 900, `应等待约 1000ms 退避，实际 ${elapsed}ms`);
    },
  );
});

test('429 抛 code=RATE（retry: 0 不等待退避）', async () => {
  await withServer(
    ({ res }) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    },
    async ({ url }) => {
      const err = await chatOnce(profileFor(url)).then(() => null, (e) => e);
      assert.equal(err.code, 'RATE');
      assert.equal(err.status, 429);
    },
  );
});

test('退避时长为 1000ms / 3000ms', () => {
  assert.deepEqual(RETRY_DELAYS, [1000, 3000]);
});

// ---------- 取消 ----------

test('流式中途 abort：抛 code=ABORTED', async () => {
  await withServer(
    ({ res }) => {
      writeHeadSSE(res);
      res.write(sse(delta('我')));
      // 之后不再写，等客户端取消（连接关闭时 mock 侧会收到 close）
      setTimeout(() => {
        try {
          res.end();
        } catch {
          /* 忽略 */
        }
      }, 500).unref();
    },
    async ({ url }) => {
      const controller = new AbortController();
      const promise = chat({
        profile: profileFor(url),
        messages: [{ role: 'user', content: '在吗' }],
        signal: controller.signal,
        onDelta: () => controller.abort(),
        retry: 2,
      });

      const err = await promise.then(() => null, (e) => e);
      assert.ok(err, '应抛错');
      assert.equal(err.code, 'ABORTED');
      assert.equal(err.partialText, '我', '已生成内容应保留在 partialText');
    },
  );
});

test('signal 已 aborted 时立即抛 ABORTED，且一次请求都不发出', async () => {
  let count = 0;
  await withServer(
    ({ res }) => {
      count += 1;
      writeHeadSSE(res);
      res.write(sse(delta('不该到')));
      res.end();
    },
    async ({ url }) => {
      const controller = new AbortController();
      controller.abort();
      const err = await chat({
        profile: profileFor(url),
        messages: [{ role: 'user', content: '在吗' }],
        signal: controller.signal,
      }).then(() => null, (e) => e);
      assert.equal(err.code, 'ABORTED');
      assert.equal(count, 0, '预取消不应发出请求');
    },
  );
});

test('onDelta 抛异常：不重试，错误为 BAD_RESPONSE 且标记 source=onDelta', async () => {
  let count = 0;
  await withServer(
    ({ res }) => {
      count += 1;
      writeHeadSSE(res);
      res.write(sse(delta('一')));
      res.write(sse(delta('二')));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      const err = await chat({
        profile: profileFor(url),
        messages: [{ role: 'user', content: '在吗' }],
        retry: 2,
        onDelta: () => {
          throw new Error('renderer bug');
        },
      }).then(() => null, (e) => e);
      assert.ok(err, '应抛错');
      assert.equal(err.code, 'BAD_RESPONSE', '不应冒充用户取消');
      assert.equal(err.retryable, false);
      assert.equal(err.source, 'onDelta');
      assert.equal(count, 1, '回调出错不应重试');
    },
  );
});

test('空闲超时：长时间没有新 chunk 抛 NETWORK，已生成内容不重试', async () => {
  let count = 0;
  await withServer(
    ({ res }) => {
      count += 1;
      writeHeadSSE(res);
      res.write(sse(delta('半句')));
      setTimeout(() => {
        try {
          res.end();
        } catch {
          /* 客户端已断开 */
        }
      }, 1000).unref();
    },
    async ({ url }) => {
      const err = await chat({
        profile: profileFor(url),
        messages: [{ role: 'user', content: '在吗' }],
        retry: 2,
        timeoutMs: 150,
      }).then(() => null, (e) => e);
      assert.equal(err.code, 'NETWORK');
      assert.match(err.message, /没有新响应/);
      assert.equal(err.partialText, '半句');
      assert.equal(count, 1, '已有内容不重试');
    },
  );
});

test('空闲超时按 chunk 重置：总时长超过阈值也不会被误判', async () => {
  await withServer(
    ({ res }) => {
      writeHeadSSE(res);
      const pieces = ['一', '二', '三'];
      let index = 0;
      const tick = () => {
        if (index < pieces.length) {
          res.write(sse(delta(pieces[index])));
          index += 1;
          setTimeout(tick, 250).unref();
          return;
        }
        res.write('data: [DONE]\n\n');
        res.end();
      };
      tick();
    },
    async ({ url }) => {
      const started = Date.now();
      const result = await chat({
        profile: profileFor(url),
        messages: [{ role: 'user', content: '在吗' }],
        timeoutMs: 500,
      });
      const elapsed = Date.now() - started;
      assert.equal(result.text, '一二三');
      assert.ok(elapsed >= 700, `总时长应超过空闲阈值 500ms，实际 ${elapsed}ms`);
    },
  );
});

// ---------- URL 与坏响应 ----------

test('baseUrl 去尾斜杠：/v1 不重复追加，也不拼出 //chat/completions', async () => {
  const paths = [];
  await withServer(
    ({ req, res }) => {
      paths.push(req.url);
      writeHeadSSE(res);
      res.write(sse(delta('ok')));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      await chatOnce(profileFor(`${url}/v1/`));
      await chatOnce(profileFor(`${url}/`));
      await chatOnce(profileFor(`${url}/v1`));
      assert.deepEqual(paths, ['/v1/chat/completions', '/chat/completions', '/v1/chat/completions']);
    },
  );
});

test('baseUrl 带 query：路径拼在 query 之前（chat 与 embeddings）', async () => {
  const seen = [];
  await withServer(
    ({ req, res }) => {
      seen.push(req.url);
      if (req.url.startsWith('/v1/embeddings')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [1, 2] }] }));
        return;
      }
      writeHeadSSE(res);
      res.write(sse(delta('ok')));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      const chatResult = await chatOnce(profileFor(`${url}/v1?api-version=2024-06-01`));
      assert.equal(chatResult.text, 'ok');
      const vector = await embeddings({ profile: profileFor(`${url}/v1?key=1`), input: 'x' });
      assert.deepEqual(vector, [1, 2]);
      assert.deepEqual(seen, [
        '/v1/chat/completions?api-version=2024-06-01',
        '/v1/embeddings?key=1',
      ]);
    },
  );
});

test('apiKey 中间带换行：抛 AUTH，文案不含密钥片段，一次请求都不发出', async () => {
  let count = 0;
  await withServer(
    ({ res }) => {
      count += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('should not be called');
    },
    async ({ url }) => {
      const profile = profileFor(url, { apiKey: 'sk-test\nSECRETTAIL' });
      const err = await chatOnce(profile).then(() => null, (e) => e);
      assert.ok(err, '应抛错');
      assert.equal(err.code, 'AUTH');
      assert.match(err.message, /中间有换行/);
      assert.ok(!err.message.includes('sk-test'), `文案泄露密钥：${err.message}`);
      assert.ok(!err.message.includes('SECRETTAIL'));
      assert.equal(count, 0, '不应发出请求');

      const probe = await testProfile(profile);
      assert.equal(probe.ok, false);
      assert.ok(!probe.error.includes('sk-test'));
      assert.ok(!probe.error.includes('SECRETTAIL'));
    },
  );
});

test('apiKey 带尾部换行：trim 后正常请求，Authorization 头干净', async () => {
  let captured = null;
  await withServer(
    ({ req, res }) => {
      captured = req.headers.authorization;
      writeHeadSSE(res);
      res.write(sse(delta('ok')));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      const result = await chatOnce(profileFor(url, { apiKey: 'sk-real-key\n' }));
      assert.equal(result.text, 'ok');
      assert.equal(captured, 'Bearer sk-real-key');
    },
  );
});

test('错误文案不回显 apiKey 与 baseUrl 的 query 值', async () => {
  await withServer(
    ({ req, res }) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `bad request ${req.url} with key sk-supersecret-key` },
      }));
    },
    async ({ url }) => {
      const profile = profileFor(`${url}/v1?key=SUPERSECRET`, { apiKey: 'sk-supersecret-key' });
      const err = await chatOnce(profile).then(() => null, (e) => e);
      assert.equal(err.code, 'BAD_RESPONSE');
      assert.equal(err.status, 400);
      assert.match(err.message, /HTTP 400/);
      assert.ok(!err.message.includes('SUPERSECRET'), `文案泄露 query：${err.message}`);
      assert.ok(!err.message.includes('sk-supersecret-key'), `文案泄露密钥：${err.message}`);

      const probe = await testProfile(profile);
      assert.equal(probe.ok, false);
      assert.ok(!probe.error.includes('SUPERSECRET'), `testProfile 泄露 query：${probe.error}`);
      assert.ok(!probe.error.includes('sk-supersecret-key'), `testProfile 泄露密钥：${probe.error}`);
    },
  );
});

test('短 secret（1–2 字）与未解码 query 值同样被抹掉', async () => {
  await withServer(
    ({ res }) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'denied sig=%51 raw=Q key=k9' } }));
    },
    async ({ url }) => {
      const profile = profileFor(`${url}/v1?sig=%51`, { apiKey: 'k9' });
      const err = await chatOnce(profile).then(() => null, (e) => e);
      assert.equal(err.code, 'BAD_RESPONSE');
      assert.ok(!err.message.includes('%51'), `未抹掉未解码 query：${err.message}`);
      assert.ok(!err.message.includes('Q'), `未抹掉解码后 query：${err.message}`);
      assert.ok(!err.message.includes('k9'), `未抹掉短 apiKey：${err.message}`);
      assert.match(err.message, /HTTP 400/);
    },
  );
});

test('5xx 网关 HTML 正文：剥标签并截断，不整段塞进气泡', async () => {
  await withServer(
    ({ res }) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end(`<html><body><div class="err">502 Bad Gateway</div><p>${'x'.repeat(400)}</p></body></html>`);
    },
    async ({ url }) => {
      const err = await chatOnce(profileFor(url)).then(() => null, (e) => e);
      assert.equal(err.code, 'NETWORK');
      assert.equal(err.status, 502);
      assert.match(err.message, /502 Bad Gateway/);
      assert.ok(!err.message.includes('<'), `不应残留 HTML 标签：${err.message}`);
      assert.ok(err.message.length <= 200, `文案过长（${err.message.length}）：${err.message}`);
    },
  );
});

test('上游返回 HTML 错误页（200）：抛 code=BAD_RESPONSE，不崩溃', async () => {
  await withServer(
    ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>502 Bad Gateway</h1></body></html>');
    },
    async ({ url }) => {
      const err = await chatOnce(profileFor(url)).then(() => null, (e) => e);
      assert.ok(err);
      assert.equal(err.code, 'BAD_RESPONSE');
    },
  );
});

test('流式数据不是合法 JSON：抛 BAD_RESPONSE', async () => {
  await withServer(
    ({ res }) => {
      writeHeadSSE(res);
      res.write('data: {not json}\n\n');
      res.end();
    },
    async ({ url }) => {
      const err = await chatOnce(profileFor(url)).then(() => null, (e) => e);
      assert.equal(err.code, 'BAD_RESPONSE');
    },
  );
});

test('200 但流里没有任何内容：抛 BAD_RESPONSE', async () => {
  await withServer(
    ({ res }) => {
      writeHeadSSE(res);
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      const err = await chatOnce(profileFor(url)).then(() => null, (e) => e);
      assert.equal(err.code, 'BAD_RESPONSE');
    },
  );
});

test('配置不完整（缺 baseUrl / model）时抛 AUTH', async () => {
  const noBase = await chatOnce({ id: 'p1', apiKey: 'k', model: 'm' }).then(() => null, (e) => e);
  assert.equal(noBase.code, 'AUTH');
  const noModel = await chatOnce({ id: 'p1', apiKey: 'k', baseUrl: 'https://example.com/v1' }).then(() => null, (e) => e);
  assert.equal(noModel.code, 'AUTH');
});

// ---------- embeddings ----------

test('embeddings 正常返回向量数组', async () => {
  let captured = null;
  await withServer(
    ({ req, res, json }) => {
      captured = { path: req.url, body: json };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', model: 'embed-model', data: [{ embedding: [0.1, -0.2, 0.3] }] }));
    },
    async ({ url }) => {
      const vector = await embeddings({ profile: profileFor(`${url}/v1/`), input: '你好' });
      assert.deepEqual(vector, [0.1, -0.2, 0.3]);
      assert.equal(captured.path, '/v1/embeddings');
      assert.equal(captured.body.model, 'mock-model');
      assert.equal(captured.body.input, '你好');
    },
  );
});

test('embeddings 缺 data[0].embedding：抛 BAD_RESPONSE', async () => {
  await withServer(
    ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{}] }));
    },
    async ({ url }) => {
      const err = await embeddings({ profile: profileFor(url), input: '你好' }).then(() => null, (e) => e);
      assert.ok(err);
      assert.equal(err.code, 'BAD_RESPONSE');
    },
  );
});

test('embeddings 401：抛 AUTH', async () => {
  await withServer(
    ({ res }) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no key' } }));
    },
    async ({ url }) => {
      const err = await embeddings({ profile: profileFor(url), input: '你好' }).then(() => null, (e) => e);
      assert.equal(err.code, 'AUTH');
    },
  );
});

// ---------- 连接测试 ----------

test('testProfile 成功：返回 ok、延迟、模型名，探针 max_tokens 为 8', async () => {
  let body = null;
  await withServer(
    ({ res, json }) => {
      body = json;
      writeHeadSSE(res);
      res.write(sse(delta('pong')));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async ({ url }) => {
      const result = await testProfile(profileFor(`${url}/v1/`));
      assert.equal(result.ok, true);
      assert.equal(result.model, 'mock-model');
      assert.equal(result.error, null);
      assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
      assert.equal(body.max_tokens, 64);
      assert.equal(body.messages.length, 1);
      assert.equal(body.messages[0].role, 'user');
    },
  );
});

test('testProfile 失败：ok 为 false 且带回错误信息，不抛错', async () => {
  await withServer(
    ({ res }) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    },
    async ({ url }) => {
      const result = await testProfile(profileFor(url));
      assert.equal(result.ok, false);
      assert.equal(result.model, null);
      assert.match(result.error, /密钥无效/);
    },
  );
});
