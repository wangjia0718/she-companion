'use strict';

// 语音合成（TTS）：把一句话合成为本地 wav，渲染层用 <audio> 播放并画波形。
//
// 为什么放主进程：需要起子进程（piper / PowerShell），渲染层不做 Node；
// 渲染层只拿 file:// URL，播放与频谱分析都在那边（WebAudio AnalyserNode）。
//
// 引擎优先级（settings.voice.engine）：
//   auto  → piper 可用就用 piper（离线神经音色，自然），否则 Windows SAPI（系统自带，机械但一定有）
//   piper → 只用 piper（不可用时回落 SAPI，并在结果里标 fallback）
//   sapi  → 只用系统语音
//
// 只依赖 Node 标准库；不联网。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const CACHE_DIR = path.join(os.tmpdir(), 'she-companion-voice');
const CACHE_MAX = 60;
const SYNTH_TIMEOUT_MS = 30000;
const MAX_CHARS = 200;

/** kokoro 中文音色（女 zf_*，男 zm_*） */
const KOKORO_VOICES = [
  { id: 'zf_xiaoxiao', label: '晓晓（女）' },
  { id: 'zf_xiaobei', label: '小贝（女）' },
  { id: 'zf_xiaoni', label: '小妮（女）' },
  { id: 'zf_xiaoyi', label: '小艺（女）' },
  { id: 'zm_yunjian', label: '云健（男）' },
  { id: 'zm_yunxi', label: '云希（男）' },
  { id: 'zm_yunxia', label: '云夏（男）' },
  { id: 'zm_yunyang', label: '云扬（男）' },
];

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 本机随项目装好的 piper 音色（打包后用户机器上通常没有，走 SAPI） */
const BUNDLED_PIPER_MODEL = path.join(
  os.homedir(), '.local', 'share', 'opencode', 'tools', 'tts', 'piper', 'zh_CN-huayan-medium.onnx',
);

/**
 * 把要朗读的文本清一遍：去掉 Markdown 标记、表情、多余空白，
 * 顺手把太短的括号注释（多为「（笑）」这类舞台提示）去掉，别念出来。
 * @param {unknown} raw
 * @returns {string}
 */
function cleanForSpeech(raw) {
  let text = typeof raw === 'string' ? raw : '';
  if (!text) return '';
  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/^[>\-\s]*[-*+]\s+/gm, '')
    .replace(/（[^（）]{0,6}）/g, '')
    .replace(/\([^()]{0,6}\)/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (text.length > MAX_CHARS) {
    // 截到最后一个句末标点，别把一句话念一半
    const head = text.slice(0, MAX_CHARS);
    const cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
      head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'),
    );
    text = cut > MAX_CHARS * 0.5 ? head.slice(0, cut + 1) : head;
  }
  return text.trim();
}

function cacheKey(text, engine, rate, model) {
  return crypto.createHash('sha1')
    .update(`${engine}|${rate}|${model || ''}|${text}`)
    .digest('hex')
    .slice(0, 20);
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

/** 只保留最近的若干条音频，避免临时目录越堆越多 */
function pruneCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter((name) => name.endsWith('.wav'))
      .map((name) => {
        const full = path.join(CACHE_DIR, name);
        let at = 0;
        try { at = fs.statSync(full).mtimeMs; } catch { at = 0; }
        return { full, at };
      })
      .sort((a, b) => b.at - a.at);
    for (const item of files.slice(CACHE_MAX)) {
      try { fs.unlinkSync(item.full); } catch { /* 删不掉就算了 */ }
    }
  } catch {
    // 清理失败不影响朗读
  }
}

function runFile(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout || SYNTH_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
        message: error ? String((stderr || stdout || error.message || '')).slice(-400) : '',
      });
    });
  });
}

// ---------------------------------------------------------------------------
// piper
// ---------------------------------------------------------------------------

let pythonProbe = null;
let kokoroPythonProbe = null;

/** 找一个能 `import <modules>` 的 Python；结果缓存，失败也缓存（每次朗读都试一遍太慢） */
function probePython(modules) {
  const candidates = [];
  const custom = String(process.env.SHE_COMPANION_PYTHON || '').trim();
  if (custom) candidates.push({ cmd: custom, prefix: [] });
  candidates.push({ cmd: 'python', prefix: [] });
  candidates.push({ cmd: 'py', prefix: ['-3'] });

  return (async () => {
    for (const candidate of candidates) {
      const probe = await runFile(
        candidate.cmd,
        [...candidate.prefix, '-c', `import ${modules.join(',')},sys;sys.stdout.write("ok")`],
        { timeout: 20000 },
      );
      if (probe.ok) return candidate;
    }
    return null;
  })();
}

/** piper：需要 `import piper` */
function findPython() {
  if (!pythonProbe) pythonProbe = probePython(['piper']);
  return pythonProbe;
}

/** kokoro：需要 `import kokoro_onnx, misaki` */
function findKokoroPython() {
  if (!kokoroPythonProbe) kokoroPythonProbe = probePython(['kokoro_onnx', 'misaki']);
  return kokoroPythonProbe;
}

function resolvePiperModel(voice, dir) {
  const custom = voice && typeof voice.modelPath === 'string' ? voice.modelPath.trim() : '';
  if (custom && fs.existsSync(custom)) return custom;
  // 数据目录里的 voice/ 也可以放模型：<dir>/voice/piper/*.onnx（随数据一起备份/迁移）
  if (typeof dir === 'string' && dir) {
    for (const sub of [path.join(dir, 'voice', 'piper'), path.join(dir, 'voice')]) {
      try {
        const hit = fs.readdirSync(sub).find((name) => name.endsWith('.onnx'));
        if (hit) return path.join(sub, hit);
      } catch {
        // 没有就试下一个
      }
    }
  }
  if (fs.existsSync(BUNDLED_PIPER_MODEL)) return BUNDLED_PIPER_MODEL;
  return '';
}

const BUNDLED_KOKORO_DIR = path.join(
  os.homedir(), '.local', 'share', 'opencode', 'tools', 'tts', 'kokoro',
);

/** kokoro 需要两个文件：模型 .onnx 和 voices .bin */
function resolveKokoroFiles(voice, dir) {
  const candidates = [];
  if (typeof dir === 'string' && dir) candidates.push(path.join(dir, 'voice', 'kokoro'));
  candidates.push(BUNDLED_KOKORO_DIR);
  for (const folder of candidates) {
    const model = path.join(folder, 'kokoro-v1.0.onnx');
    const voices = path.join(folder, 'voices-v1.0.bin');
    if (fs.existsSync(model) && fs.existsSync(voices)) return { model, voices };
    try {
      const modelFile = fs.readdirSync(folder).find((name) => /^kokoro.*\.onnx$/.test(name));
      const voiceFile = fs.readdirSync(folder).find((name) => /^voices.*\.bin$/.test(name));
      if (modelFile && voiceFile) {
        return { model: path.join(folder, modelFile), voices: path.join(folder, voiceFile) };
      }
    } catch {
      // 没有就试下一个
    }
  }
  return null;
}

async function synthPiper({ text, out, model, rate }) {
  const python = await findPython();
  if (!python) return { ok: false, engine: 'piper', error: 'python-piper-missing' };
  if (!model) return { ok: false, engine: 'piper', error: 'piper-model-missing' };

  const textFile = `${out}.txt`;
  try {
    fs.writeFileSync(textFile, text, 'utf8');
  } catch (error) {
    return { ok: false, engine: 'piper', error: `write-text-failed: ${error && error.message}` };
  }

  const lengthScale = 1 / (rate > 0 ? rate : 1);
  const args = [
    ...python.prefix,
    '-m', 'piper',
    '-m', model,
    '-i', textFile,
    '-f', out,
    '--length-scale', lengthScale.toFixed(3),
  ];
  const result = await runFile(python.cmd, args, { timeout: SYNTH_TIMEOUT_MS });
  try { fs.unlinkSync(textFile); } catch { /* 忽略 */ }

  if (!result.ok) return { ok: false, engine: 'piper', error: result.message || 'piper-failed' };
  let size = 0;
  try { size = fs.statSync(out).size; } catch { size = 0; }
  if (!size) return { ok: false, engine: 'piper', error: 'piper-empty' };
  return { ok: true, engine: 'piper', file: out, bytes: size };
}

// ---------------------------------------------------------------------------
// kokoro（离线神经音色，中文有 8 个音色）
// ---------------------------------------------------------------------------

const KOKORO_SCRIPT = path.join(__dirname, 'tts_kokoro.py');

/**
 * 把打包进 asar 的 Python 脚本落到磁盘上再执行：
 * 子进程读不了 asar 里的虚拟路径，必须先复制成真实文件。
 */
function ensureKokoroScript() {
  try {
    const source = fs.readFileSync(KOKORO_SCRIPT, 'utf8');
    ensureCacheDir();
    const target = path.join(CACHE_DIR, 'tts_kokoro.py');
    let current = '';
    try { current = fs.readFileSync(target, 'utf8'); } catch { current = ''; }
    if (current !== source) fs.writeFileSync(target, source, 'utf8');
    return target;
  } catch {
    return '';
  }
}

async function synthKokoro({ text, out, files, rate, voiceName }) {
  if (!files) return { ok: false, engine: 'kokoro', error: 'kokoro-model-missing' };
  const python = await findKokoroPython();
  if (!python) return { ok: false, engine: 'kokoro', error: 'python-kokoro-missing' };
  const script = ensureKokoroScript();
  if (!script) return { ok: false, engine: 'kokoro', error: 'kokoro-script-missing' };

  const result = await kokoroRequest(python, script, {
    text,
    voice: voiceName || 'zf_xiaoxiao',
    speed: rate > 0 ? rate : 1,
    model: files.model,
    voices: files.voices,
    out,
  });

  if (!result.ok) return { ok: false, engine: 'kokoro', error: result.error || 'kokoro-failed' };
  let size = 0;
  try { size = fs.statSync(out).size; } catch { size = 0; }
  if (!size) return { ok: false, engine: 'kokoro', error: 'kokoro-empty' };
  return { ok: true, engine: 'kokoro', file: out, bytes: size };
}

// --- kokoro 常驻进程：模型只载一次，之后每句只要一次推理 ---

const KOKORO_IDLE_MS = 10 * 60 * 1000;
let kokoroWorker = null;
let kokoroSeq = 0;

function stopKokoroWorker() {
  const worker = kokoroWorker;
  kokoroWorker = null;
  if (!worker) return;
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  for (const [, pending] of worker.pending) pending.resolve({ ok: false, error: 'worker-closed' });
  worker.pending.clear();
  try { worker.proc.stdin.end(); } catch { /* 忽略 */ }
  try { worker.proc.kill(); } catch { /* 忽略 */ }
}

function spawnKokoroWorker(python, script) {
  const proc = spawn(python.cmd, [...python.prefix, script], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const worker = { proc, pending: new Map(), buffer: '', idleTimer: null };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    worker.buffer += chunk;
    let index = worker.buffer.indexOf('\n');
    while (index >= 0) {
      const line = worker.buffer.slice(0, index).trim();
      worker.buffer = worker.buffer.slice(index + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          const pending = worker.pending.get(msg.id);
          if (pending) {
            worker.pending.delete(msg.id);
            pending.resolve(msg);
          }
        } catch {
          // 非 JSON 输出（警告之类）直接忽略
        }
      }
      index = worker.buffer.indexOf('\n');
    }
  });
  proc.stderr.on('data', () => { /* jieba / onnxruntime 的日志，丢掉 */ });
  proc.on('error', () => {
    for (const [, pending] of worker.pending) pending.resolve({ ok: false, error: 'worker-spawn-failed' });
    worker.pending.clear();
    if (kokoroWorker === worker) kokoroWorker = null;
  });
  proc.on('exit', () => {
    for (const [, pending] of worker.pending) pending.resolve({ ok: false, error: 'worker-exited' });
    worker.pending.clear();
    if (kokoroWorker === worker) kokoroWorker = null;
  });

  return worker;
}

function kokoroRequest(python, script, payload) {
  const key = `${python.cmd} ${python.prefix.join(' ')} ${script}`;
  if (kokoroWorker && kokoroWorker.key !== key) stopKokoroWorker();
  if (!kokoroWorker) {
    kokoroWorker = spawnKokoroWorker(python, script);
    kokoroWorker.key = key;
  }
  const worker = kokoroWorker;
  const id = ++kokoroSeq;

  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = setTimeout(() => stopKokoroWorker(), KOKORO_IDLE_MS);
  if (worker.idleTimer && typeof worker.idleTimer.unref === 'function') worker.idleTimer.unref();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.pending.delete(id);
      resolve({ ok: false, error: 'timeout' });
    }, SYNTH_TIMEOUT_MS + 30000);

    worker.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });

    try {
      worker.proc.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch (error) {
      worker.pending.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: `stdin-write-failed: ${error && error.message}` });
    }
  });
}

// ---------------------------------------------------------------------------
// Windows SAPI
// ---------------------------------------------------------------------------

/** 语速倍率 → SAPI 的 -10..10 档位（0 = 正常） */
function sapiRateFor(rate) {
  const value = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return Math.max(-10, Math.min(10, Math.round(Math.log2(value) * 8)));
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

async function synthSapi({ text, out, rate, voiceName }) {
  const textFile = `${out}.txt`;
  try {
    fs.writeFileSync(textFile, text, 'utf8');
  } catch (error) {
    return { ok: false, engine: 'sapi', error: `write-text-failed: ${error && error.message}` };
  }

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.Rate = ${sapiRateFor(rate)}`,
  ];
  if (typeof voiceName === 'string' && voiceName.trim()) {
    lines.push(`try { $s.SelectVoice('${psQuote(voiceName.trim())}') } catch { }`);
  }
  lines.push(`$s.SetOutputToWaveFile('${psQuote(out)}')`);
  lines.push(`$text = [IO.File]::ReadAllText('${psQuote(textFile)}', [Text.Encoding]::UTF8)`);
  lines.push('$s.Speak($text)');
  lines.push('$s.Dispose()');

  const encoded = Buffer.from(lines.join('\r\n'), 'utf16le').toString('base64');
  const result = await runFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: SYNTH_TIMEOUT_MS },
  );
  try { fs.unlinkSync(textFile); } catch { /* 忽略 */ }

  if (!result.ok) return { ok: false, engine: 'sapi', error: result.message || 'sapi-failed' };
  let size = 0;
  try { size = fs.statSync(out).size; } catch { size = 0; }
  if (!size) return { ok: false, engine: 'sapi', error: 'sapi-empty' };
  return { ok: true, engine: 'sapi', file: out, bytes: size };
}

// ---------------------------------------------------------------------------
// 对外
// ---------------------------------------------------------------------------

function pathToFileUrl(file) {
  return require('node:url').pathToFileURL(path.resolve(String(file))).href;
}

/**
 * 把一句话合成为音频文件。
 * @param {{ text: string, voice?: object, dir?: string }} input voice 即 settings.voice，dir 是数据目录
 * @returns {Promise<{ ok: boolean, url?: string, engine?: string, cached?: boolean, error?: string }>}
 */
async function speak({ text, voice, dir } = {}) {
  const config = voice && typeof voice === 'object' ? voice : {};
  const engineWanted = ['auto', 'kokoro', 'piper', 'sapi'].includes(config.engine) ? config.engine : 'auto';
  const rate = Number.isFinite(Number(config.rate)) ? Number(config.rate) : 1;
  const spoken = cleanForSpeech(text);
  if (!spoken) return { ok: false, error: 'empty' };

  const piperModel = resolvePiperModel(config, dir);
  const kokoroFiles = resolveKokoroFiles(config, dir);
  const kokoroVoice = clean(config.kokoroVoice) || 'zf_xiaoxiao';

  // auto：先用质量最好的 kokoro，再 piper，最后系统语音（任何一环缺失就往下退，不会没声）
  const order = engineWanted === 'sapi'
    ? ['sapi']
    : engineWanted === 'piper'
      ? ['piper', 'sapi']
      : engineWanted === 'kokoro'
        ? ['kokoro', 'piper', 'sapi']
        : ['kokoro', 'piper', 'sapi'];

  ensureCacheDir();
  let firstError = '';

  for (const engine of order) {
    const extra = engine === 'kokoro'
      ? `${kokoroVoice}|${kokoroFiles ? kokoroFiles.model : ''}`
      : engine === 'piper' ? piperModel : config.sapiVoice;
    const key = cacheKey(spoken, engine, rate, extra);
    const out = path.join(CACHE_DIR, `speak-${key}.wav`);

    let exists = false;
    try { exists = fs.statSync(out).size > 0; } catch { exists = false; }
    if (exists) {
      return { ok: true, url: pathToFileUrl(out), engine, cached: true };
    }

    let result;
    if (engine === 'kokoro') {
      result = await synthKokoro({ text: spoken, out, files: kokoroFiles, rate, voiceName: kokoroVoice });
    } else if (engine === 'piper') {
      result = await synthPiper({ text: spoken, out, model: piperModel, rate });
    } else {
      result = await synthSapi({ text: spoken, out, rate, voiceName: config.sapiVoice });
    }

    if (result.ok) {
      pruneCache();
      return { ok: true, url: pathToFileUrl(result.file), engine, cached: false };
    }
    if (!firstError) firstError = `${engine}: ${result.error || 'failed'}`;
  }

  return { ok: false, error: firstError || 'tts-failed' };
}

/** 设置页用：当前机器上各引擎是否可用（都做缓存，避免每次点开设置都起子进程） */
let statusCache = null;

function status({ voice, dir } = {}) {
  if (statusCache) return statusCache;
  const config = voice && typeof voice === 'object' ? voice : {};
  statusCache = (async () => {
    const piperModel = resolvePiperModel(config, dir);
    const kokoroFiles = resolveKokoroFiles(config, dir);
    const [piperPython, kokoroPython] = await Promise.all([
      piperModel ? findPython() : null,
      kokoroFiles ? findKokoroPython() : null,
    ]);
    return {
      kokoro: {
        ok: Boolean(kokoroFiles && kokoroPython),
        voices: KOKORO_VOICES,
        reason: kokoroFiles && kokoroPython ? '' : (kokoroFiles ? 'python-missing' : 'model-missing'),
      },
      piper: {
        ok: Boolean(piperModel && piperPython),
        model: piperModel ? path.basename(piperModel) : '',
        reason: piperModel && piperPython ? '' : (piperModel ? 'python-missing' : 'model-missing'),
      },
      sapi: { ok: process.platform === 'win32' },
    };
  })();
  return statusCache;
}

function resetCaches() {
  pythonProbe = null;
  kokoroPythonProbe = null;
  statusCache = null;
  stopKokoroWorker();
}

module.exports = {
  speak,
  status,
  cleanForSpeech,
  sapiRateFor,
  resolvePiperModel,
  resolveKokoroFiles,
  pathToFileUrl,
  resetCaches,
  CACHE_DIR,
  MAX_CHARS,
  KOKORO_VOICES,
};

// 应用退出时别把常驻的 python 留在后台
process.once('exit', () => {
  stopKokoroWorker();
});
