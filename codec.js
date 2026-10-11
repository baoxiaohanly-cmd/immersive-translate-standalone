/* codec.js — 请求体编解码（纯函数，无 chrome 依赖）
 * 用途：在 content script 与 background SW 之间传递 Blob / File / FormData /
 * ArrayBuffer 等二进制请求体。Chrome 扩展消息通道不保证结构化克隆语义，
 * 因此全部显式编码为 base64 JSON 后再传输，对端再还原。
 *
 * 加载方式：
 *  - content script：在 manifest 的 js 列表中排在 gm-shim.js 之前
 *  - background SW：顶部 importScripts('codec.js')
 *  - node 单测：require / import 直接引用
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.ITCodec = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function b64encodeBytes(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // data -> 可 JSON 序列化的编码体（async：Blob 需要读 ArrayBuffer）
  async function encodeBody(data) {
    if (data == null) return { kind: 'none' };
    if (typeof data === 'string') return { kind: 'text', data };
    if (data instanceof ArrayBuffer) {
      return { kind: 'buffer', data: b64encodeBytes(new Uint8Array(data)) };
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      const buf = new Uint8Array(await data.arrayBuffer());
      return {
        kind: 'blob',
        mime: data.type || '',
        name: typeof data.name === 'string' ? data.name : '',
        data: b64encodeBytes(buf),
      };
    }
    if (typeof FormData !== 'undefined' && data instanceof FormData) {
      const entries = [];
      for (const [k, v] of data.entries()) {
        entries.push([k, await encodeBody(v)]);
      }
      return { kind: 'formdata', entries };
    }
    if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
      return { kind: 'text', data: data.toString() };
    }
    // 兜底：未知类型转字符串，避免静默丢数据
    return { kind: 'text', data: String(data) };
  }

  // 编码体 -> fetch 可用的 body
  function decodeBody(b) {
    if (!b || b.kind === 'none') return undefined;
    if (b.kind === 'text') return b.data;
    if (b.kind === 'buffer') return b64ToBytes(b.data).buffer;
    if (b.kind === 'blob') {
      return new Blob([b64ToBytes(b.data)], { type: b.mime || '' });
    }
    if (b.kind === 'formdata') {
      const fd = new FormData();
      for (const [k, v] of b.entries) {
        const dv = decodeBody(v);
        // 还原 File 文件名（encode 时把 name 带过来了）
        if (v && v.kind === 'blob' && v.name) fd.append(k, dv, v.name);
        else fd.append(k, dv);
      }
      return fd;
    }
    return undefined;
  }

  return { b64encodeBytes, b64ToBytes, encodeBody, decodeBody };
});
