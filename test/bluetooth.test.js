// bluetooth.test.js — device-free tests for the Bluetooth bridge path.
//
// The real device layer is a native RFCOMM socket (Android), which needs two
// physical phones and cannot run in Node or on an emulator. This verifies the JS
// glue directly above it — the base64 bridge (b64/unb64), BridgeTransport, and a
// full Host<->Client round trip over a simulated RFCOMM byte pipe — so a
// transport bug is caught without any Bluetooth hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { b64, unb64, BridgeTransport } from '../src/bt/bridge.js';
import { Host } from '../src/engine/host.js';
import { Client } from '../src/engine/client.js';
import { waitFor } from './helpers.mjs';

// Simulate two RFCOMM sockets joined by a base64 relay (the native side turns
// bytes into base64 for the WebView; the JS side decodes it back).
function makeBtPair() {
  const a = new BridgeTransport(null, null);
  const b = new BridgeTransport(null, null);
  const relay = (to, bytes) => {
    const encoded = b64(bytes);      // native: bytes -> base64
    const decoded = unb64(encoded);  // JS:     base64 -> bytes
    setTimeout(() => { if (to.onMessage) to.onMessage(decoded); }, 0);
  };
  a._sendBytes = (bytes) => relay(b, bytes);
  b._sendBytes = (bytes) => relay(a, bytes);
  a._closeFn = () => { if (b.onDisconnect) b.onDisconnect(); };
  b._closeFn = () => { if (a.onDisconnect) a.onDisconnect(); };
  return [a, b];
}

test('b64/unb64 round-trips arbitrary bytes (ASCII + UTF-8 + binary)', () => {
  const cases = [
    [0x00, 0x01, 0x7f, 0x80, 0xff],
    Array.from(new TextEncoder().encode('你好, UNO! 🎉')),
    new Array(300).fill(0).map((_, i) => i & 0xff),
  ];
  for (const arr of cases) {
    const bytes = new Uint8Array(arr);
    assert.deepEqual(Array.from(unb64(b64(bytes))), Array.from(bytes));
  }
});

test('BridgeTransport.send forwards bytes and close() runs teardown', () => {
  let sent = null;
  let closed = false;
  const t = new BridgeTransport((b) => { sent = b; }, () => { closed = true; });
  const bytes = new Uint8Array([1, 2, 3]);
  t.send(bytes);
  assert.equal(sent, bytes);
  t.close();
  assert.equal(closed, true);
});

test('host + guest sync over a simulated Bluetooth byte pipe', async () => {
  const [hostT, guestT] = makeBtPair();
  const host = new Host({ game: 'uno', playerName: '主机', options: { unoPenalty: true } });
  host.addTransport(hostT);
  const client = new Client({ transport: guestT });
  const inbox = [];
  let latest = null;
  let lobby = null;
  client.onMessage = (m) => {
    inbox.push(m);
    if (m.t === 'state') latest = m.view;
    if (m.t === 'lobby') lobby = m;
  };

  // client -> host: join
  client.join('玩家');
  await waitFor(() => lobby, { label: 'guest received a lobby broadcast' });
  assert.equal(lobby.seats.length, 2, 'two seats in lobby');
  assert.equal(lobby.you, 1, 'guest is seat 1');

  // host -> all: start
  host.startGame();
  await waitFor(() => latest && latest.phase === 'playing', { label: 'game started' });
  assert.equal(latest.hand.length, 7, 'guest has 7 cards');
  assert.deepEqual(latest.counts, [7, 7], 'public counts agree');

  // client -> host -> client: a chat relay proves the full byte round trip
  client.send({ t: 'chat', text: '你好 👋' });
  await waitFor(() => inbox.some((m) => m.t === 'chat' && /👋/.test(m.text)), { label: 'chat relayed back to the guest' });
});

test('guest disconnect during lobby removes the seat and its transport', async () => {
  const [hostT, guestT] = makeBtPair();
  const host = new Host({ game: 'uno', playerName: '主机' });
  host.addTransport(hostT);
  const client = new Client({ transport: guestT });
  client.join('玩家');
  await waitFor(() => host.game.players.length === 2, { label: 'guest joined' });
  assert.equal(host.guests.size, 1);

  client.close();
  await waitFor(() => host.game.players.length === 1 && host.guests.size === 0, { label: 'seat + transport removed' });
});
