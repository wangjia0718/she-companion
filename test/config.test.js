const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
const { loadSettings, saveSettings, publicSettings, validateSettings, DEFAULT_SETTINGS } = require('../src/main/config');

const tmpDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-cfg-'));
  tmpDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('无文件时返回默认值', () => {
  const s = loadSettings(tmp());
  assert.equal(s.ui.theme, 'warm');
  assert.equal(s.ui.language, 'zh');
  assert.equal(s.life.proactiveWeekMin, 0);
  assert.equal(s.life.proactiveWeekMax, 10);
  assert.equal(s.life.maxBackgroundCallsPerDay, 24);
  assert.equal(s.life.quietFrom, '23:30');
  assert.equal(s.life.diaryHour, 21);
  assert.equal(s.life.dailyDiscovery, true);
});

test('ui.language：旧配置缺省按中文，非法值回落并告警', () => {
  const legacy = validateSettings({ ui: { theme: 'warm' } });
  assert.equal(legacy.settings.ui.language, 'zh');

  const english = validateSettings({ ui: { language: 'en' } });
  assert.equal(english.settings.ui.language, 'en');

  const invalid = validateSettings({ ui: { language: 'fr' } });
  assert.equal(invalid.settings.ui.language, 'zh');
  assert.ok(invalid.warnings.some((w) => w.includes('ui.language')), invalid.warnings.join('\n'));
});

test('非法值回落默认并给出警告', () => {
  const { settings, warnings } = validateSettings({ life: { proactiveWeekMin: -1, proactiveWeekMax: 1001, quietFrom: '25:00', diaryHour: 24 }, ui: { theme: 'neon' }, memory: { recallTopK: 0 } });
  assert.equal(settings.life.proactiveWeekMin, 0);
  assert.equal(settings.life.proactiveWeekMax, 63);
  assert.equal(settings.life.quietFrom, '23:30');
  assert.equal(settings.life.diaryHour, 21);
  assert.equal(settings.ui.theme, 'warm');
  assert.equal(settings.memory.recallTopK, 12);
  const joined = warnings.join('\n');
  for (const field of ['life.proactiveWeekMin', 'life.proactiveWeekMax', 'life.quietFrom', 'life.diaryHour', 'ui.theme', 'memory.recallTopK']) {
    assert.ok(joined.includes(field), `警告里应包含 ${field}，实际警告：${joined}`);
  }
});

test('主动消息范围：上限 63，超出按 63 截断；旧单值迁成 0–旧值，最小值大于最大值时收敛', () => {
  const full = validateSettings({ life: { proactiveWeekMin: 0, proactiveWeekMax: 1000 } });
  assert.equal(full.settings.life.proactiveWeekMin, 0);
  assert.equal(full.settings.life.proactiveWeekMax, 63);
  assert.ok(full.warnings.some((w) => w.includes('最大为 63')), full.warnings.join('\n'));

  const legacy = validateSettings({ life: { proactivePerWeek: 5 } });
  assert.equal(legacy.settings.life.proactiveWeekMin, 0);
  assert.equal(legacy.settings.life.proactiveWeekMax, 5);

  const reversed = validateSettings({ life: { proactiveWeekMin: 8, proactiveWeekMax: 2 } });
  assert.equal(reversed.settings.life.proactiveWeekMin, 2);
  assert.equal(reversed.settings.life.proactiveWeekMax, 2);
  assert.ok(reversed.warnings.some((w) => w.includes('不能大于')));
});

test('分区类型错误时逐段回落并给出含分区名的警告', () => {
  const { settings, warnings } = validateSettings({ api: 'oops', ui: [1, 2], life: 5, memory: null });
  assert.equal(settings.api.chat, 'p1');
  assert.equal(settings.ui.theme, 'warm');
  assert.equal(settings.life.enabled, true);
  assert.equal(settings.memory.recallTopK, 12);
  const joined = warnings.join('\n');
  for (const name of ['api', 'ui', 'life', 'memory']) {
    assert.ok(joined.includes(name), `警告里应包含分区名 ${name}，实际警告：${joined}`);
  }
});

test('未知 version 给出警告并按 1 处理', () => {
  const { settings, warnings } = validateSettings({ version: 7 });
  assert.equal(settings.version, 1);
  assert.ok(warnings.some((w) => w.includes('version')), `警告里应包含 version，实际：${warnings.join(' / ')}`);
});

test('publicSettings 不泄露 key', () => {
  const s = { ...DEFAULT_SETTINGS, api: { profiles: [{ id: 'p1', name: 'x', baseUrl: 'https://a/v1', apiKey: 'sk-abcd1234', model: 'm', capabilities: ['chat'] }], chat: 'p1', background: 'p1', embedding: null } };
  const p = publicSettings(s);
  assert.equal(p.api.profiles[0].apiKey, undefined);
  assert.equal(p.api.profiles[0].hasKey, true);
  assert.equal(p.api.profiles[0].keyHint, '1234');
});

test('publicSettings 对短 key 不暴露原文', () => {
  const base = validateSettings({}).settings;
  const short = publicSettings({
    ...base,
    api: {
      ...base.api,
      profiles: [{ ...base.api.profiles[0], apiKey: ' sk-1234 ' }, { ...base.api.profiles[0], id: 'p2', apiKey: '' }],
    },
  });
  assert.equal(short.api.profiles[0].hasKey, true);
  assert.equal(short.api.profiles[0].keyHint, '****');
  assert.equal(short.api.profiles[1].hasKey, false);
  assert.equal(short.api.profiles[1].keyHint, '');
});

test('脱敏设置整包回传后 key 仍在（只改外观不会清空密钥）', () => {
  const dir = tmp();
  saveSettings(dir, {
    api: {
      profiles: [{ id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-abcdef1234', model: 'deepseek-chat', capabilities: ['chat'] }],
      chat: 'p1',
      background: 'p1',
      embedding: null,
    },
  });

  // 模拟渲染进程：只拿到脱敏设置，改一项外观后整包回传
  const pub = JSON.parse(JSON.stringify(publicSettings(loadSettings(dir))));
  assert.equal(pub.api.profiles[0].apiKey, undefined);
  saveSettings(dir, { ...pub, ui: { ...pub.ui, petScale: 1.3 } });

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(onDisk.ui.petScale, 1.3);
  assert.equal(onDisk.api.profiles[0].apiKey, 'sk-abcdef1234');
});

test('apiKey 传空串表示主动清除', () => {
  const dir = tmp();
  saveSettings(dir, { api: { profiles: [{ id: 'p1', name: 'x', baseUrl: 'https://a/v1', apiKey: 'sk-secret1234', model: 'm', capabilities: ['chat'] }] } });
  saveSettings(dir, { api: { profiles: [{ id: 'p1', name: 'x', baseUrl: 'https://a/v1', apiKey: '', model: 'm', capabilities: ['chat'] }] } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(onDisk.api.profiles[0].apiKey, '');
});

test('save→load 往返一致且不残留 .tmp', () => {
  const dir = tmp();
  const written = saveSettings(dir, {
    ui: { petScale: 1.5, petPos: { x: 120, y: 40 } },
    life: { quietFrom: '22:00' },
    memory: { recallTopK: 5 },
    activeCharacterId: '  char-123  ',
  });
  assert.equal(written.ui.petScale, 1.5);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json.tmp')), false);

  const reloaded = loadSettings(dir);
  assert.deepEqual(reloaded, written);
  assert.equal(reloaded.activeCharacterId, 'char-123');
});

test('rename 被阻塞时清理 .tmp 并抛出原始错误', () => {
  const dir = tmp();
  // 让目标与 .bak 都是非空目录：主 rename 与 .bak 兜底 rename 都会失败
  fs.mkdirSync(path.join(dir, 'settings.json', 'busy'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'settings.json.bak', 'busy'), { recursive: true });

  assert.throws(() => saveSettings(dir, { ui: { petScale: 1.2 } }));
  assert.equal(fs.existsSync(path.join(dir, 'settings.json.tmp')), false);
  assert.equal(fs.statSync(path.join(dir, 'settings.json')).isDirectory(), true);
});

test('整包回传时 headers 与 userAgent 不会被设置页清空', () => {
  const dir = tmp();
  const base = {
    id: 'go',
    name: 'Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'm',
    apiKey: 'sk-keep-me-12345678',
    userAgent: 'she-companion/0.1',
    headers: { 'x-opencode-session': 'abc' },
    capabilities: ['chat'],
  };
  saveSettings(dir, { api: { profiles: [base], chat: 'go', background: 'go' } });

  // 模拟设置页：只回传表单字段，不带 apiKey/headers/userAgent
  const fromUi = [{ id: 'go', name: 'Go2', baseUrl: base.baseUrl, model: 'm2', temperature: 0.7, maxTokens: 800, capabilities: ['chat'] }];
  const saved = saveSettings(dir, { api: { profiles: fromUi } });
  const p = saved.api.profiles[0];

  assert.equal(p.apiKey, 'sk-keep-me-12345678');
  assert.deepEqual(p.headers, { 'x-opencode-session': 'abc' });
  assert.equal(p.userAgent, 'she-companion/0.1');
  assert.equal(p.name, 'Go2');
  assert.equal(p.model, 'm2');
});
