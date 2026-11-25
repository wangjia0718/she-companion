'use strict';

// 静态内容集中在 src/main/content/*.json，这里做最小结构校验，防止改文案时把结构改坏。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const content = require('../src/main/content');

test('content：事件模板是非空字符串数组', () => {
  assert.ok(Array.isArray(content.eventTemplates));
  assert.ok(content.eventTemplates.length >= 20);
  for (const item of content.eventTemplates) {
    assert.equal(typeof item, 'string');
    assert.ok(item.trim().length > 0);
  }
});

test('content：活动细节与类别细节都有内容', () => {
  for (const key of ['phone', 'chat', 'piano', 'cooking', 'cat']) {
    assert.ok(Array.isArray(content.activityDetails[key]), `missing activityDetails.${key}`);
    assert.ok(content.activityDetails[key].length > 0);
  }
  for (const key of ['home', 'chore', 'selfcare', 'solo_out', 'discovery']) {
    assert.ok(Array.isArray(content.categoryDetails[key]), `missing categoryDetails.${key}`);
    assert.ok(content.categoryDetails[key].length > 0);
  }
});

test('content：主动消息兜底与兜底池结构完整', () => {
  for (const key of ['boot', 'event', 'idle', 'birthday', 'holiday', 'project', 'weather', 'followup', 'bedtime']) {
    assert.ok(Array.isArray(content.proactiveFallbacks[key]), `missing proactiveFallbacks.${key}`);
    assert.ok(content.proactiveFallbacks[key].length > 0);
  }
  assert.ok(content.fallbackEntries.length >= 20);
  for (const item of content.fallbackEntries) {
    assert.equal(typeof item.category, 'string');
    assert.equal(typeof item.text, 'string');
    assert.ok(item.text.trim().length > 0);
  }
  assert.ok(content.homeDiscoveries.length >= 10);
  assert.ok(content.defaultSchedule.en.length === 5);
  assert.equal(typeof content.defaultSchedule.zh.morning, 'string');
});

test('content：data/content 覆盖文件优先于内置 JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-content-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'event-templates.json'),
      JSON.stringify(['自定义事件一', '自定义事件二']),
      'utf8',
    );
    process.env.SHE_CONTENT_DIR = dir;
    const modulePath = require.resolve('../src/main/content');
    delete require.cache[modulePath];
    const overridden = require('../src/main/content');
    assert.deepEqual(overridden.eventTemplates, ['自定义事件一', '自定义事件二']);
    assert.equal(overridden.activityDetails.phone.length > 0, true, '未覆盖的文件应回退到内置版本');
  } finally {
    delete process.env.SHE_CONTENT_DIR;
    delete require.cache[require.resolve('../src/main/content')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
