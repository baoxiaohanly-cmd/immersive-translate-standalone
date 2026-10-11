/* background.js — MV3 service worker
 * 职责：
 *  1. 代理 GM_xmlhttpRequest：用 fetch 发跨域请求（绕过页面 CORS），支持流式分块回传
 *  2. GM_openInTab：新标签页打开链接
 *  3. GM_registerMenuCommand：映射为扩展图标右键菜单
 *
 * 请求隔离：同一标签页内多 frame 的请求 ID 可能重复（各 frame 独立计数），
 * 因此内部以 `${tabId}:${frameId}:${id}` 为键管理 AbortController，
 * 回包时用 {frameId} 定向投递到来源 frame，避免串结果、误取消。
 */
'use strict';

try {
  importScripts('codec.js');
} catch (e) {
  console.error('[IT-SHIM] codec.js load failed:', e);
}

const controllers = new Map(); // `${tabId}:${frameId}:${id}` -> AbortController
const menuNames = new Set();

function reqKey(tabId, frameId, id) {
  return tabId + ':' + frameId + ':' + id;
}

// 右键菜单：Chrome 会在 SW 终止后保留已创建的菜单，因此只在安装/更新时清理重建。
// 之前版本在 SW 每次唤醒时都 removeAll()，导致菜单用着用着消失——已修复。
chrome.runtime.onInstalled.addListener(() => {
  menuNames.clear();
  try { chrome.contextMenus.removeAll().catch(() => {}); } catch (e) {}
});

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
  const tabId = sender.tab && sender.tab.id;
  const frameId = sender.frameId != null ? sender.frameId : 0;
  switch (msg.type) {
    case 'IT_XHR':
      handleXhr(msg, sender, tabId, frameId);
      break;
    case 'IT_XHR_ABORT': {
      const c = controllers.get(reqKey(tabId, frameId, msg.id));
      if (c) {
        try { c.abort(); } catch (e) {}
        controllers.delete(reqKey(tabId, frameId, msg.id));
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
  } catch (e) {
    // SW 重启后菜单仍在、内存去重丢失时可能报重复，按已有处理
  }
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

async function handleXhr(msg, sender, tabId, frameId) {
  const key = reqKey(tabId, frameId, msg.id);
  const ctrl = new AbortController();
  controllers.set(key, ctrl);

  const post = (event) => {
    if (tabId == null) return;
    const out = Object.assign({ type: 'IT_XHR_EVENT', id: msg.id }, event);
    // 定向投递到来源 frame：同页多 frame 的请求不再互相串扰
    const opts = frameId ? { frameId: frameId } : undefined;
    chrome.tabs.sendMessage(tabId, out, opts).catch(() => {});
  };

  let timer = null;
  let timedOut = false;
  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    controllers.delete(key);
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

    // 请求体：content script 已显式编码（codec.js），此处还原
    let body;
    if (msg.method !== 'GET' && msg.method !== 'HEAD') {
      try {
        body = self.ITCodec.decodeBody(msg.body);
      } catch (e) {
        post({ event: 'error', status: 0 });
        return;
      }
    }

    const res = await fetch(msg.url, {
      method: msg.method,
      headers: headers,
      body: body,
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
