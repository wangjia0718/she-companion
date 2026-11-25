'use strict';

// 形象资源：PNG 校验（签名 + IHDR + 透明度）与帧位导入（Task 13 / Spec 5.2、10.3、11）。
// 只用 Node 标准库；不 require electron，node --test 可直接跑。
// 设计原则：校验不通过绝不写盘；错误信息是给用户看的中文（渲染层直接展示）。

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');

// PNG 文件头：89 50 4E 47 0D 0A 1A 0A
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const IHDR_OFFSET = 8;
const IHDR_LENGTH = 13;

// 帧位白名单（与 Spec 5.2 一致；缺的表情回落到 idle）
const FRAME_KEYS = ['idle', 'happy', 'sad', 'think', 'angry', 'sleepy'];

// 尺寸上限：超过 8192 直接拒（浏览器/显卡都吃不消）；
// 超过 2048 只提醒（能显示，但可能拖慢动画）
const MAX_SIDE = 8192;
const WARN_SIDE = 2048;

// 错误文案（测试与渲染层都按这些关键字断言/展示）
const ERROR_NEED_PNG = '需要 PNG 图片（JPG / GIF / WebP 请先导出成带透明背景的 PNG）';
const ERROR_NEED_ALPHA = '需要透明背景（带 alpha 通道的 PNG）';
const ERROR_BROKEN = 'PNG 文件不完整或已损坏';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * store.assertSafeId 的同一套规则（store 未导出该函数，这里复刻一份，避免为一个校验改存储层）。
 * 首字符不能是点（挡 ../ 之类的穿越），结尾不能是点（Windows 会静默去掉），
 * 不能是 Windows 保留设备名。
 */
function assertSafeId(id, label = '角色 id') {
  const value = String(id === undefined || id === null ? '' : id);
  if (
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value)
    || value.endsWith('.')
    || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(value)
  ) {
    throw new Error(`非法${label}：${JSON.stringify(id)}`);
  }
  return value;
}

/** 统一成 Buffer：接受 Buffer / Uint8Array / ArrayBuffer；其他返回 null */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return null;
}

function hasPngSignature(bytes) {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/**
 * 调色板 PNG（colorType 3）只有带 tRNS 才算有透明。
 * 按块遍历到 IDAT 为止（规范里 tRNS 必须在 IDAT 之前）；截断时保守返回 false。
 */
function hasPaletteTransparency(bytes) {
  let offset = IHDR_OFFSET + 12 + IHDR_LENGTH; // 跳过签名 + IHDR 块（长度/类型/数据/CRC）
  if (offset >= bytes.length) return false;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    const next = offset + 12 + length;
    // length 是外部数据：越界或 0 步进都当损坏，停止扫描
    if (next <= offset || next > bytes.length) return false;
    offset = next;
  }
  return false;
}

function failure(error, extra = {}) {
  return {
    ok: false,
    width: Number.isFinite(extra.width) ? extra.width : 0,
    height: Number.isFinite(extra.height) ? extra.height : 0,
    hasAlpha: false,
    warnings: [],
    error,
  };
}

/**
 * 校验一张图片能不能当立绘。
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer 图片字节
 * @returns {{ ok: boolean, width: number, height: number, hasAlpha: boolean,
 *             warnings: string[], error: string|null }}
 */
function inspectPng(buffer) {
  const bytes = toBuffer(buffer);
  if (!bytes) return failure(ERROR_NEED_PNG);

  if (!hasPngSignature(bytes)) {
    // 单独认一下 JPEG，给更具体的原因（GIF/WebP 之类的统一按「需要 PNG」）
    if (bytes.length >= JPEG_SIGNATURE.length && bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) {
      return failure(`这是 JPEG 图片，${ERROR_NEED_PNG}`);
    }
    return failure(ERROR_NEED_PNG);
  }

  // 签名之后至少要有完整的 IHDR 块：长度(4) + 类型(4) + 数据(13) + CRC(4)
  if (bytes.length < IHDR_OFFSET + 12 + IHDR_LENGTH) return failure(ERROR_BROKEN);

  const chunkLength = bytes.readUInt32BE(IHDR_OFFSET);
  const chunkType = bytes.toString('latin1', IHDR_OFFSET + 4, IHDR_OFFSET + 8);
  if (chunkLength !== IHDR_LENGTH || chunkType !== 'IHDR') return failure(ERROR_BROKEN);

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return failure(`图片尺寸不合法：${width}×${height}（宽高需要大于 0）`);
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    return failure(`图片尺寸太大：${width}×${height}（最长边不能超过 ${MAX_SIDE} 像素）`, { width, height });
  }

  // colorType：0 灰度、2 真彩、3 调色板、4 灰度+alpha、6 RGBA
  let hasAlpha;
  if (colorType === 6 || colorType === 4) {
    hasAlpha = true;
  } else if (colorType === 3) {
    hasAlpha = hasPaletteTransparency(bytes);
  } else if (colorType === 0 || colorType === 2) {
    hasAlpha = false;
  } else {
    return failure(`${ERROR_BROKEN}（未知的颜色类型 ${colorType}）`, { width, height });
  }

  if (!hasAlpha) {
    return failure(`${ERROR_NEED_ALPHA}。这张没有透明背景，放到桌面上会带一块白底。`, { width, height });
  }

  const warnings = [];
  if (width > WARN_SIDE || height > WARN_SIDE) {
    warnings.push(`图片较大（${width}×${height}），可能影响性能`);
  }

  return { ok: true, width, height, hasAlpha: true, warnings, error: null };
}

/** 目标必须落在角色目录里（ID 已用白名单挡过，这里再兜一层，防拼接出错） */
function assertInside(base, target) {
  const root = path.resolve(base);
  const abs = path.resolve(target);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('目标路径越界，已拒绝');
  }
  return abs;
}

function readSourceBytes(sourceBuffer, sourcePath) {
  const bytes = toBuffer(sourceBuffer);
  if (bytes) return bytes;
  const file = typeof sourcePath === 'string' ? sourcePath.trim() : '';
  if (!file) throw new Error('没有拿到图片内容');
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('找不到这张图片');
    throw new Error(`读取图片失败：${error && error.message ? error.message : error}`);
  }
}

/**
 * 导入一张立绘到 characters/<id>/assets/pack-<packId>/<frameKey>.png。
 * - 先校验再写盘：校验失败抛错，磁盘上不会出现任何新文件；
 * - 覆盖同名文件前把它复制成 <file>.bak（只保留最近一次被覆盖的版本）；
 * - packId / characterId 用 store 的 assertSafeId 规则，frameKey 走白名单，禁止路径穿越。
 *
 * @param {{ dir: string, characterId: string, packId?: string, frameKey?: string,
 *           sourceBuffer?: Buffer|Uint8Array|ArrayBuffer, sourcePath?: string }} input
 * @returns {{ relPath: string, width: number, height: number }}
 */
function importFrame(input) {
  const src = isPlainObject(input) ? input : {};
  const dir = typeof src.dir === 'string' && src.dir !== '' ? src.dir : '';
  if (!dir) throw new Error('importFrame 需要数据目录 dir');

  const characterId = assertSafeId(src.characterId, '角色 id');
  const packId = assertSafeId(
    typeof src.packId === 'string' && src.packId !== '' ? src.packId : 'default',
    '形象包 id',
  );
  const frameKey = typeof src.frameKey === 'string' && src.frameKey !== '' ? src.frameKey : 'idle';
  if (!FRAME_KEYS.includes(frameKey)) {
    throw new Error(`未知的帧位：${frameKey}（只能是 ${FRAME_KEYS.join('/')}）`);
  }

  const charDir = paths.charDir(dir, characterId);
  let isDir = false;
  try {
    isDir = fs.statSync(charDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error('找不到这个角色');

  const bytes = readSourceBytes(src.sourceBuffer, src.sourcePath);
  const info = inspectPng(bytes);
  if (!info.ok) throw new Error(info.error);

  const relPath = path.posix.join('assets', `pack-${packId}`, `${frameKey}.png`);
  const target = assertInside(charDir, path.join(charDir, relPath));

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    // 覆盖前留一份上一次的图（用户误传后还能从 .bak 找回来）
    fs.copyFileSync(target, `${target}.bak`);
  }
  fs.writeFileSync(target, bytes);

  return { relPath, width: info.width, height: info.height };
}

module.exports = {
  FRAME_KEYS,
  MAX_SIDE,
  WARN_SIDE,
  inspectPng,
  importFrame,
};
