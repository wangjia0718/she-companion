'use strict';

// 聊天流式状态单测（Task 11 返工 B1）：
// 停止后迟到的 delta 不能进气泡；done 到达时用主进程的权威全文与 token 收尾。

const test = require('node:test');
const assert = require('node:assert/strict');

const ChatStream = require('../src/renderer/chat/chat-stream.js');

test('停止后到达的 3 个 delta 全部丢弃；done 显示权威全文 + 「（中断）」', () => {
  const stream = ChatStream.create();
  assert.equal(ChatStream.applyDelta(stream, { messageId: 'stream-1', text: '你好' }), true);
  assert.equal(stream.text, '你好');
  assert.equal(stream.messageId, 'stream-1');

  ChatStream.stop(stream);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(ChatStream.applyDelta(stream, { messageId: 'stream-1', text: '迟到' }), false);
  }
  assert.equal(stream.text, '你好', '停止后的 delta 不能改变气泡文本');

  const result = ChatStream.finalize(stream, {
    message: { text: '你好，世界（中断）', stopped: true, tokens: 7 },
    usage: { completionTokens: 42 },
  });
  assert.equal(result.text, '你好，世界（中断）');
  assert.equal(result.stopped, true);
  assert.equal(result.tokens, 42);
  assert.equal(stream.text, '你好，世界（中断）');
  assert.equal(stream.stopping, false, '收尾后解除停止态');
  assert.equal(stream.finalized, true);
});

test('messageId 不一致的 delta 丢弃（防重复投递 / 防串流）', () => {
  const stream = ChatStream.create();
  assert.equal(ChatStream.applyDelta(stream, { messageId: 'stream-a', text: 'A' }), true);
  assert.equal(ChatStream.applyDelta(stream, { messageId: 'stream-b', text: 'B' }), false);
  assert.equal(ChatStream.applyDelta(stream, { messageId: '', text: 'C' }), true);
  assert.equal(stream.text, 'AC');
});

test('3 秒兜底收尾：本地文本补「（中断）」，且不重复补', () => {
  const stream = ChatStream.create();
  ChatStream.applyDelta(stream, { text: '半句' });
  const fallback = ChatStream.finalize(stream, { text: '半句', stopped: true });
  assert.equal(fallback.text, '半句（中断）');

  const again = ChatStream.finalize(ChatStream.create(), {
    message: { text: '已经带了（中断）', stopped: true },
  });
  assert.equal(again.text, '已经带了（中断）');
});

test('token 数优先取 usage.completionTokens，缺失时退回 message.tokens', () => {
  const withUsage = ChatStream.finalize(ChatStream.create(), {
    message: { text: '好', tokens: 5 },
    usage: { completionTokens: 9 },
  });
  assert.equal(withUsage.tokens, 9);

  const messageOnly = ChatStream.finalize(ChatStream.create(), {
    message: { text: '好', tokens: 5 },
  });
  assert.equal(messageOnly.tokens, 5);

  const none = ChatStream.finalize(ChatStream.create(), { message: { text: '好' } });
  assert.equal(none.tokens, 0);
});

test('正常结束（未停止）不会凭空补「（中断）」', () => {
  const stream = ChatStream.create();
  ChatStream.applyDelta(stream, { messageId: 'stream-1', text: '在的' });
  const result = ChatStream.finalize(stream, { message: { text: '在的', stopped: false } });
  assert.equal(result.text, '在的');
  assert.equal(result.stopped, false);
});
