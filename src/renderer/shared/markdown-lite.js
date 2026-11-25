'use strict';

// markdown-lite：聊天里能用的最小标记，只支持
//   **加粗**   *斜体*   `行内代码`   换行（\n → <br>）
//
// 安全约定（Task 11 / Spec 10.2）：
//   1. 先做 HTML 转义，再识别标记；任何原始 HTML 都只会变成可见字符。
//   2. 输出里只可能出现 <strong>/<em>/<code>/<br> 这四种标签，且都由本文件生成。
//   3. 行内代码内部不再套加粗/斜体（避免代码被改写）。
//
// 渲染层用经典 script 引入（挂到 window.MarkdownLite）；测试 / Node 里可以直接 require。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.MarkdownLite = api;
}(typeof window !== 'undefined' ? window : null, function build() {
  const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  const ESCAPE_RE = /[&<>"']/g;
  const CODE_RE = /`([^`\n]+)`/g;

  /** 把任意值转成安全文本（null / undefined → 空串） */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
  }

  /**
   * 已经转义过的片段里识别加粗/斜体。
   * 只碰 *，不碰 _（避免把 file_name_here 这类标识符误判成斜体）。
   */
  function renderInline(segment) {
    return segment
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  }

  /** 渲染成一段可安全赋给 innerHTML 的 HTML */
  function render(text) {
    const escaped = escapeHtml(text);
    const out = [];
    let cursor = 0;
    let match;
    CODE_RE.lastIndex = 0;
    while ((match = CODE_RE.exec(escaped)) !== null) {
      out.push(renderInline(escaped.slice(cursor, match.index)));
      out.push(`<code>${match[1]}</code>`);
      cursor = match.index + match[0].length;
    }
    out.push(renderInline(escaped.slice(cursor)));
    return out.join('').replace(/\n/g, '<br>');
  }

  return { escapeHtml, render };
}));
