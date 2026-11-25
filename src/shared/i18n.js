'use strict';

/**
 * 轻量 i18n 引擎（主进程与渲染层共用）。
 *
 * 设计取舍：
 * - 字典以「中文原文」为 key，省掉给上千条文案编号的成本；
 * - 支持 `{0}` 占位符，渲染层用 MutationObserver 自动翻译动态文案；
 * - 翻译时把中文原文记在 WeakMap 里，切回中文可以原样恢复，不需要重载页面。
 *
 * 用法：
 *   SheI18n.setDictionary(map)   // 渲染层由 i18n-ui-en.js 提供 SHE_I18N_EN
 *   SheI18n.setLanguage('en')
 *   SheI18n.t('保存')            // 'Save'
 *   SheI18n.translateDom(document.body)
 *   SheI18n.observe()            // 自动翻译之后新增/变化的文本
 */

(function init(root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.SheI18n = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  const CJK = /[\u4e00-\u9fff]/;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  let dictionary = Object.create(null);
  let patterns = null;
  let language = 'zh';

  const textOrigin = new WeakMap();
  const attrOrigin = new WeakMap();
  const titleOrigin = { value: null };
  let observer = null;
  let pending = null;

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function setDictionary(map) {
    dictionary = Object.create(null);
    if (isObject(map)) {
      for (const key of Object.keys(map)) {
        if (typeof map[key] === 'string' && map[key] !== '') dictionary[key] = map[key];
      }
    }
    patterns = null;
  }

  function ensureDictionary() {
    if (Object.keys(dictionary).length > 0) return;
    const injected = typeof globalThis !== 'undefined' ? globalThis.SHE_I18N_EN : null;
    if (isObject(injected)) setDictionary(injected);
  }

  function setLanguage(next) {
    language = next === 'en' ? 'en' : 'zh';
    ensureDictionary();
  }

  function getLanguage() {
    return language;
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildPatterns() {
    patterns = [];
    for (const key of Object.keys(dictionary)) {
      if (!key.includes('{')) continue;
      const groups = [];
      const source = escapeRegExp(key).replace(/\\\{(\d+)\\\}/g, (_all, index) => {
        groups.push(Number(index));
        return '([\\s\\S]*?)';
      });
      try {
        patterns.push({ re: new RegExp(`^${source}$`), groups, value: dictionary[key] });
      } catch (error) {
        // 极端情况下跳过坏 key，不让整个界面挂掉
      }
    }
  }

  function fill(template, values) {
    return template.replace(/\{(\d+)\}/g, (all, index) => {
      const value = values[Number(index)];
      return value === undefined ? all : String(value);
    });
  }

  /** 中文文本 → 英文模板；未收录返回 null */
  function lookup(text) {
    if (typeof text !== 'string' || text === '' || !CJK.test(text)) return null;
    ensureDictionary();
    if (Object.prototype.hasOwnProperty.call(dictionary, text)) return dictionary[text];
    if (!patterns) buildPatterns();
    for (const item of patterns) {
      const match = item.re.exec(text);
      if (!match) continue;
      const values = [];
      item.groups.forEach((index, position) => {
        values[index] = match[position + 1];
      });
      return fill(item.value, values);
    }
    return null;
  }

  /** 程序里主动翻译：t('有 {0} 处需要修改', n) */
  function t(text, ...args) {
    if (typeof text !== 'string') return text;
    let result = text;
    if (language === 'en') result = lookup(text) || text;
    if (args.length > 0) result = fill(result, args);
    return result;
  }

  function translateString(text) {
    if (language !== 'en') return null;
    return lookup(text);
  }

  function hasSkippedAncestor(node, options = {}) {
    const ignoreSelfTag = options && options.ignoreSelfTag === true;
    let element = node && node.nodeType === 3 ? node.parentElement : node;
    while (element) {
      if (element.nodeType === 1) {
        if (SKIP_TAGS.has(element.tagName) && !(ignoreSelfTag && element === node)) return true;
        if (element.hasAttribute && element.hasAttribute('data-i18n-skip')) return true;
      }
      element = element.parentElement;
    }
    return false;
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    if (hasSkippedAncestor(node)) return;
    const value = node.nodeValue;
    const tracked = textOrigin.has(node);
    // 中文模式下也要能还原：当前值可能已经是英文，不能因为「没有中文」就提前退出
    if (!tracked && !CJK.test(value)) return;

    const original = tracked ? textOrigin.get(node) : value;
    const leading = original.match(/^\s*/)[0];
    const trailing = original.match(/\s*$/)[0];
    const core = original.slice(leading.length, original.length - trailing.length);
    if (!CJK.test(core)) return;
    if (!tracked) textOrigin.set(node, original);

    if (language === 'zh') {
      if (node.nodeValue !== original) node.nodeValue = original;
      return;
    }
    const translated = lookup(core);
    if (!translated) return;
    const next = `${leading}${translated}${trailing}`;
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  function translateAttributes(element) {
    if (!element || element.nodeType !== 1 || hasSkippedAncestor(element, { ignoreSelfTag: true })) return;
    let originals = attrOrigin.get(element);
    for (const attr of ATTRS) {
      if (!element.hasAttribute || !element.hasAttribute(attr)) continue;
      const value = element.getAttribute(attr);
      if (typeof value !== 'string') continue;
      const tracked = Boolean(originals && originals[attr] !== undefined);
      if (!tracked && !CJK.test(value)) continue;
      if (!originals) {
        originals = Object.create(null);
        attrOrigin.set(element, originals);
      }
      if (!tracked) originals[attr] = value;
      const source = originals[attr];
      if (language === 'zh') {
        if (value !== source) element.setAttribute(attr, source);
        continue;
      }
      const translated = lookup(source);
      if (translated && translated !== value) element.setAttribute(attr, translated);
    }
  }

  function translateTitle() {
    if (typeof document === 'undefined') return;
    if (titleOrigin.value === null) titleOrigin.value = document.title;
    const source = titleOrigin.value;
    if (language === 'zh') {
      if (document.title !== source) document.title = source;
      return;
    }
    const translated = lookup(source);
    if (translated) document.title = translated;
  }

  function translateElement(element) {
    if (!element || element.nodeType !== 1) return;
    translateAttributes(element);
    if (element.querySelectorAll) {
      for (const node of element.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
        translateAttributes(node);
      }
    }
  }

  function translateDom(root) {
    if (typeof document === 'undefined') return;
    ensureDictionary();
    const scope = root || document.body;
    if (!scope) return;
    translateTitle();
    if (scope.nodeType === 3) {
      translateTextNode(scope);
      return;
    }
    translateElement(scope);
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) translateTextNode(node);
    if (typeof document !== 'undefined') document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  }

  function flush() {
    pending = null;
    translateDom(document.body);
  }

  function schedule() {
    if (pending !== null) return;
    pending = setTimeout(flush, 16);
  }

  /** 自动翻译动态渲染出来的文案（聊天输入/正文等用 data-i18n-skip 排除） */
  function observe(root) {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return null;
    if (observer) return observer;
    const target = root || document.body;
    observer = new MutationObserver((mutations) => {
      if (language !== 'en') return;
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          translateTextNode(mutation.target);
          continue;
        }
        if (mutation.type === 'attributes') {
          translateAttributes(mutation.target);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 3) translateTextNode(node);
          else if (node.nodeType === 1) translateDom(node);
        }
      }
    });
    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    return observer;
  }

  function disconnect() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  /**
   * 一次性初始化：设置语言、翻译整页、开启动态翻译。
   * @param {'zh'|'en'} lang
   */
  function apply(lang) {
    setLanguage(lang);
    translateDom(document.body);
    observe(document.body);
  }

  return {
    setDictionary,
    setLanguage,
    getLanguage,
    t,
    translateString,
    translateDom,
    observe,
    disconnect,
    apply,
  };
});
