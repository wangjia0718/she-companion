'use strict';

// 主进程 i18n：共享引擎 + 主进程字典。
const engine = require('../shared/i18n');

engine.setDictionary(require('./i18n-en'));

module.exports = engine;
