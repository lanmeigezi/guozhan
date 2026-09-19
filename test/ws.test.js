// ws.test.js — unit tests for the zero-dependency WebSocket framing used by the
// remote (LAN/internet) room server. verify-socket.mjs exercises the whole room
// end-to-end; these cover the RFC 6455 frame codec (length boundaries, masking,
// multiple frames per chunk, control opcodes) directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, parseFrame } from '../src/engine/ws.js';

test('buildFrame small payload uses a 2-byte header with FIN+binary', () => {
  const f = buildFrame('hi');
  assert.equal(f[0], 0x82);
  assert.equal(f.length, 2 + 2);
});

test('buildFrame 126..65535 uses the extended 16-bit length', () => {
  const payload = Buffer.alloc(1000, 0x41);
  const f = buildFrame(payload);
  assert.equal(f[1] & 0x7f, 126);
  assert.equal(f.readUInt16BE(2), 1000);
  assert.equal(f.length, 4 + 1000);
});

test('buildFrame >=65536 uses the extended 64-bit length', () => {
  const payload = Buffer.alloc(70000, 0x42);
  const f = buildFrame(payload);
  assert.equal(f[1] & 0x7f, 127);
  assert.equal(Number(f.readBigUInt64BE(2)), 70000);
  assert.equal(f.length, 10 + 70000);
});

test('masked frame round-trips through parseFrame', () => {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const payload = Buffer.from('masked payload');
  const parsed = parseFrame(buildFrame(payload, 0x2, mask));
  assert.ok(parsed);
  assert.equal(parsed.opcode, 0x2);
  assert.equal(parsed.payload.toString(), 'masked payload');
});

test('parseFrame returns null for a partial header', () => {
  assert.equal(parseFrame(Buffer.from([0x82])), null);
});

test('parseFrame returns rest for multiple frames in one chunk', () => {
  const a = buildFrame('one');
  const b = buildFrame('two');
  const parsed = parseFrame(Buffer.concat([a, b]));
  assert.ok(parsed);
  assert.equal(parsed.payload.toString(), 'one');
  assert.equal(parsed.rest.length, b.length);
});

test('parseFrame exposes ping / pong / close opcodes', () => {
  assert.equal(parseFrame(buildFrame('ping', 0x9)).opcode, 0x9);
  assert.equal(parseFrame(buildFrame('pong', 0xA)).opcode, 0xA);
  assert.equal(parseFrame(buildFrame('', 0x8)).opcode, 0x8);
});
