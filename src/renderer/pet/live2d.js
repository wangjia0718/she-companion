'use strict';

// Live2D 渲染（小人窗用，经典 script）。
//
// 依赖（都在 src/renderer/vendor/ 里，不联网）：
//   pixi.min.js             PIXI 6
//   live2dcubismcore.min.js Cubism 4 Core（Live2D 官方）
//   pixi-live2d-display.min.js 把 moc3 接进 PIXI
//
// 只做三件事：
//   1. 把模型铺满画布、底边对齐、水平居中；
//   2. 提供 setMouth(0..1)：每帧写 ParamMouthOpenY，做出「说话时嘴在动」；
//   3. 其它（眨眼、呼吸、待机动作）交给模型自带的 motion / physics。
//
// 为什么会覆写 internalModel.update：模型的动作每帧会重置参数，我们的嘴型必须在
// 动作更新之后、绘制之前写进去，否则会被动作覆盖掉。

(function (root) {
  const state = {
    app: null,
    model: null,
    ready: false,
    mouth: 0,
    error: '',
    modelUrl: '',
  };

  function coreModel() {
    return state.model && state.model.internalModel ? state.model.internalModel.coreModel : null;
  }

  function applyMouth() {
    const core = coreModel();
    if (!core) return;
    try {
      core.setParameterValueById('ParamMouthOpenY', state.mouth);
      // 有些模型用 ParamMouthForm 决定「微笑/抿嘴」，跟着一起给一点
      core.setParameterValueById('ParamMouthForm', 0.2 + state.mouth * 0.4);
    } catch {
      // 模型没这个参数就算了
    }
  }

  function fitModel() {
    const { app, model } = state;
    if (!app || !model) return;
    const width = app.screen.width;
    const height = app.screen.height;
    if (!width || !height) return;

    const bounds = model.getLocalBounds();
    const scale = Math.min(width / bounds.width, height / bounds.height) * 0.98;
    model.scale.set(scale);
    model.anchor.set(0.5, 1);
    model.x = width / 2;
    model.y = height;
  }

  /**
   * 初始化（重复调用会复用已加载的模型）
   * @param {{ canvas: HTMLCanvasElement, url: string }} options
   * @returns {Promise<boolean>}
   */
  async function init({ canvas, url }) {
    if (!root.PIXI || !root.PIXI.live2d) {
      state.error = 'live2d-runtime-missing';
      return false;
    }
    if (state.ready && state.modelUrl === url) {
      fitModel();
      return true;
    }
    destroy();

    try {
      if (!state.app) {
        state.app = new root.PIXI.Application({
          view: canvas,
          transparent: true,
          backgroundAlpha: 0,
          antialias: true,
          autoStart: true,
          resizeTo: root,
          resolution: Math.min(2, root.devicePixelRatio || 1),
        });
      }
      const model = await root.PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
      state.model = model;
      state.modelUrl = url;
      state.app.stage.addChild(model);

      // 动作更新完之后再写嘴型，保证不被 motion 覆盖
      const internal = model.internalModel;
      if (internal && typeof internal.update === 'function') {
        const original = internal.update.bind(internal);
        internal.update = (dt, now) => {
          original(dt, now);
          applyMouth();
        };
      }

      // 有小动作就自动播待机动作
      const motions = internal && internal.motionManager ? internal.motionManager.definitions : null;
      if (motions && Array.isArray(motions.idle) && motions.idle.length > 0) {
        model.motion('idle').catch(() => {});
      }

      fitModel();
      state.ready = true;
      state.error = '';
      return true;
    } catch (error) {
      state.error = error && error.message ? error.message : 'live2d-load-failed';
      console.warn(`[live2d] 加载失败：${state.error}`);
      return false;
    }
  }

  function setMouth(value) {
    const next = Number(value);
    state.mouth = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 0;
  }

  function resize() {
    if (state.app && state.app.renderer) {
      state.app.renderer.resize(root.innerWidth, root.innerHeight);
      fitModel();
    }
  }

  /** 模型顶边在窗口里的位置（CSS px），用来把说话波形放到头顶 */
  function headTop() {
    if (!state.ready || !state.model) return 0;
    try {
      return Math.max(0, Math.round(state.model.getBounds().y));
    } catch {
      return 0;
    }
  }

  function destroy() {
    if (state.model && state.app) {
      try { state.app.stage.removeChild(state.model); } catch { /* 忽略 */ }
      try { state.model.destroy(); } catch { /* 忽略 */ }
    }
    state.model = null;
    state.ready = false;
    state.modelUrl = '';
  }

  function status() {
    return { ready: state.ready, error: state.error, mouth: state.mouth, url: state.modelUrl };
  }

  /** 调试用：读模型里真实的参数值（确认我们的写入没有被动作覆盖） */
  function coreParam(id) {
    const core = coreModel();
    if (!core || typeof core.getParameterValueById !== 'function') return null;
    try {
      return core.getParameterValueById(id);
    } catch {
      return null;
    }
  }

  root.PetLive2D = { init, setMouth, resize, destroy, status, headTop, coreParam };
}(typeof window !== 'undefined' ? window : null));
