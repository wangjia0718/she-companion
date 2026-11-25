'use strict';

// TTS 纯函数单测：不起子进程、不联网（合成本身只能手动验）。
const { test } = require('node:test');
const assert = require('node:assert');

const tts = require('../src/main/tts');
const config = require('../src/main/config');

test('cleanForSpeech：去掉 Markdown、表情和短括号注释', () => {
  assert.equal(tts.cleanForSpeech('**今天**好累（笑）'), '今天好累');
  assert.equal(tts.cleanForSpeech('- 把床单洗了🌙'), '把床单洗了');
  assert.equal(tts.cleanForSpeech('[点这里](https://example.com)'), '点这里');
  assert.equal(tts.cleanForSpeech('`code` 之后'), 'code 之后');
  assert.equal(tts.cleanForSpeech('   '), '');
  assert.equal(tts.cleanForSpeech(null), '');
});

test('cleanForSpeech：长括号内容不当成舞台提示，保留正文', () => {
  const text = tts.cleanForSpeech('她说（其实我早就想去了，只是没说）好的');
  assert.ok(text.includes('其实我早就想去了'), text);
});

test('cleanForSpeech：超长时截到句末，不念半句', () => {
  const sentence = '今天天气不错，出去走了走。';
  const long = sentence.repeat(30);
  const text = tts.cleanForSpeech(long);
  assert.ok(text.length <= tts.MAX_CHARS, `长度 ${text.length}`);
  assert.ok(text.endsWith('。'), text.slice(-5));
});

test('sapiRateFor：倍率映射到 SAPI 的 -10..10 档', () => {
  assert.equal(tts.sapiRateFor(1), 0);
  assert.equal(tts.sapiRateFor(2), 8);
  assert.equal(tts.sapiRateFor(0.5), -8);
  assert.equal(tts.sapiRateFor(0.1), -10);
  assert.equal(tts.sapiRateFor(10), 10);
});

test('pathToFileUrl：中文与空格路径编码成合法 file URL', () => {
  const url = tts.pathToFileUrl('C:\\Users\\测试 用户\\声音.wav');
  assert.match(url, /^file:\/\/\/[cC]:\//);
  assert.ok(!url.includes('\\'), url);
  assert.ok(url.includes('%E5%A3%B0%E9%9F%B3'), url);
});

test('配置：voice 有默认值，缺省时不影响旧设置', () => {
  const { settings, warnings } = config.validateSettings({});
  assert.equal(warnings.length, 0, warnings.join('; '));
  assert.equal(settings.voice.enabled, true);
  assert.equal(settings.voice.engine, 'auto');
  assert.equal(settings.voice.rate, 1);
  assert.equal(settings.voice.volume, 1);
  assert.equal(settings.voice.inChat, true);
  assert.equal(settings.voice.inBubble, true);
});

test('配置：voice 非法值回落默认并告警', () => {
  const { settings, warnings } = config.validateSettings({
    voice: { engine: 'nope', rate: 9, volume: -1, sapiVoice: 42 },
  });
  assert.equal(settings.voice.engine, 'auto');
  assert.equal(settings.voice.rate, 1);
  assert.equal(settings.voice.volume, 1);
  assert.equal(settings.voice.sapiVoice, '');
  assert.ok(warnings.some((line) => line.includes('voice.engine')), warnings.join('; '));
  assert.ok(warnings.some((line) => line.includes('voice.rate')), warnings.join('; '));
});
