'use strict';

// 数据目录与各文件路径（唯一真相）。
// 约定：root = 项目根目录；dir = 数据目录（即 dataDir(root)）。

const path = require('node:path');

const DATA_DIRNAME = 'data';
const CHARACTERS_DIRNAME = 'characters';

/** 项目根目录 → 数据目录 */
function dataDir(root) {
  return path.join(root, DATA_DIRNAME);
}

/** 数据目录 → settings.json */
function settingsFile(dir) {
  return path.join(dir, 'settings.json');
}

/** 数据目录 → characters/ */
function charactersDir(dir) {
  return path.join(dir, CHARACTERS_DIRNAME);
}

/** 数据目录 + 角色 id → characters/<id>/ */
function charDir(dir, id) {
  return path.join(dir, CHARACTERS_DIRNAME, String(id));
}

function characterFile(dir, id) {
  return path.join(charDir(dir, id), 'character.json');
}

function memoryFile(dir, id) {
  return path.join(charDir(dir, id), 'memory.json');
}

function timelineFile(dir, id) {
  return path.join(charDir(dir, id), 'timeline.json');
}

function chatFile(dir, id) {
  return path.join(charDir(dir, id), 'chat.jsonl');
}

/** 角色当天状态（心情 / 体力 / 专注），P3 */
function stateFile(dir, id) {
  return path.join(charDir(dir, id), 'state.json');
}

/** 数据目录 → usage.json */
function usageFile(dir) {
  return path.join(dir, 'usage.json');
}

module.exports = {
  dataDir,
  settingsFile,
  charactersDir,
  charDir,
  characterFile,
  memoryFile,
  timelineFile,
  chatFile,
  stateFile,
  usageFile,
};
