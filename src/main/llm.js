'use strict';

// OpenAI 兼容模型客户端（Spec 6）：流式 chat / embeddings / 连接测试。
// 只用 Node 标准库（Node 24 内置 fetch）；CommonJS。
//
// 安全约定：任何进入用户可见文案的错误信息都经过 makeSanitizer 过滤，
// 不得回显 apiKey、baseUrl 的 query 值，也不得回显传输层原始 message。

const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_MAX_TOKENS = 1024;
// 空闲超时：多久没有新数据就放弃（每收到一个 chunk 重置）
const DEFAULT_IDLE_TIMEOUT_MS = 120000;
// 总时长上限：防止慢速滴流无限挂着
const TOTAL_TIMEOUT_MS = 600000;
// 重试退避：第 1 次 1s，第 2 次 3s（Spec 6）
const RETRY_DELAYS = [1000, 3000];
// usage 缺失时按字符估算 token（Spec 6 / 计划 Task 3）
const CHARS_PER_TOKEN = 1.5;
const ERROR_CODES = new Set(['AUTH', 'RATE', 'NETWORK', 'BAD_RESPONSE', 'ABORTED']);

/**
 * 统一错误形状：Error & { code, status? }。
 * retryable 只对 429 / 5xx / 网络错误为 true。
 */
function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  err.retryable = code === 'RATE' || code === 'NETWORK';
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) err[key] = value;
    }
  }
  return err;
}

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  if (typeof error.code === 'string') return error.code;
  return '';
}

/**
 * 生成「可安全展示」的文案清洗器：抹掉 apiKey 与 baseUrl 的 query，
 * 剥 HTML 标签、压成单行、截断到 120 字。上游正文可能回显整条 URL。
 */
function makeSanitizer(profile) {
  const secrets = new Set();
  const key = profile && typeof profile.apiKey === 'string' ? profile.apiKey.trim() : '';
  const base = profile && typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
  const queryIndex = base.indexOf('?');
  const query = queryIndex === -1 ? '' : base.slice(queryIndex);

  // 只要非空就抹：短 secret 也要挡，宁可文案难看也不能泄漏
  if (key !== '') secrets.add(key);
  if (query) {
    for (const pair of query.slice(1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const raw = pair.slice(eq + 1);
      if (raw !== '') secrets.add(raw); // 原始未解码值
      let decoded = raw.replace(/\+/g, ' ');
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        /* 保留原样 */
      }
      if (decoded !== '') secrets.add(decoded); // 解码后值
    }
  }

  // 长的先替换，避免短串把长串切碎后漏掉后半段
  const ordered = Array.from(secrets).sort((a, b) => b.length - a.length);

  return function safe(text) {
    let out = String(text === undefined || text === null ? '' : text);
    if (query) out = out.split(query).join('?***');
    for (const secret of ordered) out = out.split(secret).join('***');
    out = out.replace(/<[^>]*>/g, ' ');
    out = out.replace(/\s+/g, ' ').trim();
    if (out.length > 120) out = `${out.slice(0, 120)}…`;
    return out;
  };
}

function statusError(status, detail) {
  const tail = detail ? `：${detail}` : '';
  if (status === 401 || status === 403) {
    return fail('AUTH', `密钥无效或权限不足（HTTP ${status}）${tail}`, { status });
  }
  if (status === 429) {
    return fail('RATE', `请求过于频繁或额度不足（HTTP 429）${tail}`, { status });
  }
  if (status >= 500) {
    return fail('NETWORK', `模型服务暂时不可用（HTTP ${status}）${tail}`, { status });
  }
  return fail('BAD_RESPONSE', `模型返回异常（HTTP ${status}）${tail}`, { status });
}

function requireProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw fail('AUTH', '还没配置模型，请先到设置里填一下 API');
  }
  if (typeof profile.baseUrl !== 'string' || !/^https?:\/\//i.test(profile.baseUrl.trim())) {
    throw fail('AUTH', '模型地址（baseUrl）还没填好，请先到设置里补上');
  }
  if (typeof profile.model !== 'string' || profile.model.trim() === '') {
    throw fail('AUTH', '模型名（model）还没填，请先到设置里补上');
  }
  // 先 trim：粘贴常带尾部换行，那是可以容忍的；中间的控制字符才说明粘贴坏了
  if (typeof profile.apiKey === 'string') {
    const key = profile.apiKey.trim();
    if (/[\r\n\0]/.test(key)) {
      throw fail('AUTH', '密钥中间有换行，请重新粘贴一次');
    }
  }
}

/**
 * baseUrl 去尾斜杠 + 接口路径；query 保持在末尾，不能拼到路径中间。
 * 例：https://x/v1?api-version=1 → https://x/v1/chat/completions?api-version=1
 */
function endpoint(baseUrl, pathname) {
  const base = String(baseUrl).trim();
  const cut = base.indexOf('?');
  if (cut === -1) return base.replace(/\/+$/, '') + pathname;
  return base.slice(0, cut).replace(/\/+$/, '') + pathname + base.slice(cut);
}

function estimateTokens(chars) {
  if (!chars || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (part && typeof part.text === 'string') return sum + part.text.length;
      return sum;
    }, 0);
  }
  return 0;
}

function readTokenCount(usage, snake, camel) {
  if (!usage || typeof usage !== 'object') return null;
  for (const key of [snake, camel]) {
    const value = usage[key];
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return null;
}

/** 优先用上游 usage；缺任一项则按字符数估算 */
function normalizeUsage(usage, messages, text) {
  const promptTokens = readTokenCount(usage, 'prompt_tokens', 'promptTokens');
  const completionTokens = readTokenCount(usage, 'completion_tokens', 'completionTokens');
  if (promptTokens !== null && completionTokens !== null) {
    return { promptTokens, completionTokens, estimated: false };
  }
  const promptChars = (Array.isArray(messages) ? messages : []).reduce(
    (sum, message) => sum + contentChars(message && message.content),
    0,
  );
  return {
    promptTokens: promptTokens === null ? estimateTokens(promptChars) : promptTokens,
    completionTokens: completionTokens === null ? estimateTokens(String(text || '').length) : completionTokens,
    estimated: true,
  };
}

// ---------- 请求作用域（空闲超时 + 总时长上限 + 用户取消） ----------

function createScope(signal, { idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, totalTimeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timeoutReason = null;
  let idleTimer = null;

  const timeout = (reason) => {
    if (timeoutReason) return;
    timeoutReason = reason;
    controller.abort();
  };

  const touch = () => {
    if (timeoutReason) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => timeout('idle'), idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  touch();
  const totalTimer = setTimeout(() => timeout('total'), totalTimeoutMs);
  if (typeof totalTimer.unref === 'function') totalTimer.unref();

  let onAbort = null;
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    touch,
    timedOut: () => timeoutReason !== null,
    timeoutReason: () => timeoutReason,
    abortedByUser: () => Boolean(signal && signal.aborted),
    dispose() {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 传输层失败：只用稳定错误码，绝不回显 fetch 的原始 message
 *（它可能包含 Authorization 头内容）。
 */
function toTransportError(err, scope, userSignal) {
  if (err && ERROR_CODES.has(err.code) && err instanceof Error) return err;

  const aborted = Boolean(
    err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'),
  ) || Boolean(scope && scope.signal.aborted);

  if (aborted) {
    if ((userSignal && userSignal.aborted) || !scope || !scope.timedOut()) {
      return fail('ABORTED', '已取消本次请求');
    }
    const reason = scope.timeoutReason();
    if (reason === 'idle') {
      return fail('NETWORK', '模型服务长时间没有新响应，已停止等待');
    }
    return fail('NETWORK', '本次请求总时长超限，已停止等待');
  }

  const causeCode = (err && err.cause && (err.cause.code
    || (err.cause.cause && err.cause.cause.code))) || '';
  const reason = causeCode ? `网络错误 ${causeCode}` : '网络错误，请检查地址与网络';
  return fail('NETWORK', `连不上模型服务（${reason}）`);
}

function normalizeError(err, scope, userSignal) {
  if (err instanceof Error && ERROR_CODES.has(err.code)) return err;
  return toTransportError(err, scope, userSignal);
}

async function fetchWithScope(url, { apiKey, body, signal, stream, idleTimeoutMs, extraHeaders, userAgent }) {
  const scope = createScope(signal, { idleTimeoutMs });
  const headers = { 'content-type': 'application/json' };
  if (stream) headers.accept = 'text/event-stream';
  if (typeof apiKey === 'string' && apiKey.trim() !== '') {
    headers.authorization = `Bearer ${apiKey.trim()}`;
  }
  // 允许配置组自带额外请求头（例如 OpenCode Go 要求的 x-opencode-session）
  if (extraHeaders && typeof extraHeaders === 'object' && !Array.isArray(extraHeaders)) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (typeof key !== 'string' || !key) continue;
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      if (/[\r\n\0]/.test(String(value))) continue;
      headers[key.toLowerCase()] = String(value);
    }
  }
  if (typeof userAgent === 'string' && userAgent.trim()) headers['user-agent'] = userAgent.trim();
  else headers['user-agent'] = 'she-companion/0.1';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: scope.signal,
    });
  } catch (err) {
    scope.dispose();
    throw toTransportError(err, scope, signal);
  }
  return { res, scope };
}

async function readText(res) {
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString('utf8');
}

/** 从错误响应体里抠一句可读原因（非 JSON 也能用），始终经过清洗 */
async function readErrorDetail(res, safe) {
  let raw = '';
  try {
    raw = await readText(res);
  } catch {
    return '';
  }
  const trimmed = String(raw || '').trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const payload = JSON.parse(trimmed);
      const detail = errorText(payload && payload.error ? payload.error : payload);
      if (detail) return safe(detail);
    } catch {
      /* 落到下方按纯文本处理 */
    }
  }
  return safe(trimmed);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(fail('ABORTED', '已取消本次请求'));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(fail('ABORTED', '已取消本次请求'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------- 流式解析 ----------

/**
 * 逐行消费 SSE：data: {...} / data: [DONE]，只取 choices[0].delta.content。
 * 用 TextDecoder({stream:true}) 解码，避免多字节中文被 chunk 边界切断后乱码；
 * 每收到一个 chunk 重置空闲超时。
 */
async function consumeStream(res, { onDelta, state, signal, scope, model, safe, allowEmpty = false }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let usage = null;
  let finished = false;
  let currentModel = model;

  const emit = (delta) => {
    state.text += delta;
    if (typeof onDelta !== 'function') return;
    try {
      onDelta(delta);
    } catch (err) {
      // 调用方回调自身出错：不重试，也不冒充「用户取消」
      throw fail('BAD_RESPONSE', '处理增量内容时出错，已停止生成', {
        source: 'onDelta',
        cause: err,
      });
    }
  };

  const handle = (rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) return false; // 空行 / SSE 注释
    if (!line.startsWith('data:')) return false; // event: / id: / retry: 一律忽略
    const data = line.slice(5).trim();
    if (data === '') return false;
    if (data === '[DONE]') return true;

    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw fail('BAD_RESPONSE', `流式数据不是合法 JSON：${safe(data.slice(0, 120))}`);
    }
    if (chunk && chunk.error) {
      throw fail('BAD_RESPONSE', `模型返回错误：${safe(errorText(chunk.error))}`);
    }
    if (chunk && typeof chunk.model === 'string' && chunk.model) currentModel = chunk.model;
    if (chunk && chunk.usage) usage = chunk.usage;

    const choice = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    let delta = '';
    if (choice && choice.delta && typeof choice.delta.content === 'string') {
      delta = choice.delta.content;
    } else if (choice && choice.message && typeof choice.message.content === 'string') {
      delta = choice.message.content;
    }
    if (delta) emit(delta);
    return false;
  };

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      if (scope && typeof scope.touch === 'function') scope.touch();
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (handle(line)) {
          finished = true;
          break;
        }
      }
    }
    if (!finished) {
      buffer += decoder.decode();
      if (buffer.trim() !== '') handle(buffer);
    }
  } catch (err) {
    throw normalizeError(err, scope, signal);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 对端已断开，忽略 */
    }
  }

  if (!state.text) {
    // 推理型模型可能把 max_tokens 全花在 reasoning_content 上；探测连接时允许空正文
    if (allowEmpty) return { model: currentModel, usage, empty: true };
    throw fail('BAD_RESPONSE', '模型没有返回任何内容（响应不是可识别的流式数据）');
  }
  return { model: currentModel, usage };
}

// ---------- 单次请求 ----------

async function chatAttempt({ profile, messages, onDelta, signal, state, maxTokens, idleTimeoutMs, allowEmpty = false }) {
  const url = endpoint(profile.baseUrl, '/chat/completions');
  const safe = makeSanitizer(profile);
  const body = {
    model: profile.model,
    messages,
    stream: true,
    temperature: profile.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: maxTokens ?? profile.maxTokens ?? DEFAULT_MAX_TOKENS,
  };

  const { res, scope } = await fetchWithScope(url, {
    apiKey: profile.apiKey,
    body,
    signal,
    stream: true,
    idleTimeoutMs,
    extraHeaders: profile.headers,
    userAgent: profile.userAgent,
  });

  let model = profile.model;
  let usage = null;

  try {
    if (!res.ok) {
      const detail = await readErrorDetail(res, safe);
      throw statusError(res.status, detail);
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw fail('BAD_RESPONSE', '模型返回的是网页内容（可能被网关或代理拦截），不是对话数据');
    }

    if (contentType.includes('application/json')) {
      // 个别服务无视 stream:true，直接回一次性 JSON，这里兜住。
      const raw = await readText(res);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw fail('BAD_RESPONSE', '模型返回的内容不是合法 JSON');
      }
      if (payload && payload.error) {
        throw fail('BAD_RESPONSE', `模型返回错误：${safe(errorText(payload.error))}`);
      }
      const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
      const content = choice && choice.message && typeof choice.message.content === 'string'
        ? choice.message.content
        : '';
      if (content === '') {
        if (allowEmpty) {
          if (payload && typeof payload.model === 'string' && payload.model) model = payload.model;
          usage = payload ? payload.usage || null : null;
        } else {
          throw fail('BAD_RESPONSE', '模型没有返回任何内容');
        }
      }
      if (content !== '') {
        state.text += content;
        if (typeof onDelta === 'function') {
          try {
            onDelta(content);
          } catch (err) {
            throw fail('BAD_RESPONSE', '处理增量内容时出错，已停止生成', {
              source: 'onDelta',
              cause: err,
            });
          }
        }
      }
    } else {
      const streamed = await consumeStream(res, { onDelta, state, signal, scope, model, safe, allowEmpty });
      model = streamed.model;
      usage = streamed.usage;
    }
  } catch (err) {
    throw normalizeError(err, scope, signal);
  } finally {
    scope.dispose();
  }

  return {
    text: state.text,
    usage: normalizeUsage(usage, messages, state.text),
    model,
  };
}

async function postJSON({ url, profile, body, signal, idleTimeoutMs, safe }) {
  const { res, scope } = await fetchWithScope(url, {
    apiKey: profile.apiKey,
    body,
    signal,
    idleTimeoutMs,
    extraHeaders: profile.headers,
    userAgent: profile.userAgent,
  });
  try {
    if (!res.ok) {
      const detail = await readErrorDetail(res, safe);
      throw statusError(res.status, detail);
    }
    const raw = await readText(res);
    try {
      return JSON.parse(raw);
    } catch {
      throw fail('BAD_RESPONSE', '模型返回的内容不是合法 JSON');
    }
  } catch (err) {
    throw normalizeError(err, scope, signal);
  } finally {
    scope.dispose();
  }
}

function shouldRetry(err, retryIndex, maxRetry, signal) {
  if (!err || err.retryable !== true) return false;
  if (signal && signal.aborted) return false;
  return retryIndex < maxRetry;
}

function toRetryCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

// ---------- 对外接口 ----------

/**
 * 流式对话。失败抛 Error & { code }；已生成内容挂在 err.partialText（不重试，避免重复）。
 * @param {{ profile: object, messages: object[], onDelta?: (delta: string) => void,
 *           signal?: AbortSignal, retry?: number, maxTokens?: number, timeoutMs?: number }} options
 *   timeoutMs：空闲超时（毫秒），每收到一个 chunk 重置；仅供测试/特殊场景覆盖。
 * @returns {Promise<{ text: string, usage: { promptTokens: number, completionTokens: number, estimated: boolean }, model: string }>}
 */
async function chat({
  profile, messages, onDelta, signal, retry = 2, maxTokens, timeoutMs, allowEmpty = false,
} = {}) {
  requireProfile(profile);
  if (signal && signal.aborted) throw fail('ABORTED', '已取消本次请求');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('chat 需要非空的 messages 数组');
  }

  const maxRetry = toRetryCount(retry);
  const state = { text: '' };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chatAttempt({
        profile, messages, onDelta, signal, state, maxTokens, idleTimeoutMs: timeoutMs, allowEmpty,
      });
    } catch (err) {
      if (err && state.text) err.partialText = state.text;
      // 已经吐出内容、或调用方自己出错，都不重试
      if (state.text || (err && err.source === 'onDelta')) throw err;
      if (!shouldRetry(err, attempt, maxRetry, signal)) throw err;
      const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
      await sleep(delay, signal);
    }
  }
}

/**
 * 向量化，返回 data[0].embedding。
 * @param {{ profile: object, input: string|string[], signal?: AbortSignal,
 *           retry?: number, timeoutMs?: number }} options
 * @returns {Promise<number[]>}
 */
async function embeddings({ profile, input, signal, retry = 2, timeoutMs } = {}) {
  requireProfile(profile);
  if (signal && signal.aborted) throw fail('ABORTED', '已取消本次请求');
  if (input === undefined || input === null) {
    throw new TypeError('embeddings 需要 input');
  }

  const safe = makeSanitizer(profile);
  const maxRetry = toRetryCount(retry);

  for (let attempt = 0; ; attempt += 1) {
    try {
      const payload = await postJSON({
        url: endpoint(profile.baseUrl, '/embeddings'),
        profile,
        body: { model: profile.model, input },
        signal,
        idleTimeoutMs: timeoutMs,
        safe,
      });
      const embedding = payload && Array.isArray(payload.data) && payload.data[0]
        ? payload.data[0].embedding
        : null;
      if (
        !Array.isArray(embedding)
        || embedding.length === 0
        || !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        throw fail('BAD_RESPONSE', 'embeddings 响应缺少可用的 data[0].embedding');
      }
      return embedding;
    } catch (err) {
      if (!shouldRetry(err, attempt, maxRetry, signal)) throw err;
      const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
      await sleep(delay, signal);
    }
  }
}

/**
 * 连接测试：发一条 max_tokens: 8 的探针，返回延迟与模型名（不抛错）。
 * error 字段同样是清洗过的文案，不含密钥。
 * @param {object} profile
 * @returns {Promise<{ ok: boolean, latencyMs: number, model: string|null, error: string|null }>}
 */
async function testProfile(profile) {
  const started = Date.now();
  try {
    const result = await chat({
      profile,
      messages: [{ role: 'user', content: '只回复两个字：在的' }],
      retry: 0,
      maxTokens: 64,
      allowEmpty: true,
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      model: result.model,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      model: null,
      error: err && err.message ? err.message : '连接失败',
      code: err && err.code ? err.code : undefined,
    };
  }
}

module.exports = {
  chat,
  embeddings,
  testProfile,
  RETRY_DELAYS,
  DEFAULT_IDLE_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
};
