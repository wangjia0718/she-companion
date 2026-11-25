'use strict';

// usage.js 测试：覆盖计划 Task 6 的 4 个必要点，外加：
// - 23:59 → 00:00 跨天（用传入的 now 构造，不等真实时间）
// - 时区正确性：带 +08:00 的本地深夜必须算当天（不能用 toISOString）
// - 跨月边界（1 月 31 日 → 2 月 1 日）
// - record 传入负数 / NaN token 不产生负值
// - usage.json 损坏 / 缺字段 / 非对象时按零值处理，不抛异常
// - pruneDays 不改入参、可指定 keep

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const usage = require('../src/main/usage');

const tmpDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-usage-'));
  tmpDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = new Date(2026, 9, 26, 21, 0, 0);

function zeroDay() {
  return { chat: 0, background: 0, embedding: 0, promptTokens: 0, completionTokens: 0 };
}

function usageFile(dir) {
  return path.join(dir, 'usage.json');
}

function readUsageFile(dir) {
  return JSON.parse(fs.readFileSync(usageFile(dir), 'utf8'));
}

/** 以 base 为今天，往前 offsetDays 天的本地日期 key */
function localDayKey(offsetDays, base = NOW) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('record 累加次数与 token，并按 usage.json 结构落盘', () => {
  const dir = tmp();

  usage.record(dir, 'chat', { promptTokens: 120, completionTokens: 30 }, NOW);
  const day = usage.record(dir, 'chat', { promptTokens: 80, completionTokens: 20 }, NOW);
  usage.record(dir, 'background', { promptTokens: 1000, completionTokens: 200 }, NOW);
  usage.record(dir, 'embedding', { promptTokens: 40, completionTokens: 0 }, NOW);

  assert.deepEqual(day, {
    chat: 2,
    background: 0,
    embedding: 0,
    promptTokens: 200,
    completionTokens: 50,
  });

  assert.deepEqual(readUsageFile(dir), {
    days: {
      '2026-10-26': {
        chat: 2,
        background: 1,
        embedding: 1,
        promptTokens: 1240,
        completionTokens: 250,
      },
    },
  });
});

test('today 缺省返回零值，缺字段按 0 补全', () => {
  const dir = tmp();
  assert.deepEqual(usage.today(dir, NOW), zeroDay());

  fs.writeFileSync(usageFile(dir), JSON.stringify({ days: { '2026-10-26': { chat: 3 } } }), 'utf8');
  assert.deepEqual(usage.today(dir, NOW), {
    chat: 3,
    background: 0,
    embedding: 0,
    promptTokens: 0,
    completionTokens: 0,
  });
});

test('23:59 记录后，00:00 查询返回零值（跨天重置）', () => {
  const dir = tmp();
  const beforeMidnight = new Date(2026, 9, 26, 23, 59, 0);
  const afterMidnight = new Date(2026, 9, 27, 0, 0, 0);

  usage.record(dir, 'background', { promptTokens: 500, completionTokens: 60 }, beforeMidnight);

  assert.equal(usage.today(dir, beforeMidnight).background, 1);
  assert.equal(usage.today(dir, beforeMidnight).promptTokens, 500);
  assert.deepEqual(usage.today(dir, afterMidnight), zeroDay());
  assert.equal(usage.canRunBackground({ life: { maxBackgroundCallsPerDay: 1 } }, usage.today(dir, afterMidnight)), true);
});

test('跨月边界：1 月 31 日 23:59 与 2 月 1 日 00:00 分属两天', () => {
  const dir = tmp();
  const janEnd = new Date(2026, 0, 31, 23, 59, 0);
  const febStart = new Date(2026, 1, 1, 0, 0, 0);

  usage.record(dir, 'background', {}, janEnd);

  assert.equal(usage.dayKey(janEnd), '2026-01-31');
  assert.equal(usage.dayKey(febStart), '2026-02-01');
  assert.equal(usage.today(dir, janEnd).background, 1);
  assert.equal(usage.today(dir, febStart).background, 0);
  assert.deepEqual(Object.keys(readUsageFile(dir).days), ['2026-01-31']);
});

test('时区正确性：dayKey 按本地时区切分，不用 UTC', () => {
  const lateNight = new Date('2026-10-26T23:30:00+08:00');
  const earlyMorning = new Date('2026-10-26T07:30:00+08:00');
  const localKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // 断言跟随时区：在 UTC+8 之外跑也应成立
  assert.equal(usage.dayKey(lateNight), localKey(lateNight));
  assert.equal(usage.dayKey(earlyMorning), localKey(earlyMorning));

  // 与真实时区无关的硬断言：本地 23:30 必须算当天
  assert.equal(usage.dayKey(new Date(2026, 9, 26, 23, 30)), '2026-10-26');
  // 本地 00:10 必须算新一天
  assert.equal(usage.dayKey(new Date(2026, 9, 27, 0, 10)), '2026-10-27');
});

test('canRunBackground：未达上限为 true，达到上限为 false', () => {
  const settings = { life: { maxBackgroundCallsPerDay: 2 } };
  const day = (background) => ({ ...zeroDay(), background });

  assert.equal(usage.canRunBackground(settings, day(0)), true);
  assert.equal(usage.canRunBackground(settings, day(1)), true);
  assert.equal(usage.canRunBackground(settings, day(2)), false);
  assert.equal(usage.canRunBackground(settings, day(3)), false);

  // 缺省/非法 dayUsage 按 0 处理，不抛
  assert.equal(usage.canRunBackground(settings, undefined), true);
  assert.equal(usage.canRunBackground({ life: { maxBackgroundCallsPerDay: 0 } }, day(0)), false);
  assert.equal(usage.canRunBackground({}, day(0)), true, '缺设置时按默认 24 次');
});

test('remainingBackground 给出剩余次数，不为负', () => {
  const settings = { life: { maxBackgroundCallsPerDay: 24 } };
  assert.equal(usage.remainingBackground(settings, { ...zeroDay(), background: 5 }), 19);
  assert.equal(usage.remainingBackground(settings, { ...zeroDay(), background: 24 }), 0);
  assert.equal(usage.remainingBackground(settings, { ...zeroDay(), background: 30 }), 0);
});

test('pruneDays 只保留最近 60 天（含今天），且不改入参', () => {
  const dir = tmp();
  const days = {};
  for (let offset = 0; offset < 70; offset += 1) {
    days[localDayKey(offset)] = { ...zeroDay(), chat: offset };
  }
  const input = { days, extra: '保持' };
  const snapshot = JSON.parse(JSON.stringify(input));

  const pruned = usage.pruneDays(input, 60, NOW);
  const keys = Object.keys(pruned.days).sort();

  assert.equal(keys.length, 60);
  assert.equal(keys[0], localDayKey(59), '应保留第 60 天（含今天）');
  assert.equal(keys[keys.length - 1], localDayKey(0));
  assert.equal(pruned.days[localDayKey(60)], undefined);
  assert.equal(pruned.extra, '保持', '顶层其他字段原样带回');
  assert.deepEqual(input, snapshot, '不得修改入参');

  // 默认 keep = 60
  assert.equal(Object.keys(usage.pruneDays(input, undefined, NOW).days).length, 60);
  assert.deepEqual(usage.pruneDays({}, 60, NOW), { days: {} });
  assert.deepEqual(usage.pruneDays(null, 60, NOW), { days: {} });
});

test('record 传入负数 / NaN / 非数字 token 不产生负值', () => {
  const dir = tmp();
  usage.record(dir, 'chat', { promptTokens: -100, completionTokens: -1 }, NOW);
  usage.record(dir, 'chat', { promptTokens: NaN, completionTokens: NaN }, NOW);
  usage.record(dir, 'chat', { promptTokens: Infinity, completionTokens: '12' }, NOW);
  const day = usage.record(dir, 'chat', { promptTokens: 10, completionTokens: 3 }, NOW);

  assert.deepEqual(day, {
    chat: 4,
    background: 0,
    embedding: 0,
    promptTokens: 10,
    completionTokens: 3,
  });
  assert.deepEqual(readUsageFile(dir).days['2026-10-26'], day);
});

test('磁盘上已有负数 token 时 record 不放大负值', () => {
  const dir = tmp();
  fs.writeFileSync(
    usageFile(dir),
    JSON.stringify({ days: { '2026-10-26': { chat: 1, promptTokens: -50, completionTokens: -5 } } }),
    'utf8',
  );

  const day = usage.record(dir, 'chat', { promptTokens: 5, completionTokens: 2 }, NOW);
  assert.equal(day.promptTokens, 5);
  assert.equal(day.completionTokens, 2);
});

test('usage.json 损坏时 today 返回零值、不抛，且坏文件留证', () => {
  const dir = tmp();
  fs.writeFileSync(usageFile(dir), '{ 这不是 JSON', 'utf8');

  assert.deepEqual(usage.today(dir, NOW), zeroDay());

  const files = fs.readdirSync(dir);
  assert.ok(files.some((name) => name.startsWith('usage.json.corrupt-')), '损坏文件应改名留证');
  assert.equal(usage.canRunBackground({ life: { maxBackgroundCallsPerDay: 24 } }, usage.today(dir, NOW)), true);

  // 坏文件之后仍能正常记账
  const day = usage.record(dir, 'background', { promptTokens: 7, completionTokens: 1 }, NOW);
  assert.equal(day.background, 1);
  assert.equal(day.promptTokens, 7);
});

test('usage.json 顶层或 days 不是对象时按空结构处理', () => {
  const dir = tmp();
  fs.writeFileSync(usageFile(dir), JSON.stringify(['不是对象']), 'utf8');
  assert.deepEqual(usage.today(dir, NOW), zeroDay());

  fs.writeFileSync(usageFile(dir), JSON.stringify({ days: '不是对象' }), 'utf8');
  assert.deepEqual(usage.today(dir, NOW), zeroDay());

  const day = usage.record(dir, 'chat', { promptTokens: 1, completionTokens: 2 }, NOW);
  assert.equal(day.chat, 1);
  assert.equal(day.promptTokens, 1);
});

test('未知的 purpose 直接报错，不写入任何计数', () => {
  const dir = tmp();
  assert.throws(() => usage.record(dir, 'other', {}, NOW), /未知的用量类型/);
  assert.deepEqual(usage.today(dir, NOW), zeroDay());
});
