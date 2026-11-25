const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../src/main/store');

const tmpDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-store-'));
  tmpDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function localDayKey(offsetDays) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readdir(root) {
  return fs.readdirSync(root).sort();
}

test('writeJSON → readJSON 写入后读回一致，且不残留 .tmp', () => {
  const root = tmp();
  const file = path.join(root, 'nested', 'x.json');
  const value = { a: 1, nested: { list: [1, '二', true], empty: null }, text: '她' };

  store.writeJSON(file, value);

  assert.deepEqual(store.readJSON(file, { fallback: true }), value);
  assert.deepEqual(readdir(root), ['nested']);
  assert.deepEqual(readdir(path.join(root, 'nested')), ['x.json']);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(fs.existsSync(`${file}.bak`), false, '首次写入不应生成 .bak');
});

test('连续写两次后 .bak 是上一次的内容', () => {
  const root = tmp();
  const file = path.join(root, 'x.json');

  store.writeJSON(file, { version: 1 });
  store.writeJSON(file, { version: 2 });
  store.writeJSON(file, { version: 3 });

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { version: 2 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('主文件损坏时从 .bak 恢复，并把内容写回主文件', () => {
  const root = tmp();
  const file = path.join(root, 'x.json');
  store.writeJSON(file, { a: 1 });
  store.writeJSON(file, { a: 2 }); // .bak = {a:1}
  fs.writeFileSync(file, '{ broken', 'utf8');

  assert.deepEqual(store.readJSON(file, { a: 0 }), { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 }, '恢复后主文件应是备份内容');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { a: 1 }, '恢复过程不应破坏 .bak');
  assert.equal(
    readdir(root).some((name) => name.includes('.corrupt-')),
    false,
    '能从 .bak 恢复时不应留下 corrupt 文件',
  );
});

test('主文件缺失但 .bak 存在时也能恢复', () => {
  const root = tmp();
  const file = path.join(root, 'x.json');
  store.writeJSON(file, { a: 1 });
  store.writeJSON(file, { a: 2 });
  fs.rmSync(file);

  assert.deepEqual(store.readJSON(file, { a: 0 }), { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
});

test('主文件与 .bak 都坏时生成 *.corrupt-* 并返回 fallback，不抛异常', () => {
  const root = tmp();
  const file = path.join(root, 'x.json');
  store.writeJSON(file, { a: 1 });
  store.writeJSON(file, { a: 2 });
  fs.writeFileSync(file, '{ broken', 'utf8');
  fs.writeFileSync(`${file}.bak`, 'also broken', 'utf8');

  let result;
  assert.doesNotThrow(() => {
    result = store.readJSON(file, { a: -1 });
  });
  assert.deepEqual(result, { a: -1 });

  const names = readdir(root);
  assert.ok(names.some((name) => name.startsWith('x.json.corrupt-')), `应保留主文件证据，实际：${names}`);
  assert.ok(names.some((name) => name.startsWith('x.json.bak.corrupt-')), `应保留备份证据，实际：${names}`);
  assert.equal(fs.existsSync(file), false);
});

test('文件缺失时返回 fallback 且不创建文件', () => {
  const root = tmp();
  const file = path.join(root, 'missing', 'x.json');

  assert.deepEqual(store.readJSON(file, { def: true }), { def: true });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
});

test('带 UTF-8 BOM 的合法 JSON 正常读取，不生成 corrupt/tmp', () => {
  const root = tmp();
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ ui: { petScale: 1.7 } }, null, 2)}\n`, 'utf8');

  assert.deepEqual(store.readJSON(file, { ui: { petScale: 1 } }), { ui: { petScale: 1.7 } });
  assert.deepEqual(readdir(root), ['settings.json'], '不应生成 .bak / .corrupt-* / .tmp');
});

test('appendJSONL 在文件末尾缺换行时补换行，两条不会粘连', () => {
  const root = tmp();
  const file = path.join(root, 'chat.jsonl');
  fs.writeFileSync(file, '{"i":1}', 'utf8');

  store.appendJSONL(file, { i: 2 });

  assert.deepEqual(store.readJSONL(file), [{ i: 1 }, { i: 2 }]);
  assert.equal(readdir(root).some((name) => name.endsWith('.tmp')), false);
});

test('readJSONL 读取带 BOM 与 CRLF 的文件', () => {
  const root = tmp();
  const file = path.join(root, 'chat.jsonl');
  fs.writeFileSync(file, '\uFEFF{"i":1}\r\n{"i":2}\r\n', 'utf8');

  assert.deepEqual(store.readJSONL(file), [{ i: 1 }, { i: 2 }]);
});

test('appendJSONL 追加并可 limit 只取最后 N 条', () => {
  const root = tmp();
  const file = path.join(root, 'log', 'chat.jsonl');

  for (const i of [1, 2, 3, 4, 5]) store.appendJSONL(file, { i });

  assert.deepEqual(store.readJSONL(file).map((m) => m.i), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.readJSONL(file, { limit: 2 }).map((m) => m.i), [4, 5]);
  assert.deepEqual(store.readJSONL(file, { limit: 5 }).map((m) => m.i), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.readJSONL(file, { limit: 0 }), []);
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), true);
  assert.equal(readdir(path.join(root, 'log')).some((name) => name.endsWith('.tmp')), false);
});

test('readJSONL 遇到坏行跳过而不是整体失败', () => {
  const root = tmp();
  const file = path.join(root, 'chat.jsonl');
  fs.writeFileSync(
    file,
    ['{"i":1}', 'not json', '', '{"i":2}', '{"i":3'].join('\n'),
    'utf8',
  );

  assert.deepEqual(store.readJSONL(file), [{ i: 1 }, { i: 2 }]);
  assert.deepEqual(store.readJSONL(file, { limit: 1 }), [{ i: 2 }]);
  assert.deepEqual(store.readJSONL(path.join(root, 'none.jsonl')), []);
  assert.equal(readdir(root).some((name) => name.endsWith('.tmp')), false);
});

test('createCharacter 建出 assets/ 目录，id 形如 char-<ms>，可被 listCharacters 读到', () => {
  const root = tmp();
  const char = store.createCharacter(root, { name: '小满' });

  assert.match(char.id, /^char-\d+$/);
  assert.equal(char.name, '小满');
  assert.equal(fs.statSync(path.join(root, 'characters', char.id, 'assets')).isDirectory(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'characters', char.id, 'character.json'), 'utf8')), char);

  const list = store.listCharacters(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, char.id);
  assert.equal(list[0].persona.traits.length > 0, true);
});

test('listCharacters 跳过损坏的单个角色文件', () => {
  const root = tmp();
  const good = store.createCharacter(root, { name: '好的' });
  const bad = store.createCharacter(root, { name: '坏的' });
  fs.writeFileSync(path.join(root, 'characters', bad.id, 'character.json'), '{ broken', 'utf8');

  const list = store.listCharacters(root);
  assert.deepEqual(list.map((c) => c.id), [good.id]);
  const names = readdir(path.join(root, 'characters', bad.id));
  assert.ok(names.some((name) => name.includes('.corrupt-')), `坏角色文件应留证，实际：${names}`);
});

test('saveCharacter 写入后读回（含修改字段）', () => {
  const root = tmp();
  const char = store.createCharacter(root, { name: '她' });
  const saved = store.saveCharacter(root, { ...char, name: '阿眠', persona: { ...char.persona, likes: ['旧书店'] } });

  assert.equal(saved.name, '阿眠');
  const reloaded = store.listCharacters(root).find((c) => c.id === char.id);
  assert.equal(reloaded.name, '阿眠');
  assert.deepEqual(reloaded.persona.likes, ['旧书店']);
});

test('deleteCharacter 后角色目录不存在；非法 id 被拒绝', () => {
  const root = tmp();
  const char = store.createCharacter(root, { name: '她' });
  const dir = path.join(root, 'characters', char.id);
  assert.equal(fs.existsSync(dir), true);

  store.deleteCharacter(root, char.id);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(store.listCharacters(root), []);
  assert.doesNotThrow(() => store.deleteCharacter(root, char.id));

  assert.throws(() => store.deleteCharacter(root, '../escape'));
  assert.throws(() => store.deleteCharacter(root, ''));
});

test('非法角色 id 被拒绝：目录穿越写法与 Windows 保留名', () => {
  const root = tmp();
  const char = store.createCharacter(root, { name: '她' });
  const sentinel = path.join(root, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep', 'utf8');

  const badIds = ['...', '....', 'a..', 'CON', 'nul', 'aux.txt'];
  for (const bad of badIds) {
    assert.throws(() => store.deleteCharacter(root, bad), /非法角色 id/, `deleteCharacter 应拒绝 ${bad}`);
    assert.throws(() => store.readMemory(root, bad), /非法角色 id/, `readMemory 应拒绝 ${bad}`);
    assert.throws(
      () => store.saveCharacter(root, { ...char, id: bad }),
      /非法角色 id/,
      `saveCharacter 应拒绝 ${bad}`,
    );
  }

  assert.equal(fs.existsSync(sentinel), true, 'characters/ 之外的哨兵文件必须还在');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.deepEqual(store.listCharacters(root).map((c) => c.id), [char.id]);
});

test('readMemory / writeMemory 往返，缺失时返回空结构', () => {
  const root = tmp();
  const char = store.createCharacter(root, { name: '她' });

  assert.deepEqual(store.readMemory(root, char.id), { cards: [], lastExtractedMessageId: null });

  const memory = {
    cards: [{ id: 'm-1', kind: 'event', text: '下周三交方案', importance: 4 }],
    lastExtractedMessageId: 'msg-1',
  };
  store.writeMemory(root, char.id, memory);
  assert.deepEqual(store.readMemory(root, char.id), memory);
});

test('readTimeline / writeTimeline 往返，缺失时返回空 days', () => {
  const root = tmp();
  const char = store.createCharacter(root, { name: '她' });

  assert.deepEqual(store.readTimeline(root, char.id), { days: {} });

  const timeline = {
    days: {
      '2026-10-26': {
        schedule: [{ time: '08:30', activity: '做早饭' }],
        events: [],
        diary: '今天起得早……',
      },
    },
  };
  store.writeTimeline(root, char.id, timeline);
  assert.deepEqual(store.readTimeline(root, char.id), timeline);
});

test('appendMessage / readMessages / clearMessages', () => {
  const root = tmp();
  const char = store.createCharacter(root, { name: '她' });

  store.appendMessage(root, char.id, { id: 'msg-1', role: 'user', text: '在吗' });
  store.appendMessage(root, char.id, { id: 'msg-2', role: 'assistant', text: '嗯…刚回来' });

  assert.deepEqual(store.readMessages(root, char.id).map((m) => m.id), ['msg-1', 'msg-2']);
  assert.deepEqual(store.readMessages(root, char.id, { limit: 1 }).map((m) => m.id), ['msg-2']);

  store.clearMessages(root, char.id);
  assert.deepEqual(store.readMessages(root, char.id), []);
  assert.equal(fs.existsSync(path.join(root, 'characters', char.id, 'chat.jsonl')), false);
});

test('pruneTimeline 在 200 天数据下只留最近 180 天，保留今天', () => {
  const days = {};
  for (let offset = 0; offset < 200; offset += 1) {
    const key = localDayKey(offset);
    days[key] = { schedule: [], events: [], marker: offset };
  }
  const timeline = { days, extra: 'keep-me' };

  const pruned = store.pruneTimeline(timeline, 180);
  const keys = Object.keys(pruned.days);

  assert.equal(keys.length, 180);
  assert.equal(keys.includes(localDayKey(0)), true, '今天必须保留');
  assert.equal(keys.includes(localDayKey(179)), true);
  assert.equal(keys.includes(localDayKey(180)), false, '第 181 天应被裁掉');
  assert.equal(keys.includes(localDayKey(199)), false);
  assert.equal(pruned.days[localDayKey(0)].marker, 0);
  assert.equal(pruned.extra, 'keep-me');
  assert.equal(Object.keys(timeline.days).length, 200, '不应修改入参');
});

test('pruneTimeline 默认 180 天，并容忍空/非法入参', () => {
  const timeline = { days: { [localDayKey(0)]: { events: [] }, [localDayKey(181)]: { events: [] } } };

  assert.deepEqual(Object.keys(store.pruneTimeline(timeline).days), [localDayKey(0)]);
  assert.deepEqual(store.pruneTimeline(undefined), { days: {} });
  assert.deepEqual(store.pruneTimeline({ days: null }), { days: {} });
});
