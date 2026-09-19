// protocol.test.js — wire framing and the stream-aware decoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, decodeSingle, FrameDecoder } from '../src/engine/protocol.js';

test('encode/decode round-trips a message', () => {
  const msg = { t: 'act', kind: 'play', cardId: 'red7' };
  const bytes = encodeMessage(msg);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(decodeSingle(bytes), msg);
});

test('framing pads the length prefix correctly', () => {
  const bytes = encodeMessage({ t: 'join', name: 'A' });
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(0, false), bytes.length - 4);
});

test('FrameDecoder reassembles a frame split across chunks', () => {
  const bytes = encodeMessage({ t: 'chat', text: '你好，世界' }); // utf8 + length
  const dec = new FrameDecoder();
  // send it one byte at a time
  let out = [];
  for (let i = 0; i < bytes.length; i++) {
    out = out.concat(dec.push(bytes.subarray(i, i + 1)));
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].t, 'chat');
  assert.equal(out[0].text, '你好，世界');
});

test('FrameDecoder returns multiple messages from one chunk', () => {
  const a = encodeMessage({ t: 'a' });
  const b = encodeMessage({ t: 'b' });
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  const out = new FrameDecoder().push(combined);
  assert.deepEqual(out.map((m) => m.t), ['a', 'b']);
});

test('FrameDecoder ignores trailing partial bytes', () => {
  const bytes = encodeMessage({ t: 'x' });
  const dec = new FrameDecoder();
  const out = dec.push(bytes.subarray(0, bytes.length - 2)); // missing last 2 bytes
  assert.equal(out.length, 0);
  const fin = dec.push(bytes.subarray(bytes.length - 2));
  assert.deepEqual(fin.map((m) => m.t), ['x']);
});
