'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const notifications = require('../src/main/notifications');
const store = require('../src/main/store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-notify-'));
}

function makeCharacter(dir, name = '小满') {
  const character = store.createCharacter(dir, {
    name,
    appearance: {
      activePack: 'default',
      packs: [{
        id: 'default',
        frames: { idle: 'assets/idle.png' },
      }],
    },
  });
  const assetDir = path.join(dir, 'characters', character.id, 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, 'idle.png'), 'not-a-real-png');
  return character;
}

function addMessage(dir, characterId, text, ts, extra = {}) {
  store.appendMessage(dir, characterId, {
    id: `msg-${ts}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'assistant',
    text,
    ts,
    unread: true,
    ...extra,
  });
}

test('notifications：只统计已读水位之后的未读主动消息', () => {
  const dir = tempDir();
  const character = makeCharacter(dir);
  addMessage(dir, character.id, '第一条', '2026-10-26T09:00:00+08:00');
  addMessage(dir, character.id, '第二条', '2026-10-26T10:00:00+08:00');
  addMessage(dir, character.id, '已读的', '2026-10-26T08:00:00+08:00');
  addMessage(dir, character.id, '用户的', '2026-10-26T11:00:00+08:00', { role: 'user' });

  const before = notifications.summarize(dir, [character]);
  assert.equal(before.total, 3);
  assert.equal(before.items.length, 1);
  assert.equal(before.items[0].count, 3);
  assert.equal(before.items[0].latestText, '第二条');
  assert.ok(before.items[0].avatarPath.endsWith('idle.png'));
  assert.match(before.items[0].avatarUrl, /^file:/);

  // 读水位推进到 09:30 后，只剩 10:00 那条
  notifications.markRead(dir, character.id, Date.parse('2026-10-26T09:30:00+08:00'));
  const after = notifications.summarize(dir, [character]);
  assert.equal(after.total, 1);
  assert.equal(after.items[0].latestText, '第二条');
});

test('notifications：已读水位只前进不后退，且不会把用户消息算未读', () => {
  const dir = tempDir();
  const character = makeCharacter(dir);
  const later = Date.parse('2026-10-26T12:00:00+08:00');
  assert.equal(notifications.markRead(dir, character.id, later), later);
  assert.equal(notifications.markRead(dir, character.id, later - 1000), later);
  assert.equal(notifications.loadReadState(dir).characters[character.id], later);

  addMessage(dir, character.id, '普通回复', '2026-10-26T13:00:00+08:00', { unread: false });
  const summary = notifications.summarize(dir, [character]);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.items, []);
});

test('notifications：多角色按最新消息排序，总数是各角色之和', () => {
  const dir = tempDir();
  const first = makeCharacter(dir, '小满');
  const second = makeCharacter(dir, '阿澜');
  addMessage(dir, first.id, '小满的', '2026-10-26T09:00:00+08:00');
  addMessage(dir, second.id, '阿澜一', '2026-10-26T11:00:00+08:00');
  addMessage(dir, second.id, '阿澜二', '2026-10-26T11:05:00+08:00');

  const summary = notifications.summarize(dir, [first, second]);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.items.map((item) => item.name), ['阿澜', '小满']);
  assert.equal(summary.items[0].count, 2);
  assert.equal(summary.items[1].count, 1);
});

test('notifications：没有形象帧时头像为空，不报错', () => {
  const dir = tempDir();
  const character = store.createCharacter(dir, { name: '无图' });
  addMessage(dir, character.id, '在吗', '2026-10-26T09:00:00+08:00');
  const summary = notifications.summarize(dir, [character]);
  assert.equal(summary.total, 1);
  assert.equal(summary.items[0].avatarPath, null);
  assert.equal(summary.items[0].avatarUrl, null);
});
