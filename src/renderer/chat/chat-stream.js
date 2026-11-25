'use strict';

// 聊天流式状态（经典 script；挂 window.ChatStream，Node 里可 require 做单测）。
//
// 只负责"这条流现在收到什么、该不该画"：
//   1. 停止后（stopping）或已收尾（finalized）迟到的 delta 一律丢弃；
//   2. delta 的 messageId 与当前流不一致时丢弃（防重复投递 / 防串流）；
//   3. finalize 以主进程 done 的权威文本为准，并统一补「（中断）」后缀与 token 数。
//
// 渲染层把气泡文本当作 stream.text 的镜像，不在别处累加。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.ChatStream = api;
}(typeof window !== 'undefined' ? window : null, function build() {
  /** 新建一条流的状态 */
  function create() {
    return {
      text: '',
      messageId: '',
      stopping: false,
      finalized: false,
    };
  }

  /** 记录服务端给的流 id（第一次非空时定下来） */
  function begin(stream, messageId) {
    if (!stream) return stream;
    if (!stream.messageId && typeof messageId === 'string' && messageId !== '') {
      stream.messageId = messageId;
    }
    return stream;
  }

  /** 进入"停止中"：之后到达的 delta 不再进入气泡 */
  function stop(stream) {
    if (!stream) return stream;
    stream.stopping = true;
    return stream;
  }

  /**
   * 接收一个 delta。
   * @returns {boolean} 是否被接受（false 时调用方不应改任何文本）
   */
  function applyDelta(stream, payload) {
    if (!stream || stream.stopping || stream.finalized) return false;
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.text !== 'string' || payload.text === '') return false;

    const incomingId = typeof payload.messageId === 'string' ? payload.messageId : '';
    if (incomingId !== '' && stream.messageId !== '' && incomingId !== stream.messageId) return false;
    if (stream.messageId === '' && incomingId !== '') stream.messageId = incomingId;

    stream.text += payload.text;
    return true;
  }

  /**
   * 收尾：优先用主进程 done 里的 message.text（权威全文），否则用 payload.text，
   * 再否则用本地已收到的文本。停止的回复统一以「（中断）」结尾（已有则不重复）。
   * @returns {{ text: string, stopped: boolean, tokens: number }}
   */
  function finalize(stream, payload) {
    const box = stream || create();
    const input = payload && typeof payload === 'object' ? payload : {};
    const message = input.message && typeof input.message === 'object' ? input.message : null;

    let text = '';
    if (message && typeof message.text === 'string' && message.text !== '') {
      text = message.text;
    } else if (typeof input.text === 'string') {
      text = input.text;
    } else {
      text = box.text;
    }

    const stopped = input.stopped === true || !!(message && message.stopped === true);
    if (stopped && text !== '' && !/（中断）\s*$/.test(text)) text = `${text}（中断）`;

    const usage = input.usage && typeof input.usage === 'object' ? input.usage : null;
    const usageTokens = usage ? Number(usage.completionTokens) : 0;
    const messageTokens = message ? Number(message.tokens) : 0;
    let tokens = 0;
    if (Number.isFinite(usageTokens) && usageTokens > 0) tokens = usageTokens;
    else if (Number.isFinite(messageTokens) && messageTokens > 0) tokens = messageTokens;

    box.text = text;
    box.stopping = false;
    box.finalized = true;
    return { text, stopped, tokens };
  }

  return { create, begin, stop, applyDelta, finalize };
}));
