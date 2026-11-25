'use strict';

// 小人窗的单击 / 双击 / 拖动判定（纯逻辑，不碰 DOM，便于 node --test 直接测）。
//
// 规则：
//   - 拖动（dragMoved）后松手：什么窗口都不开；
//   - 单击：等 delay（默认 500ms，与 Windows 默认双击间隔齐平）再执行 onSingle；
//   - 双击的第二下（event.detail > 1）：立刻撤销还没触发的单击，交给 dblclick 处理。
//
// 用途：避免 240ms 的延迟小于系统双击间隔（500ms）时，间隔 320ms 的双击
// 先开聊天、再开设置（reviewer 阻塞 1）。
//
// 浏览器里挂到 window.PetClick；node 里 module.exports（同一份实现）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.PetClick = api;
}(typeof window !== 'undefined' ? window : null, function () {
  const DEFAULT_DELAY_MS = 500;

  /**
   * @param {{
   *   delay?: number,
   *   onSingle?: () => void,
   *   setTimeout?: (fn: Function, ms: number) => any,
   *   clearTimeout?: (id: any) => void,
   * }} [options]
   */
  function createClickGate(options = {}) {
    const delay = Number.isFinite(options.delay) && options.delay >= 0
      ? options.delay
      : DEFAULT_DELAY_MS;
    const onSingle = typeof options.onSingle === 'function' ? options.onSingle : () => {};
    const schedule = typeof options.setTimeout === 'function'
      ? options.setTimeout
      : (fn, ms) => setTimeout(fn, ms);
    const unschedule = typeof options.clearTimeout === 'function'
      ? options.clearTimeout
      : (id) => clearTimeout(id);

    let timer = null;

    function cancel() {
      if (timer === null) return false;
      unschedule(timer);
      timer = null;
      return true;
    }

    return {
      delay,
      /**
       * 鼠标松手时调用（只有「不是拖动」的松手才该进来）。
       * @param {{ detail?: number, dragMoved?: boolean }} event
       * @returns {'drag' | 'superseded' | 'queued'}
       */
      pointerUp(event) {
        const source = event && typeof event === 'object' ? event : {};
        if (source.dragMoved) return 'drag';

        const detail = Number.isFinite(source.detail) ? source.detail : 1;
        if (detail > 1) {
          // 第二下：撤销第一下排队的「单击开聊天」，由 dblclick 决定开设置
          cancel();
          return 'superseded';
        }
        if (timer !== null) return 'queued'; // 已经排过队，不重复
        timer = schedule(() => {
          timer = null;
          onSingle();
        }, delay);
        return 'queued';
      },

      /** dblclick / 手动取消时调用 */
      cancel,

      /** 是否有待触发的单击（测试用） */
      pending() {
        return timer !== null;
      },
    };
  }

  return { createClickGate, DEFAULT_DELAY_MS };
}));
