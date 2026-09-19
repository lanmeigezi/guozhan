// discovery.test.js — unit tests for the LAN discovery module (UDP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnnouncer, discoverRooms, localAddresses, broadcastTargets,
  PROBE, REPLY, DEFAULT_DISCOVERY_PORT,
} from '../src/lan/discovery.mjs';

test('discovery: a probe reaches the announcer and comes back as a room', async () => {
  const info = { name: 'test room', game: 'uno', http: 'http://127.0.0.1:1/', ws: 'ws://127.0.0.1:1/ws', players: 0, max: 8 };
  const ann = await createAnnouncer({ info, port: 0, host: '127.0.0.1' });
  try {
    const rooms = await discoverRooms({ port: ann.port, timeoutMs: 500, targets: ['127.0.0.1'] });
    assert.equal(rooms.length, 1, 'exactly one room answered');
    assert.equal(rooms[0].t, REPLY);
    assert.equal(rooms[0].ws, info.ws);
    assert.equal(rooms[0].name, 'test room');
    assert.equal(rooms[0].game, 'uno');
  } finally {
    await ann.close();
  }
});

test('discovery: info may be a function, so player counts stay live', async () => {
  let players = 0;
  const ann = await createAnnouncer({
    info: () => ({ name: 'live', game: 'uno', ws: 'ws://x/ws', players }),
    port: 0, host: '127.0.0.1',
  });
  try {
    const first = await discoverRooms({ port: ann.port, timeoutMs: 400, targets: ['127.0.0.1'] });
    players = 3;
    const second = await discoverRooms({ port: ann.port, timeoutMs: 400, targets: ['127.0.0.1'] });
    assert.equal(first[0].players, 0);
    assert.equal(second[0].players, 3);
  } finally {
    await ann.close();
  }
});

test('discovery: with no announcer it returns an empty list and does not hang', async () => {
  const t0 = Date.now();
  const rooms = await discoverRooms({ port: 1, timeoutMs: 300, targets: ['127.0.0.1'] });
  assert.equal(rooms.length, 0);
  assert.ok(Date.now() - t0 < 3000, 'resolved within the timeout budget');
});

test('discovery: the announcer ignores junk datagrams', async () => {
  const ann = await createAnnouncer({ info: { name: 'x', game: 'uno', ws: 'ws://x/ws' }, port: 0, host: '127.0.0.1' });
  const dgram = await import('node:dgram');
  const s = dgram.createSocket('udp4');
  try {
    await new Promise((r) => s.bind(0, '127.0.0.1', r));
    s.send(Buffer.from('not json at all'), ann.port, '127.0.0.1', () => {});
    s.send(Buffer.from('{"t":"WRONG_TYPE"}'), ann.port, '127.0.0.1', () => {});
    const rooms = await discoverRooms({ port: ann.port, timeoutMs: 400, targets: ['127.0.0.1'] });
    assert.equal(rooms.length, 1, 'still answers the real probe afterwards');
  } finally {
    try { s.close(); } catch (_) {}
    await ann.close();
  }
});

test('discovery: helpers describe this machine and its broadcast targets', () => {
  assert.equal(PROBE, 'TTG_DISCOVER');
  assert.equal(typeof DEFAULT_DISCOVERY_PORT, 'number');
  assert.ok(Array.isArray(localAddresses()));
  const targets = broadcastTargets();
  assert.ok(targets.includes('255.255.255.255'), 'global broadcast is always a target');
});
