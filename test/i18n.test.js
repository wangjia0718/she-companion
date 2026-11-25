'use strict';

// i18n 引擎与字典的最小单测（不依赖 DOM）。
const { test } = require('node:test');
const assert = require('node:assert');

const engine = require('../src/shared/i18n');
const mainDict = require('../src/main/i18n-en');

test('t：中文模式原样返回，英文模式按字典与占位符翻译', () => {
  engine.setDictionary({
    保存: 'Save',
    '有 {0} 处需要修改': '{0} fields need attention',
    '已保存 · 尾号 {0}': 'Saved · ends in {0}',
  });

  engine.setLanguage('zh');
  assert.equal(engine.t('保存'), '保存');
  assert.equal(engine.t('有 2 处需要修改'), '有 2 处需要修改');

  engine.setLanguage('en');
  assert.equal(engine.t('保存'), 'Save');
  assert.equal(engine.t('有 2 处需要修改'), '2 fields need attention');
  assert.equal(engine.t('已保存 · 尾号 4321'), 'Saved · ends in 4321');
  assert.equal(engine.t('没收录的文案'), '没收录的文案');
  assert.equal(engine.t('保存', '多余参数'), 'Save');

  engine.setLanguage('zh');
});

test('translateString：只有英文模式才返回译文', () => {
  engine.setDictionary({ 退出: 'Quit' });
  engine.setLanguage('zh');
  assert.equal(engine.translateString('退出'), null);
  engine.setLanguage('en');
  assert.equal(engine.translateString('退出'), 'Quit');
  engine.setLanguage('zh');
});

test('主进程字典：键值都是非空字符串，且关键文案已收录', () => {
  for (const [key, value] of Object.entries(mainDict)) {
    assert.equal(typeof key, 'string');
    assert.ok(key.length > 0);
    assert.equal(typeof value, 'string', `${key} 的译文应为字符串`);
    assert.ok(value.length > 0, `${key} 的译文不能为空`);
  }
  for (const key of ['她', '退出', '有点累', '，挺专注的', '精神很好']) {
    assert.ok(Object.prototype.hasOwnProperty.call(mainDict, key), `主进程字典缺少「${key}」`);
  }
});

test('英文模式：状态描述的拼接结果里没有中文', () => {
  const stateEngine = require('../src/main/state');
  engine.setDictionary(mainDict);
  engine.setLanguage('en');
  const text = stateEngine.describeState({ energy: 80, mood: 80, focus: 80 });
  assert.equal(/[\u4e00-\u9fff]/.test(text), false, `不应残留中文：${text}`);
  assert.match(text, /energy/i);
  engine.setLanguage('zh');
});
