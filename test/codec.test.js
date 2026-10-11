/* codec 单测：node --test test/codec.test.js */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeBody, decodeBody, b64encodeBytes, b64ToBytes } = require('../codec.js');

test('text roundtrip', async () => {
  const enc = await encodeBody('hello world');
  assert.equal(enc.kind, 'text');
  assert.equal(decodeBody(enc), 'hello world');
});

test('null/undefined -> none', async () => {
  assert.equal((await encodeBody(null)).kind, 'none');
  assert.equal((await encodeBody(undefined)).kind, 'none');
  assert.equal(decodeBody({ kind: 'none' }), undefined);
  assert.equal(decodeBody(null), undefined);
});

test('ArrayBuffer roundtrip', async () => {
  const src = new Uint8Array([0, 1, 2, 250, 255]).buffer;
  const enc = await encodeBody(src);
  assert.equal(enc.kind, 'buffer');
  // 编码体必须是纯 JSON
  JSON.stringify(enc);
  const back = decodeBody(enc);
  assert.ok(back instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(back), new Uint8Array([0, 1, 2, 250, 255]));
});

test('Blob roundtrip (mime preserved)', async () => {
  const blob = new Blob(['<pdf>'], { type: 'application/pdf' });
  const enc = await encodeBody(blob);
  assert.equal(enc.kind, 'blob');
  assert.equal(enc.mime, 'application/pdf');
  JSON.stringify(enc);
  const back = decodeBody(enc);
  assert.ok(back instanceof Blob);
  assert.equal(back.type, 'application/pdf');
  assert.equal(await back.text(), '<pdf>');
});

test('File roundtrip (name preserved)', async () => {
  const file = new File(['data'], 'doc.pdf', { type: 'application/pdf' });
  const enc = await encodeBody(file);
  assert.equal(enc.kind, 'blob');
  assert.equal(enc.name, 'doc.pdf');
  const back = decodeBody(enc);
  const fd = new FormData();
  fd.append('f', back, enc.name);
  assert.equal(fd.get('f').name, 'doc.pdf');
});

test('FormData roundtrip (mixed fields)', async () => {
  const fd = new FormData();
  fd.append('text', 'hi');
  fd.append('num', '42');
  fd.append('file', new Blob(['x'.repeat(1000)], { type: 'text/plain' }), 'a.txt');
  const enc = await encodeBody(fd);
  assert.equal(enc.kind, 'formdata');
  assert.equal(enc.entries.length, 3);
  JSON.stringify(enc); // 必须可 JSON 序列化
  const back = decodeBody(enc);
  assert.ok(back instanceof FormData);
  assert.equal(back.get('text'), 'hi');
  assert.equal(back.get('num'), '42');
  const f = back.get('file');
  assert.equal(f.name, 'a.txt');
  assert.equal((await f.text()).length, 1000);
});

test('URLSearchParams -> text', async () => {
  const enc = await encodeBody(new URLSearchParams({ a: '1', b: 'x y' }));
  assert.equal(enc.kind, 'text');
  assert.equal(decodeBody(enc), 'a=1&b=x+y');
});

test('b64 helpers invert each other', () => {
  const bytes = new Uint8Array([0, 127, 128, 255, 1, 2, 3]);
  assert.deepEqual(b64ToBytes(b64encodeBytes(bytes)), bytes);
});

test('large blob (1MB) roundtrip', async () => {
  const big = new Uint8Array(1024 * 1024).fill(0xab);
  const enc = await encodeBody(new Blob([big]));
  JSON.stringify(enc);
  const back = new Uint8Array(await decodeBody(enc).arrayBuffer());
  assert.equal(back.length, big.length);
  assert.equal(back[0], 0xab);
  assert.equal(back[back.length - 1], 0xab);
});
