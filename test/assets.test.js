'use strict';

// Task 13：形象导入（PNG 校验 + 帧位落盘）的行为测试。
// 不读外部图片：所有 PNG 字节都在这里现造（含 CRC，方便直接拿去手测）。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const assets = require('../src/main/assets');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- 造 PNG ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.alloc(0);
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])), 8 + body.length);
  return out;
}

/** @param {{ width?: number, height?: number, colorType?: number, bitDepth?: number,
 *            trns?: Buffer|null, idat?: boolean }} [options] */
function makePng(options = {}) {
  const width = Number.isInteger(options.width) ? options.width : 2;
  const height = Number.isInteger(options.height) ? options.height : 3;
  const colorType = Number.isInteger(options.colorType) ? options.colorType : 6;
  const bitDepth = Number.isInteger(options.bitDepth) ? options.bitDepth : 8;

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  const parts = [PNG_SIGNATURE, chunk('IHDR', header)];
  if (options.trns) parts.push(chunk('tRNS', options.trns));
  if (options.idat !== false) {
    // 内容不参与校验（inspectPng 不解压像素），给一段最简 zlib 头即可
    parts.push(chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-assets-'));
}

// --- inspectPng -----------------------------------------------------------

test('inspectPng：RGBA PNG 通过，尺寸与 alpha 正确', () => {
  const info = assets.inspectPng(makePng({ width: 120, height: 240, colorType: 6 }));
  assert.equal(info.ok, true);
  assert.equal(info.width, 120);
  assert.equal(info.height, 240);
  assert.equal(info.hasAlpha, true);
  assert.deepEqual(info.warnings, []);
  assert.equal(info.error, null);
});

test('inspectPng：灰度 + alpha（colorType 4）也算有透明', () => {
  const info = assets.inspectPng(makePng({ colorType: 4, bitDepth: 8 }));
  assert.equal(info.ok, true);
  assert.equal(info.hasAlpha, true);
});

test('inspectPng：colorType 2 没有 alpha → 拒绝并提示透明背景', () => {
  const info = assets.inspectPng(makePng({ colorType: 2 }));
  assert.equal(info.ok, false);
  assert.equal(info.hasAlpha, false);
  assert.match(info.error, /透明/);
});

test('inspectPng：灰阶 colorType 0 也没有 alpha → 拒绝', () => {
  const info = assets.inspectPng(makePng({ colorType: 0 }));
  assert.equal(info.ok, false);
  assert.match(info.error, /透明/);
});

test('inspectPng：JPEG 头 → 拒绝且提示需要 PNG', () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.alloc(32, 0x20),
    Buffer.from([0xff, 0xd9]),
  ]);
  const info = assets.inspectPng(jpeg);
  assert.equal(info.ok, false);
  assert.match(info.error, /PNG/);
  assert.match(info.error, /JPEG/);
});

test('inspectPng：只有签名 / 截断的 PNG → ok:false，不抛异常', () => {
  let info;
  assert.doesNotThrow(() => {
    info = assets.inspectPng(Buffer.from(PNG_SIGNATURE));
  });
  assert.equal(info.ok, false);
  assert.ok(info.error);

  const truncated = makePng().subarray(0, 20);
  assert.doesNotThrow(() => {
    info = assets.inspectPng(truncated);
  });
  assert.equal(info.ok, false);
});

test('inspectPng：调色板 PNG 有 tRNS 才算透明', () => {
  const withTrns = assets.inspectPng(makePng({ colorType: 3, bitDepth: 8, trns: Buffer.from([0x00, 0xff]) }));
  assert.equal(withTrns.ok, true);
  assert.equal(withTrns.hasAlpha, true);

  const withoutTrns = assets.inspectPng(makePng({ colorType: 3, bitDepth: 8 }));
  assert.equal(withoutTrns.ok, false);
  assert.equal(withoutTrns.hasAlpha, false);
  assert.match(withoutTrns.error, /透明/);
});

test('inspectPng：尺寸 0 或超过 8192 → 拒绝', () => {
  const zero = assets.inspectPng(makePng({ width: 0, height: 10 }));
  assert.equal(zero.ok, false);
  assert.match(zero.error, /尺寸/);

  const tooBig = assets.inspectPng(makePng({ width: 8193, height: 10 }));
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /8193/);

  const tooTall = assets.inspectPng(makePng({ width: 10, height: 8193 }));
  assert.equal(tooTall.ok, false);
});

test('inspectPng：超过 2048 只给性能提醒，仍然通过', () => {
  const info = assets.inspectPng(makePng({ width: 2049, height: 64 }));
  assert.equal(info.ok, true);
  assert.equal(info.warnings.length, 1);
  assert.match(info.warnings[0], /可能影响性能/);
});

test('inspectPng：非 Buffer/字节的输入也不抛', () => {
  for (const value of [null, undefined, 'not bytes', 42, {}]) {
    let info;
    assert.doesNotThrow(() => {
      info = assets.inspectPng(value);
    });
    assert.equal(info.ok, false);
    assert.match(info.error, /PNG/);
  }
});

// --- importFrame ----------------------------------------------------------

test('importFrame：复制到 characters/<id>/assets/pack-<packId>/<frameKey>.png 并返回相对路径', () => {
  const dir = tmpDir();
  const characterId = 'char-1001';
  fs.mkdirSync(path.join(dir, 'characters', characterId), { recursive: true });

  const bytes = makePng({ width: 32, height: 48, colorType: 6 });
  const result = assets.importFrame({
    dir,
    characterId,
    packId: 'default',
    frameKey: 'happy',
    sourceBuffer: bytes,
  });

  assert.equal(result.relPath, 'assets/pack-default/happy.png');
  assert.equal(result.width, 32);
  assert.equal(result.height, 48);

  const target = path.join(dir, 'characters', characterId, 'assets', 'pack-default', 'happy.png');
  assert.ok(fs.existsSync(target));
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test('importFrame：从 sourcePath 读文件；文件不存在时报中文错', () => {
  const dir = tmpDir();
  const characterId = 'char-1002';
  fs.mkdirSync(path.join(dir, 'characters', characterId), { recursive: true });

  const source = path.join(dir, 'incoming.png');
  fs.writeFileSync(source, makePng({ width: 5, height: 6 }));

  const result = assets.importFrame({
    dir,
    characterId,
    frameKey: 'idle',
    sourcePath: source,
  });
  assert.equal(result.relPath, 'assets/pack-default/idle.png');
  assert.ok(fs.existsSync(path.join(dir, 'characters', characterId, result.relPath)));

  assert.throws(
    () => assets.importFrame({
      dir,
      characterId,
      frameKey: 'idle',
      sourcePath: path.join(dir, 'nope.png'),
    }),
    /找不到这张图片/,
  );
});

test('importFrame：覆盖同名文件前保留 .bak（旧版本不丢）', () => {
  const dir = tmpDir();
  const characterId = 'char-1003';
  fs.mkdirSync(path.join(dir, 'characters', characterId), { recursive: true });

  const first = makePng({ width: 10, height: 10 });
  const second = makePng({ width: 20, height: 20 });
  assets.importFrame({ dir, characterId, frameKey: 'idle', sourceBuffer: first });
  const result = assets.importFrame({ dir, characterId, frameKey: 'idle', sourceBuffer: second });

  const target = path.join(dir, 'characters', characterId, 'assets', 'pack-default', 'idle.png');
  assert.equal(result.width, 20);
  assert.deepEqual(fs.readFileSync(target), second);
  assert.ok(fs.existsSync(`${target}.bak`));
  assert.deepEqual(fs.readFileSync(`${target}.bak`), first);
});

test('importFrame：frameKey 不在白名单、packId 非法 → 拒绝且不写文件', () => {
  const dir = tmpDir();
  const characterId = 'char-1004';
  const charDir = path.join(dir, 'characters', characterId);
  fs.mkdirSync(charDir, { recursive: true });
  const bytes = makePng();

  assert.throws(
    () => assets.importFrame({ dir, characterId, packId: 'default', frameKey: '../evil', sourceBuffer: bytes }),
    /未知的帧位/,
  );
  assert.throws(
    () => assets.importFrame({ dir, characterId, packId: 'default', frameKey: 'smile', sourceBuffer: bytes }),
    /未知的帧位/,
  );
  assert.throws(
    () => assets.importFrame({ dir, characterId, packId: '../escape', frameKey: 'idle', sourceBuffer: bytes }),
    /非法形象包 id/,
  );
  assert.equal(fs.existsSync(path.join(charDir, 'assets')), false);
});

test('importFrame：characterId 路径穿越 / 不存在 → 拒绝且不写文件', () => {
  const dir = tmpDir();
  const bytes = makePng();

  for (const bad of ['../escape', '..', '.hidden', 'a/b', 'CON', 'char.']) {
    assert.throws(
      () => assets.importFrame({ dir, characterId: bad, frameKey: 'idle', sourceBuffer: bytes }),
      /非法角色 id/,
    );
  }
  assert.throws(
    () => assets.importFrame({ dir, characterId: 'char-404', frameKey: 'idle', sourceBuffer: bytes }),
    /找不到这个角色/,
  );
  assert.equal(fs.existsSync(path.join(dir, 'characters')), false);
});

test('importFrame：校验失败时不写任何文件（含 .bak）', () => {
  const dir = tmpDir();
  const characterId = 'char-1005';
  const charDir = path.join(dir, 'characters', characterId);
  fs.mkdirSync(charDir, { recursive: true });

  const cases = [
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    makePng({ colorType: 2 }),
    Buffer.from(PNG_SIGNATURE),
    makePng({ width: 9000, height: 10 }),
  ];
  for (const bytes of cases) {
    assert.throws(
      () => assets.importFrame({ dir, characterId, frameKey: 'idle', sourceBuffer: bytes }),
      /PNG|透明|尺寸|不完整/,
    );
  }
  assert.equal(fs.existsSync(path.join(charDir, 'assets')), false);
});

test('importFrame：坏图覆盖已有帧时保留原文件与 .bak 不变', () => {
  const dir = tmpDir();
  const characterId = 'char-1006';
  fs.mkdirSync(path.join(dir, 'characters', characterId), { recursive: true });
  const good = makePng({ width: 8, height: 8 });
  assets.importFrame({ dir, characterId, frameKey: 'idle', sourceBuffer: good });

  const target = path.join(dir, 'characters', characterId, 'assets', 'pack-default', 'idle.png');
  assert.throws(
    () => assets.importFrame({ dir, characterId, frameKey: 'idle', sourceBuffer: makePng({ colorType: 2 }) }),
    /透明/,
  );
  assert.deepEqual(fs.readFileSync(target), good);
  assert.equal(fs.existsSync(`${target}.bak`), false);
});
