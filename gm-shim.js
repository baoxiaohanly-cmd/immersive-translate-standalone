/* gm-shim.js
 * Tampermonkey GM_* API 垫片，让沉浸式翻译用户脚本以 Chrome MV3 扩展形式独立运行。
 * 加载顺序：gm-shim.js -> tm-require.js -> immersive.js
 */
(function () {
  'use strict';

  /* ---------------- GM_info（tm-require.js 会读取，非 TM 环境直接提前返回） ---------------- */
  globalThis.GM_info = {
    scriptHandler: 'ChromeExtension',
    version: '1.0.0',
    script: {
      name: 'Immersive Translate Standalone',
      version: '1.33.3',
      namespace: 'immersive-translate-standalone'
    }
  };

  /* ---------------- 存储：chrome.storage.local（按扩展隔离） ---------------- */
  globalThis.GM_getValue = async function (key, defaultValue) {
    key = String(key);
    const r = await chrome.storage.local.get(key);
    return Object.prototype.hasOwnProperty.call(r, key) ? r[key] : defaultValue;
  };

  globalThis.GM_setValue = async function (key, value) {
    await chrome.storage.local.set({ [String(key)]: value });
  };

  globalThis.GM_deleteValue = async function (key) {
    await chrome.storage.local.remove(String(key));
  };

  globalThis.GM_listValues = async function () {
    return Object.keys(await chrome.storage.local.get(null));
  };

  const __valueListeners = new Map();
  globalThis.GM_addValueChangeListener = function (key, callback) {
    key = String(key);
    const id = 'vl_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const wrapped = (changes, area) => {
      if (area === 'local' && changes && Object.prototype.hasOwnProperty.call(changes, key)) {
        try { callback(key, changes[key].oldValue, changes[key].newValue, false); } catch (e) {}
      }
    };
    __valueListeners.set(id, wrapped);
    chrome.storage.onChanged.addListener(wrapped);
    return id;
  };

  globalThis.GM_removeValueChangeListener = function (id) {
    const w = __valueListeners.get(id);
    if (w) {
      try { chrome.storage.onChanged.removeListener(w); } catch (e) {}
      __valueListeners.delete(id);
    }
  };

  /* ---------------- 网络：经由 background service worker 转发（绕过页面 CORS） ----------------
   * 请求 ID 格式：<8位随机实例前缀>-<序号>，同一标签页内多 frame 也不会碰撞。
   * 回包由 background 按 frameId 定向投递，本 frame 只认自己的 ID。 */
  let __xhrSeq = 0;
  const __xhrInstance = Math.random().toString(36).slice(2, 10);
  const __xhrPending = new Map(); // id -> { details, accText, aborted }

  function __sendToBackground(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) {}
  }

  function __b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function __buildXhrShim() {
    return function (details) {
      details = details || {};
      const id = __xhrInstance + '-' + (++__xhrSeq);
      const state = { details: details, accText: '', aborted: false };
      __xhrPending.set(id, state);

      // 请求体显式编码为可 JSON 序列化结构（见 codec.js），不依赖消息通道的结构化克隆语义
      const codec = globalThis.ITCodec;
      Promise.resolve()
        .then(() => codec.encodeBody(details.data == null ? null : details.data))
        .then((encoded) => {
          if (state.aborted || !__xhrPending.has(id)) return;
          __sendToBackground({
            type: 'IT_XHR',
            id: id,
            method: (details.method || 'GET').toUpperCase(),
            url: details.url,
            headers: details.headers || {},
            body: encoded,
            anonymous: !!details.anonymous,
            timeout: details.timeout || 0,
            responseType: details.responseType || ''
          });
        })
        .catch(() => {
          __xhrPending.delete(id);
          try { details.onerror && details.onerror({ status: 0, statusText: 'encode-error', responseText: '', finalUrl: details.url }); } catch (e) {}
        });

      return {
        abort: function () {
          if (state.aborted) return;
          state.aborted = true;
          __xhrPending.delete(id);
          __sendToBackground({ type: 'IT_XHR_ABORT', id: id });
          try { details.onabort && details.onabort({ status: 0, statusText: 'abort' }); } catch (e) {}
        }
      };
    };
  }

  globalThis.GM_xmlhttpRequest = globalThis.GM_xmlHttpRequest = __buildXhrShim();

  /* ---------------- DOM 辅助 ---------------- */
  globalThis.GM_addStyle = function (css) {
    const el = document.createElement('style');
    el.textContent = css;
    const parent = document.head || document.documentElement;
    if (parent) parent.appendChild(el);
    return el;
  };

  globalThis.GM_addElement = function (parent, tagName, attributes) {
    const el = document.createElement(tagName);
    if (attributes) {
      for (const k of Object.keys(attributes)) {
        try {
          if (k === 'textContent') el.textContent = attributes[k];
          else el.setAttribute(k, attributes[k]);
        } catch (e) {}
      }
    }
    const p = parent || document.head || document.documentElement;
    if (p) p.appendChild(el);
    return el;
  };

  /* ---------------- 标签页 ---------------- */
  globalThis.GM_openInTab = function (url, options) {
    const active = !(options && (options.active === false || options.background));
    __sendToBackground({ type: 'IT_OPEN_TAB', url: String(url), active: active });
  };

  /* ---------------- 油猴菜单 -> 扩展图标右键菜单 ---------------- */
  const __menuFns = new Map();
  globalThis.GM_registerMenuCommand = function (name, fn) {
    name = String(name);
    __menuFns.set(name, fn);
    __sendToBackground({ type: 'IT_MENU_REGISTER', name: name });
  };

  /* ---------------- background 回包 ---------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'IT_XHR_EVENT') {
      const p = __xhrPending.get(msg.id);
      if (!p) return;
      const d = p.details;
      try {
        if (msg.event === 'chunk') {
          // 流式：模拟 XHR onprogress，responseText 持续增长
          p.accText += msg.text || '';
          if (d.onprogress) d.onprogress({
            status: msg.status, statusText: '',
            responseHeaders: msg.headers || '',
            responseText: p.accText, response: p.accText,
            finalUrl: msg.finalUrl || d.url,
            lengthComputable: false, loaded: p.accText.length, total: 0,
            readyState: 3
          });
        } else if (msg.event === 'load') {
          __xhrPending.delete(msg.id);
          let response = msg.text || '';
          if (msg.binaryB64 != null) {
            const bytes = __b64ToBytes(msg.binaryB64);
            if (d.responseType === 'blob') response = new Blob([bytes]);
            else if (d.responseType === 'arraybuffer') response = bytes.buffer;
            else response = msg.binaryB64; // base64：原样透传
          }
          if (d.onload) d.onload({
            status: msg.status, statusText: msg.statusText || '',
            responseHeaders: msg.headers || '',
            responseText: msg.text || '',
            response: response,
            finalUrl: msg.finalUrl || d.url,
            readyState: 4
          });
        } else if (msg.event === 'error') {
          __xhrPending.delete(msg.id);
          if (d.onerror) d.onerror({ status: msg.status || 0, statusText: 'error', responseText: '', finalUrl: d.url });
        } else if (msg.event === 'timeout') {
          __xhrPending.delete(msg.id);
          if (d.ontimeout) d.ontimeout({ status: 0, statusText: 'timeout', finalUrl: d.url });
          else if (d.onerror) d.onerror({ status: 0, statusText: 'timeout', finalUrl: d.url });
        }
      } catch (e) {}
      return;
    }

    if (msg.type === 'IT_MENU_CLICK') {
      const fn = __menuFns.get(msg.name);
      if (fn) { try { fn(); } catch (e) {} }
      return;
    }
  });
})();
