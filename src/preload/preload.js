'use strict';

// preload：只经 contextBridge 暴露白名单能力，渲染层拿不到 ipcRenderer / Node。
// 白名单与 src/main/ipc.js 的 CHANNELS / EVENTS 保持一致（test/ipc.test.js 会校验不漂移）。
//
// 注意：contextBridge 每次跨桥都会新建代理对象，拿页面传来的回调当 key 找不到。
// 因此监听器按「事件 → Set<包装后的监听器>」管理：
//   - on 返回 unsubscribe 函数；
//   - off(event) 移除该事件下的全部监听器（不需要回调也能用）。

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = Object.freeze([
  'settings:get',
  'settings:save',
  'settings:setKey',
  'settings:testProfile',
  'settings:setAutostart',

  'characters:list',
  'characters:create',
  'characters:save',
  'characters:delete',
  'characters:setActive',
  'characters:importFrame',
  'characters:frames',
  'characters:generateInner',
  'characters:saveInner',

  'chat:send',
  'chat:stop',
  'chat:history',
  'chat:clear',
  'chat:markRead',

  'memory:list',
  'memory:add',
  'memory:update',
  'memory:delete',

  'timeline:get',
  'timeline:deleteDiary',
  'state:get',

  'usage:today',

  'pet:getState',
  'pet:cursorInside',
  'pet:move',
  'pet:scale',
  'pet:setIgnore',
  'pet:bubbleDismissed',
  'tts:speak',
  'tts:stop',
  'tts:status',
  'window:open',
  'tray:unread',
  'tray:popupHover',

  'data:openDataDir',
  'data:export',
  'dialog:pickImage',

  'app:quit',
]);

const EVENT_NAMES = Object.freeze([
  'chat:delta',
  'chat:done',
  'chat:replace',
  'chat:error',
  'chat:select',
  'chat:refresh',
  'pet:bubble',
  'state:changed',
  'tray:update',
  'tts:halt',
]);

// event -> Set<wrapped>
const listeners = new Map();

function assertChannel(channel) {
  if (typeof channel !== 'string' || !INVOKE_CHANNELS.includes(channel)) {
    throw new Error(`unknown channel: ${String(channel)}`);
  }
}

function assertEvent(event) {
  if (typeof event !== 'string' || !EVENT_NAMES.includes(event)) {
    throw new Error(`unknown event: ${String(event)}`);
  }
}

function removeFromEvent(event, wrapped) {
  ipcRenderer.removeListener(event, wrapped);
  const set = listeners.get(event);
  if (!set) return;
  set.delete(wrapped);
  if (set.size === 0) listeners.delete(event);
}

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, payload);
  },

  on(event, callback) {
    assertEvent(event);
    if (typeof callback !== 'function') throw new Error('api.on 需要回调函数');

    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }

    const wrapped = (_event, data) => {
      try {
        callback(data);
      } catch (error) {
        console.error(`[preload] 处理 ${event} 时出错：`, error);
      }
    };
    set.add(wrapped);
    ipcRenderer.on(event, wrapped);

    return () => removeFromEvent(event, wrapped);
  },

  off(event) {
    assertEvent(event);
    const set = listeners.get(event);
    if (!set) return;
    for (const wrapped of Array.from(set)) removeFromEvent(event, wrapped);
    listeners.delete(event);
  },
});
