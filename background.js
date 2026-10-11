/* background.js — MV3 service worker
 * 职责：
 *  1. 代理 GM_xmlhttpRequest：用 fetch 发跨域请求（绕过页面 CORS），支持流式分块回传
 *  2. GM_openInTab：新标签页打开链接
 *  3. GM_registerMenuCommand：映射为扩展图标右键菜单
 */
'use strict';

const controllers = new Map(); // xhr id -> AbortController
const menuNames = new Set();

// SW 重启后清理旧菜单，等待各页面 content script 重新注册
try {
  chrome.runtime.onStartup.addListener(() => {
    menuNames.clear();
    chrome.contextMenus.removeAll().catch(() => {});
  });
} catch (e) {}
// 安装/更新时也清理一次
try { chrome.contextMenus.removeAll().catch(() => {}); } catch (e) {}

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'IT_XHR':
      handleXhr(msg, sender);
      break;
    case 'IT_XHR_ABORT': {
      const c = controllers.get(msg.id);
      if (c) {
        try { c.abort(); } catch (e) {}
        controllers.delete(msg.id);
      }
      break;
    }
    case 'IT_OPEN_TAB':
      chrome.tabs.create({ url: msg.url, active: msg.active !== false }).catch(() => {});
      break;
    case 'IT_MENU_REGISTER':
      registerMenu(msg.name);
      break;
  }
});

function registerMenu(name) {
  if (!name || menuNames.has(name)) return;
  menuNames.add(name);
  try {
    chrome.contextMenus.create({
      id: 'it-menu::' + name,
      title: name,
      contexts: ['action']
    });
  } catch (e) {}
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const prefix = 'it-menu::';
  const menuId = info.menuItemId == null ? '' : String(info.menuItemId);
  if (menuId.startsWith(prefix) && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'IT_MENU_CLICK',
      name: menuId.slice(prefix.length)
    }).catch(() => {});
  }
});

async function handleXhr(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const ctrl = new AbortController();
  controllers.set(msg.id, ctrl);

  const post = (event) => {
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, Object.assign({ type: 'IT_XHR_EVENT', id: msg.id }, event))
      .catch(() => {});
  };

  let timer = null;
  let timedOut = false;
  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    controllers.delete(msg.id);
  };

  try {
    if (msg.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { ctrl.abort(); } catch (e) {}
      }, msg.timeout);
    }

    // fetch 不允许手动设置少数头部，过滤掉
    const headers = {};
    for (const k of Object.keys(msg.headers || {})) {
      const lk = k.toLowerCase();
      if (lk === 'content-length' || lk === 'host' || lk === 'connection') continue;
      headers[k] = msg.headers[k];
    }

    const res = await fetch(msg.url, {
      method: msg.method,
      headers: headers,
      body: (msg.method === 'GET' || msg.method === 'HEAD')
        ? undefined
        : (msg.data == null ? undefined : msg.data),
      credentials: msg.anonymous ? 'omit' : 'include',
      redirect: 'follow',
      signal: ctrl.signal
    });

    const harr = [];
    res.headers.forEach((v, k) => harr.push(k + ': ' + v));
    const headerStr = harr.join('\r\n');
    const finalUrl = res.url || msg.url;
    const rt = msg.responseType || '';

    if (rt === 'stream') {
      // 流式：按块把文本发回 content script，模拟 XHR onprogress
      post({ event: 'chunk', status: res.status, headers: headerStr, finalUrl: finalUrl, text: '' });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const t = decoder.decode(value, { stream: true });
          if (t) post({ event: 'chunk', status: res.status, headers: headerStr, finalUrl: finalUrl, text: t });
        }
      } finally {
        try { reader.releaseLock(); } catch (e) {}
      }
      const tail = decoder.decode();
      if (tail) post({ event: 'chunk', status: res.status, headers: headerStr, finalUrl: finalUrl, text: tail });
      post({ event: 'load', status: res.status, statusText: res.statusText, headers: headerStr, text: '', finalUrl: finalUrl });
    } else if (rt === 'arraybuffer' || rt === 'blob' || rt === 'base64') {
      const buf = await res.arrayBuffer();
      post({
        event: 'load', status: res.status, statusText: res.statusText,
        headers: headerStr, text: '', binaryB64: b64encode(buf), finalUrl: finalUrl
      });
    } else {
      // text / json / '' / raw / HEAD 等：统一按文本回传
      const text = await res.text();
      post({
        event: 'load', status: res.status, statusText: res.statusText,
        headers: headerStr, text: text, finalUrl: finalUrl
      });
    }
  } catch (e) {
    post({ event: timedOut ? 'timeout' : 'error', status: 0 });
  } finally {
    cleanup();
  }
}
