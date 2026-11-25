'use strict';

// 朗读 + 波形（渲染层共用：小人窗 / 聊天窗）。
//
// 分工：主进程只把文本合成成 wav 并返回 file:// URL；这里负责播放、打断、画波形。
// 波形优先用 WebAudio AnalyserNode 取真实频谱（跟声音同步），拿不到就退化成假振幅。
//
// 用法：
//   SheVoice.say('今天有点累', { kind: 'chat' });
//   SheVoice.bindWave(document.getElementById('wave'));
//   SheVoice.stop();

(function (root) {
  const API = root && root.api ? root.api : null;
  const BARS = 5;

  const state = {
    speaking: false,
    volume: 1,
    level: 0,
  };

  let audio = null;
  let audioCtx = null;
  let analyser = null;
  let analyserFailed = false;
  let freq = null;
  let raf = 0;
  let fakePhase = 0;
  const waves = new Set();
  const listeners = new Set();
  let pendingToken = 0;

  function notify() {
    for (const fn of listeners) {
      try { fn(state); } catch { /* 监听方出错不影响朗读 */ }
    }
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = new window.Audio();
    audio.preload = 'auto';
    audio.addEventListener('play', () => {
      state.speaking = true;
      notify();
      startLoop();
    });
    const finish = () => {
      state.speaking = false;
      state.level = 0;
      stopLoop();
      notify();
    };
    audio.addEventListener('ended', finish);
    audio.addEventListener('pause', finish);
    audio.addEventListener('error', () => {
      console.warn('[voice] 音频播放失败');
      finish();
    });
    return audio;
  }

  /**
   * 接上频谱分析；失败（无 AudioContext / 没跑起来 / 跨源）就返回 null，走估算振幅。
   * 注意：一旦把 <audio> 接进 AudioContext，声音就只能经 context 出去；
   * 所以 context 没真正 running 时不接，宁可没有真频谱也要保证能出声。
   */
  async function ensureAnalyser() {
    if (analyser) return analyser;
    if (analyserFailed) return null;
    const Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) {
      analyserFailed = true;
      return null;
    }
    try {
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch { /* 下面按状态判断 */ }
      }
      if (audioCtx.state !== 'running') {
        analyserFailed = true;
        return null;
      }
      const source = audioCtx.createMediaElementSource(ensureAudio());
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
      return analyser;
    } catch (error) {
      console.warn(`[voice] 频谱分析不可用，改用估算振幅：${error && error.message ? error.message : error}`);
      analyser = null;
      analyserFailed = true;
      return null;
    }
  }

  function readLevels() {
    if (analyser && freq) {
      analyser.getByteFrequencyData(freq);
      const levels = [];
      // 取低频到中频的一段（人声主要在 80–4000Hz，fftSize 256 时落在前 ~20 个桶）
      const span = Math.max(BARS, Math.min(freq.length, 24));
      for (let i = 0; i < BARS; i += 1) {
        const start = Math.floor((i * span) / BARS);
        const end = Math.max(start + 1, Math.floor(((i + 1) * span) / BARS));
        let sum = 0;
        for (let j = start; j < end; j += 1) sum += freq[j];
        const avg = sum / (end - start) / 255;
        // 语音能量集中在低频，线性映射会长期顶到 1：用指数压一下，让波形有起伏
        levels.push(Math.min(1, Math.pow(avg, 1.8) * 1.25));
      }
      return levels;
    }
    // 假振幅：几个不同频率的正弦，看着像在说话
    fakePhase += 0.18;
    const levels = [];
    for (let i = 0; i < BARS; i += 1) {
      const wave = 0.5 + 0.5 * Math.sin(fakePhase + i * 1.7);
      levels.push(0.18 + 0.55 * wave * (0.6 + 0.4 * Math.sin(fakePhase * 0.7 + i)));
    }
    return levels;
  }

  function paint(levels) {
    for (const el of waves) {
      const bars = el.children;
      for (let i = 0; i < bars.length; i += 1) {
        const value = levels[Math.min(levels.length - 1, i)] || 0;
        bars[i].style.transform = `scaleY(${(0.16 + value * 0.84).toFixed(3)})`;
      }
    }
  }

  function tick() {
    raf = 0;
    if (!state.speaking) {
      paint(new Array(BARS).fill(0));
      return;
    }
    const levels = readLevels();
    state.level = levels.reduce((sum, value) => sum + value, 0) / levels.length;
    paint(levels);
    raf = root.requestAnimationFrame ? root.requestAnimationFrame(tick) : 0;
  }

  function startLoop() {
    for (const el of waves) el.classList.add('is-speaking');
    if (!raf && root.requestAnimationFrame) raf = root.requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (raf && root.cancelAnimationFrame) root.cancelAnimationFrame(raf);
    raf = 0;
    for (const el of waves) el.classList.remove('is-speaking');
    paint(new Array(BARS).fill(0));
  }

  function stop() {
    pendingToken += 1;
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch { /* 还没加载好，忽略 */ }
    if (state.speaking) {
      state.speaking = false;
      notify();
    }
    stopLoop();
  }

  /**
   * 念一句话。被新的 say / stop 打断时，旧的合成结果直接丢弃。
   * @param {string} text
   * @param {{ kind?: 'chat'|'bubble' }} [options]
   */
  async function say(text, options = {}) {
    if (!API) return false;
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return false;

    stop();
    const token = ++pendingToken;

    let result = null;
    try {
      result = await API.invoke('tts:speak', { text: body, kind: options.kind || 'chat' });
    } catch (error) {
      console.warn(`[voice] 合成失败：${error && error.message ? error.message : error}`);
      return false;
    }
    if (token !== pendingToken) return false; // 期间被新的朗读/停止顶掉了
    if (!result || result.ok === false || !result.url) return false;

    const el = ensureAudio();
    state.volume = Number.isFinite(Number(result.volume)) ? Number(result.volume) : 1;
    el.volume = Math.max(0, Math.min(1, state.volume));
    el.src = result.url;

    // 先建好频谱（会等 AudioContext 真正 running）；拿不到就退回估算振幅
    await ensureAnalyser();

    try {
      await el.play();
    } catch (error) {
      console.warn(`[voice] 播放失败：${error && error.message ? error.message : error}`);
      return false;
    }
    return true;
  }

  function bindWave(el) {
    if (!el) return () => {};
    waves.add(el);
    paint(new Array(BARS).fill(0));
    return () => waves.delete(el);
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  if (API && typeof API.on === 'function') {
    API.on('tts:halt', () => stop());
  }
  if (root && typeof root.addEventListener === 'function') {
    root.addEventListener('beforeunload', () => stop());
  }

  root.SheVoice = { say, stop, bindWave, onChange, get state() { return { ...state }; } };
}(typeof window !== 'undefined' ? window : null));
