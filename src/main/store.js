'use strict';

// 存储层：JSON/JSONL 原子读写、损坏恢复（.bak / *.corrupt-*）、角色 CRUD。
// 只依赖 Node 标准库与 paths；不得依赖 config（避免循环依赖）。

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EEXIST']);
const EMPTY_MEMORY = { cards: [], lastExtractedMessageId: null };
const EMPTY_TIMELINE = { days: {} };

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地时区的 ISO 时间串（带 +08:00 这样的偏移；不要用 toISOString，会变 UTC） */
function localISOString(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** 本地时区的 YYYY-MM-DD */
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function warn(message) {
  console.warn(`[store] ${message}`);
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function unlinkQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 清理失败忽略，保留原始错误
  }
}

function serialize(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// 原子写
// ---------------------------------------------------------------------------

/** 写 `<file>.tmp` 再 rename；失败时清理 .tmp。不触碰 .bak。 */
function writeTextAtomic(file, body) {
  ensureParent(file);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    unlinkQuiet(tmp);
    throw err;
  }
}

/**
 * 原子写 JSON。
 * - 先写 `<file>.tmp`；
 * - rename 前把当前文件复制成 `<file>.bak`（因此 .bak 恒为「上一次」的内容）；
 * - rename 失败（Windows 上目标被占用）时把旧文件挪到 .bak 再重试，失败则回滚。
 */
function writeJSON(file, obj) {
  const body = serialize(obj);
  ensureParent(file);
  const tmp = `${file}.tmp`;
  const bak = `${file}.bak`;
  const hadFile = fs.existsSync(file);

  try {
    fs.writeFileSync(tmp, body, 'utf8');

    if (hadFile) {
      // 复制而非 rename：改名窗口内主文件始终可读；.bak 始终是上一次的内容
      fs.copyFileSync(file, bak);
    }

    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      if (!RETRYABLE_RENAME_CODES.has(err.code) || !hadFile) throw err;
      // 目标被占用（Windows 常见）：把旧文件挪开，让新文件落到目标位置
      try {
        fs.renameSync(file, bak);
      } catch (moveErr) {
        if (RETRYABLE_RENAME_CODES.has(moveErr.code)) {
          fs.rmSync(bak, { force: true });
          fs.renameSync(file, bak);
        } else if (moveErr.code !== 'ENOENT') {
          throw err;
        }
      }
      try {
        fs.renameSync(tmp, file);
      } catch (retryErr) {
        // 回滚：把旧文件放回原位，避免主文件消失
        try {
          fs.renameSync(bak, file);
        } catch {
          // 回滚失败时旧内容仍在 .bak 里，不丢数据
        }
        throw retryErr;
      }
    }
  } catch (err) {
    unlinkQuiet(tmp);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 读取与损坏恢复
// ---------------------------------------------------------------------------

const MISSING = 'missing';
const IO_ERROR = 'io';
const EMPTY = 'empty';
const PARSE_ERROR = 'parse';

function inspectJSON(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { kind: err.code === 'ENOENT' ? MISSING : IO_ERROR, error: err };
  }
  // 编辑器/PowerShell 可能写入 UTF-8 BOM；剥掉再 parse，否则会被误判为损坏
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') return { kind: EMPTY };
  try {
    return { kind: 'ok', value: JSON.parse(text) };
  } catch (err) {
    return { kind: PARSE_ERROR, error: err };
  }
}

function isCorrupt(kind) {
  return kind === PARSE_ERROR || kind === EMPTY;
}

/** 把坏文件改名留证：<file>.corrupt-<ts>（同一毫秒内重名时追加序号）。 */
function quarantine(file) {
  if (!fs.existsSync(file)) return null;
  const base = `${file}.corrupt-${Date.now()}`;
  let target = base;
  let index = 1;
  while (fs.existsSync(target)) {
    target = `${base}-${index}`;
    index += 1;
  }
  try {
    fs.renameSync(file, target);
    warn(`${path.basename(file)} 内容损坏，已保留为 ${path.basename(target)}`);
    return target;
  } catch (err) {
    warn(`无法保留损坏文件 ${path.basename(file)}（${err.code || err.message}）`);
    return null;
  }
}

/**
 * 读取 JSON，损坏时按「主文件 → .bak → *.corrupt-* + fallback」恢复链处理。
 * 任何情况下都不抛异常；用到 .bak 时把内容写回主文件，不改动 .bak。
 * @param {string} file
 * @param {*} fallback 主文件与备份都不可用时的返回值
 */
function readJSON(file, fallback) {
  const main = inspectJSON(file);
  if (main.kind === 'ok') return main.value;

  const bakFile = `${file}.bak`;
  const backup = inspectJSON(bakFile);
  if (backup.kind === 'ok') {
    try {
      writeTextAtomic(file, serialize(backup.value));
      warn(`${path.basename(file)} 不可用，已从 ${path.basename(bakFile)} 恢复`);
    } catch (err) {
      warn(`${path.basename(file)} 已从 .bak 读取，但写回失败（${err.code || err.message}）`);
    }
    return backup.value;
  }

  if (isCorrupt(main.kind)) quarantine(file);
  else if (main.kind === IO_ERROR && main.error) {
    warn(`读取 ${path.basename(file)} 失败（${main.error.code || main.error.message}），返回默认值`);
  }
  if (isCorrupt(backup.kind)) quarantine(bakFile);

  if (main.kind !== MISSING && backup.kind !== MISSING) {
    warn(`${path.basename(file)} 与 .bak 均不可用，返回默认值`);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// JSONL
// ---------------------------------------------------------------------------

/** 追加一行 JSON（单行一条，末尾加 \n）。 */
function appendJSONL(file, obj) {
  ensureParent(file);
  let prefix = '';
  try {
    const stat = fs.statSync(file);
    if (stat.size > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, stat.size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(obj)}\n`, 'utf8');
}

/**
 * 读取 JSONL；坏行跳过（计数后告警），limit 只返回最后 N 条。
 * @param {string} file
 * @param {{ limit?: number }} [options]
 */
function readJSONL(file, options = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    warn(`读取 ${path.basename(file)} 失败（${err.code || err.message}），按空列表处理`);
    return [];
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) warn(`${path.basename(file)} 跳过 ${skipped} 行无法解析的内容`);

  const limit = isPlainObject(options) && Number.isInteger(options.limit) ? options.limit : null;
  if (limit !== null && limit >= 0 && rows.length > limit) {
    return limit === 0 ? [] : rows.slice(-limit);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------

function assertSafeId(id) {
  const value = String(id === undefined || id === null ? '' : id);
  if (
    // 首字符不能是点：排除 . / .. / ... 之类的目录穿越写法
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value) ||
    // Windows 会静默去掉结尾的点，导致不同 id 落到同一目录
    value.endsWith('.') ||
    // Windows 保留设备名，即使带扩展名也不能作为文件/目录名
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(value)
  ) {
    throw new Error(`非法角色 id：${JSON.stringify(id)}`);
  }
  return value;
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value, fallback = []) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : fallback.slice();
}

const DEFAULT_PERSONA = {
  traits: ['温柔', '有点懒', '观察细'],
  speechStyle: '短句、口语、不用书面词、偶尔用省略号',
  catchphrases: ['嗯…'],
  background: '',
  relationship: '认识很久的朋友，说话不用客套',
  boundaries: ['不编造没发生过的事', '不假装记得用户没说过的事'],
  likes: [],
  dislikes: [],
};

const DEFAULT_LIFE = {
  city: '',
  home: '',
  occupation: '',
  hobbies: [],
  tone: '松弛',
};

/**
 * 新建角色：写 character.json 并创建 assets/ 目录。
 * @param {string} dir 数据目录
 * @param {object} [input]
 */
function createCharacter(dir, input = {}) {
  const src = isPlainObject(input) ? input : {};

  let createdAtMs = Date.now();
  let id = `char-${createdAtMs}`;
  while (fs.existsSync(paths.charDir(dir, id))) {
    createdAtMs += 1;
    id = `char-${createdAtMs}`;
  }

  const personaSrc = isPlainObject(src.persona) ? src.persona : {};
  const appearanceSrc = isPlainObject(src.appearance) ? src.appearance : {};
  const lifeSrc = isPlainObject(src.life) ? src.life : {};
  const now = new Date(createdAtMs);

  const character = {
    id,
    name: asString(src.name).trim() || '她',
    createdAt: asString(src.createdAt) || localISOString(now),
    persona: {
      traits: asStringArray(personaSrc.traits, DEFAULT_PERSONA.traits),
      speechStyle: asString(personaSrc.speechStyle, DEFAULT_PERSONA.speechStyle),
      catchphrases: asStringArray(personaSrc.catchphrases, DEFAULT_PERSONA.catchphrases),
      background: asString(personaSrc.background, DEFAULT_PERSONA.background),
      relationship: asString(personaSrc.relationship, DEFAULT_PERSONA.relationship),
      boundaries: asStringArray(personaSrc.boundaries, DEFAULT_PERSONA.boundaries),
      likes: asStringArray(personaSrc.likes, DEFAULT_PERSONA.likes),
      dislikes: asStringArray(personaSrc.dislikes, DEFAULT_PERSONA.dislikes),
    },
    appearance: {
      activePack: asString(appearanceSrc.activePack) || 'default',
      scale: typeof appearanceSrc.scale === 'number' ? appearanceSrc.scale : 1.0,
      packs: Array.isArray(appearanceSrc.packs)
        ? appearanceSrc.packs
        : [{ id: 'default', name: '常服', frames: {} }],
    },
    life: {
      city: asString(lifeSrc.city, DEFAULT_LIFE.city),
      home: asString(lifeSrc.home, DEFAULT_LIFE.home),
      occupation: asString(lifeSrc.occupation, DEFAULT_LIFE.occupation),
      hobbies: asStringArray(lifeSrc.hobbies, DEFAULT_LIFE.hobbies),
      tone: asString(lifeSrc.tone, DEFAULT_LIFE.tone),
    },
  };

  writeJSON(paths.characterFile(dir, id), character);
  fs.mkdirSync(path.join(paths.charDir(dir, id), 'assets'), { recursive: true });
  return character;
}

/** 列出全部角色；单个角色文件读失败则跳过。 */
function listCharacters(dir) {
  const root = paths.charactersDir(dir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    warn(`读取角色目录失败（${err.code || err.message}），按空列表处理`);
    return [];
  }

  const characters = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const data = readJSON(paths.characterFile(dir, id), null);
    if (!isPlainObject(data)) continue;
    characters.push(typeof data.id === 'string' ? data : { ...data, id });
  }
  characters.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
  return characters;
}

/** 保存角色（按 char.id 定位目录）。 */
function saveCharacter(dir, char) {
  if (!isPlainObject(char)) throw new Error('saveCharacter 需要角色对象');
  const id = assertSafeId(char.id);
  writeJSON(paths.characterFile(dir, id), { ...char, id });
  return { ...char, id };
}

/** 删除角色目录（含记忆、时间线、会话与资源）。 */
function deleteCharacter(dir, id) {
  const safeId = assertSafeId(id);
  fs.rmSync(paths.charDir(dir, safeId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 记忆与时间线
// ---------------------------------------------------------------------------

/** 时间值统一转 ISO 字符串；非法返回 null */
function toISOStringOrNull(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 抑制登记表归一化：
 * - 把挂在卡片数组上的不可枚举 `suppressed`（memory.suppress 返回的数组）提升到顶层，
 *   防止调用方写 `{ cards: suppress(cards, text) }` 时静默丢抑制登记表；
 * - 按 `norm` 归并去重，`until` 统一转 ISO 字符串，重复时保留较大的 until。
 */
function promoteSuppressed(memory) {
  const value = { ...memory };
  const fromCards = Array.isArray(value.cards) ? value.cards.suppressed : null;
  const hasTop = Array.isArray(value.suppressed);
  const hasFromCards = Array.isArray(fromCards) && fromCards.length > 0;
  if (!hasTop && !hasFromCards) return value;

  const byNorm = new Map();
  const absorb = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (typeof entry.norm !== 'string' || entry.norm === '') return;
    const until = toISOStringOrNull(entry.until);
    if (until === null) return;
    const previous = byNorm.get(entry.norm);
    if (!previous) {
      byNorm.set(entry.norm, { norm: entry.norm, until });
      return;
    }
    if (until > previous.until) previous.until = until;
  };

  if (hasTop) value.suppressed.forEach(absorb);
  if (Array.isArray(fromCards)) fromCards.forEach(absorb);
  value.suppressed = [...byNorm.values()];
  return value;
}

function readMemory(dir, id) {
  const data = readJSON(paths.memoryFile(dir, assertSafeId(id)), null);
  if (!isPlainObject(data)) return { cards: [], lastExtractedMessageId: null };
  return { ...data, cards: Array.isArray(data.cards) ? data.cards : [] };
}

function writeMemory(dir, id, memory) {
  const safeId = assertSafeId(id);
  let value;
  if (Array.isArray(memory)) {
    // 直接传卡片数组（可能带不可枚举的 suppressed）：包装成 memory 对象，不再写成空记忆。
    // 数组本身不带游标，保留磁盘上已有的游标，避免整段重复抽取。
    const existing = readJSON(paths.memoryFile(dir, safeId), null);
    const cursor = isPlainObject(existing) && typeof existing.lastExtractedMessageId === 'string'
      ? existing.lastExtractedMessageId
      : null;
    const keptSuppressed = isPlainObject(existing) && Array.isArray(existing.suppressed)
      ? existing.suppressed
      : [];
    value = promoteSuppressed({
      cards: memory,
      lastExtractedMessageId: cursor,
      suppressed: keptSuppressed,
    });
    if (!Array.isArray(value.suppressed)) value.suppressed = [];
  } else {
    value = isPlainObject(memory) ? promoteSuppressed(memory) : EMPTY_MEMORY;
  }
  writeJSON(paths.memoryFile(dir, safeId), value);
  return value;
}

function readTimeline(dir, id) {
  const data = readJSON(paths.timelineFile(dir, assertSafeId(id)), null);
  if (!isPlainObject(data)) return { days: {} };
  return { ...data, days: isPlainObject(data.days) ? data.days : {} };
}

function writeTimeline(dir, id, timeline) {
  const safeId = assertSafeId(id);
  const value = isPlainObject(timeline) ? timeline : EMPTY_TIMELINE;
  writeJSON(paths.timelineFile(dir, safeId), value);
  return value;
}

/** 只保留最近 keepDays 天（含今天），按本地日期裁剪。 */
function pruneTimeline(timeline, keepDays = 180) {
  const src = isPlainObject(timeline) ? timeline : {};
  const days = isPlainObject(src.days) ? src.days : {};
  const keep = Number.isInteger(keepDays) && keepDays > 0 ? keepDays : 180;

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (keep - 1));
  const cutoffKey = dayKey(cutoff);

  const kept = {};
  for (const [key, value] of Object.entries(days)) {
    // YYYY-MM-DD 的字典序即时间序
    if (key >= cutoffKey) kept[key] = value;
  }
  return { ...src, days: kept };
}

// ---------------------------------------------------------------------------
// 会话（chat.jsonl）
// ---------------------------------------------------------------------------

function appendMessage(dir, id, message) {
  appendJSONL(paths.chatFile(dir, assertSafeId(id)), message);
}

function readMessages(dir, id, options = {}) {
  return readJSONL(paths.chatFile(dir, assertSafeId(id)), options);
}

function clearMessages(dir, id) {
  const file = paths.chatFile(dir, assertSafeId(id));
  fs.rmSync(file, { force: true });
  unlinkQuiet(`${file}.tmp`);
}

module.exports = {
  readJSON,
  writeJSON,
  appendJSONL,
  readJSONL,
  listCharacters,
  createCharacter,
  saveCharacter,
  deleteCharacter,
  readMemory,
  writeMemory,
  readTimeline,
  writeTimeline,
  appendMessage,
  readMessages,
  clearMessages,
  pruneTimeline,
};
