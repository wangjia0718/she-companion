'use strict';

// 托盘未读：主进程侧的「读到哪里」水位 + 每个角色未读主动消息摘要。
//
// 聊天窗自己的已读状态在 localStorage（chat.js），主进程看不到；托盘要在窗口没开时
// 也知道谁发了消息，所以这里单独记一份 read-state.json。聊天窗打开/聚焦时通过
// chat:markRead 把水位推进到当前时间。
//
// 未读只统计 chat.jsonl 里 role=assistant 且 unread=true 的消息（主动消息会带这个标记），
// 并且 ts 必须晚于该角色的已读水位。旧消息即使还带着 unread=true，也不会重复冒红点。

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const paths = require('./paths');
const store = require('./store');

const READ_STATE_FILE = 'read-state.json';
const READ_STATE_VERSION = 1;

function stateFile(dir) {
  return path.join(dir, READ_STATE_FILE);
}

function normaliseState(raw) {
  const source = raw && typeof raw === 'object' && raw.characters && typeof raw.characters === 'object'
    ? raw.characters
    : {};
  const characters = {};
  for (const [id, at] of Object.entries(source)) {
    const value = Number(at);
    if (typeof id === 'string' && id !== '' && Number.isFinite(value) && value > 0) {
      characters[id] = value;
    }
  }
  return { version: READ_STATE_VERSION, characters };
}

function loadReadState(dir) {
  return normaliseState(store.readJSON(stateFile(dir), null));
}

/** 把某个角色的已读水位推进到 at；只前进不后退。返回最新水位。 */
function markRead(dir, characterId, at = Date.now()) {
  if (typeof characterId !== 'string' || characterId === '') {
    throw new Error('标记已读需要角色 id');
  }
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) throw new Error('标记已读需要有效时间');
  const state = loadReadState(dir);
  const current = Number(state.characters[characterId]) || 0;
  if (value <= current) return current;
  state.characters[characterId] = value;
  store.writeJSON(stateFile(dir), state);
  return value;
}

/** role=assistant 且带 unread 标记的消息才算未读；用户消息永远不算。 */
function isUnreadMessage(message) {
  return Boolean(message)
    && message.role === 'assistant'
    && message.unread === true;
}

function tsOf(message) {
  if (!message || typeof message.ts !== 'string') return 0;
  const at = Date.parse(message.ts);
  return Number.isFinite(at) ? at : 0;
}

/** 角色头像：优先 idle，其次任意一张帧；返回绝对路径（不存在则 null）。 */
function avatarPathOf(dir, character) {
  const appearance = character && character.appearance && typeof character.appearance === 'object'
    ? character.appearance
    : {};
  const packs = Array.isArray(appearance.packs) ? appearance.packs : [];
  const pack = packs.find((item) => item && item.id === appearance.activePack) || packs[0];
  const frames = pack && pack.frames && typeof pack.frames === 'object' ? pack.frames : {};
  const rel = frames.idle
    || frames.happy
    || frames.sad
    || frames.think
    || frames.angry
    || frames.sleepy
    || Object.values(frames).find((value) => typeof value === 'string' && value !== '');
  if (typeof rel !== 'string' || rel === '') return null;

  let base;
  try {
    base = path.resolve(paths.charDir(dir, character.id));
  } catch {
    return null;
  }
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  try {
    if (!fs.existsSync(abs)) return null;
  } catch {
    return null;
  }
  return abs;
}

function snippet(text) {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return value.length > 48 ? `${value.slice(0, 48)}…` : value;
}

/**
 * 汇总每个角色的未读主动消息。
 * @returns {{ total: number, items: Array<{ characterId: string, name: string, count: number,
 *   latestText: string, latestTs: string, avatarPath: string|null, avatarUrl: string|null }> }}
 */
function summarize(dir, characters, options = {}) {
  const state = loadReadState(dir);
  const list = Array.isArray(characters) ? characters : store.listCharacters(dir);
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 2000;
  const items = [];

  for (const character of list) {
    if (!character || typeof character.id !== 'string' || character.id === '') continue;
    const readAt = Number(state.characters[character.id]) || 0;
    let messages;
    try {
      messages = store.readMessages(dir, character.id, { limit });
    } catch {
      continue;
    }

    const unread = messages.filter((message) => {
      if (!isUnreadMessage(message)) return false;
      const at = tsOf(message);
      return at === 0 || at > readAt;
    });
    if (unread.length === 0) continue;

    unread.sort((a, b) => tsOf(a) - tsOf(b));
    const latest = unread[unread.length - 1];
    const avatarPath = avatarPathOf(dir, character);
    items.push({
      characterId: character.id,
      name: typeof character.name === 'string' && character.name !== '' ? character.name : '她',
      count: unread.length,
      latestText: snippet(latest.text),
      latestTs: typeof latest.ts === 'string' ? latest.ts : '',
      avatarPath,
      avatarUrl: avatarPath ? pathToFileURL(avatarPath).href : null,
    });
  }

  items.sort((a, b) => {
    const delta = (Date.parse(b.latestTs) || 0) - (Date.parse(a.latestTs) || 0);
    return delta !== 0 ? delta : a.characterId.localeCompare(b.characterId);
  });
  return { total: items.reduce((sum, item) => sum + item.count, 0), items };
}

module.exports = {
  READ_STATE_FILE,
  stateFile,
  loadReadState,
  markRead,
  avatarPathOf,
  summarize,
};
