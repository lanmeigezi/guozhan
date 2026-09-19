// js-bridge.js — the JS bridge layer for the Bluetooth online-play module.
// Runs inside the Android WebView. Two roles:
//   HOST : opens a Bluetooth server; each incoming socket becomes a guest channel.
//   GUEST: connects to a chosen host device; a single channel (id 0).
// The core (Host/Client) is transport-agnostic; this file only bridges the
// native Bluetooth byte stream into that core's `Transport` interface.
//
// Native interface (injected at window.UnoBtAndroid by BtJsBridge.kt):
//   getRole() -> 'host' | 'guest' ; getDeviceName() -> string
//   openServer() / closeServer()            (host)
//   findAndConnect() / disconnect()          (guest)
//   sendToChannel(channelId, base64) / closeChannel(channelId)   (host)
//   sendToHost(base64)                       (guest)
// Native calls back into:
//   UnoBtOnJoin(channelId)   UnoBtOnData(channelId, base64)
//   UnoBtOnDisconnect(channelId)   UnoBtOnConnected()   UnoBtOnStatus(text)

import { Transport } from '../engine/transport.js';
import { Host } from '../engine/host.js';
import { Client } from '../engine/client.js';

// ---- base64 helpers (bytes <-> string for the native bridge) ----
export function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- a Transport over one Bluetooth socket ----
// Bridges bytes to the native layer (base64) and inbound bytes back to onMessage.
export class BridgeTransport extends Transport {
  constructor(sendBytes, closeFn) {
    super();
    this._sendBytes = sendBytes;
    this._closeFn = closeFn;
  }
  send(bytes) { this._sendBytes(bytes); }
  close() { if (this._closeFn) this._closeFn(); }
}

// ---- module state ----
const state = { role: null, game: null, host: null, client: null, clientTransport: null };
const channels = new Map(); // host: channelId -> BridgeTransport
let onUiUpdate = null;      // fn(payload) the UI sets (lobby/state/error/chat)

// ================= native callbacks (Kotlin -> JS) =================
export function UnoBtOnJoin(channelId) {
  if (state.role !== 'host') return;
  const t = new BridgeTransport(
    (bytes) => window.UnoBtAndroid.sendToChannel(channelId, b64(bytes)),
    () => window.UnoBtAndroid.closeChannel(channelId)
  );
  channels.set(channelId, t);
  state.host.addTransport(t);
  if (onUiUpdate) onUiUpdate({ t: 'status', text: '有玩家正在加入…' });
}
export function UnoBtOnData(channelId, b64str) {
  const bytes = unb64(b64str);
  if (state.role === 'host') {
    const t = channels.get(channelId);
    if (t && t.onMessage) t.onMessage(bytes);
  } else if (state.clientTransport && state.clientTransport.onMessage) {
    state.clientTransport.onMessage(bytes);
  }
}
export function UnoBtOnDisconnect(channelId) {
  const t = channels.get(channelId);
  if (t && t.onDisconnect) t.onDisconnect();
  channels.delete(channelId);
}
export function UnoBtOnConnected() {
  if (state.role !== 'guest') return;
  state.client.join(window.UnoBtAndroid.getDeviceName() || '玩家');
  if (onUiUpdate) onUiUpdate({ t: 'status', text: '已连接，等待主机开始…' });
}
export function UnoBtOnStatus(text) {
  if (onUiUpdate) onUiUpdate({ t: 'status', text });
}

// ================= boot =================
export function bootHost(gameKey, playerName) {
  state.role = 'host';
  state.game = gameKey || 'uno';
  state.host = new Host({ game: state.game, playerName: playerName || '主机', options: { unoPenalty: true } });
  state.host.onLocalUpdate = onUiUpdate;
  onUiUpdate({ t: 'lobby', seats: [{ seat: 0, name: playerName || '主机' }], you: 0, hostSeat: 0 });
  window.UnoBtAndroid.openServer();
}

export function bootGuest(hostAddress) {
  state.role = 'guest';
  state.clientTransport = new BridgeTransport(
    (bytes) => window.UnoBtAndroid.sendToHost(b64(bytes)),
    () => window.UnoBtAndroid.disconnect()
  );
  state.client = new Client({ transport: state.clientTransport });
  state.client.onMessage = (msg) => onUiUpdate && onUiUpdate(msg);
  state.client.onDisconnect = () => onUiUpdate && onUiUpdate({ t: 'status', text: '与主机断开连接' });
  window.UnoBtAndroid.findAndConnect();
}

// Export the bridge for the UI (window names must match what Kotlin calls into).
export function install(bridge, hostAddress) {
  window.UnoBtOnJoin = UnoBtOnJoin;
  window.UnoBtOnData = UnoBtOnData;
  window.UnoBtOnDisconnect = UnoBtOnDisconnect;
  window.UnoBtOnConnected = UnoBtOnConnected;
  window.UnoBtOnStatus = UnoBtOnStatus;
  window.UnoBtAndroid = bridge; // the object injected by the WebView (BtJsBridge)
  if (bridge.getRole() === 'host') bootHost(bridge.getGame && bridge.getGame(), bridge.getDeviceName());
  else bootGuest(hostAddress);
}
