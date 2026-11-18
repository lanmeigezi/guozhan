/**
 * 跨平台 BLE 协议的静态一致性闸门（零依赖，Node 直接跑）。
 *
 * 三端源码不能在本机同时编译（无 Xcode / DevEco），所以这里把
 * docs/09 里约定的 UUID、JS 桥方法名与包名做成可复跑断言：
 * 任何一端改了 UUID/漏了桥方法，或 WebView 资源同步脚本丢了，本测试即红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const UUIDS = [
  'a6b1c0de-0001-4f52-9a11-0a1b2c3d4e5f',
  'a6b1c0de-0002-4f52-9a11-0a1b2c3d4e5f',
  'a6b1c0de-0003-4f52-9a11-0a1b2c3d4e5f',
] as const;

const BRIDGE_METHODS = [
  'getRole', 'getDeviceName', 'getRoomUrl', 'getGame',
  'openServer', 'closeServer', 'findAndConnect', 'disconnect',
  'sendToChannel', 'closeChannel', 'sendToHost',
  'llmInfo', 'llmConfigure', 'llmClear', 'llmChat', 'civLlmChat',
] as const;

const CALLBACKS = [
  'UnoBtOnJoin', 'UnoBtOnData', 'UnoBtOnDisconnect',
  'UnoBtOnConnected', 'UnoBtOnStatus', 'UnoBtOnLlmResponse',
] as const;

test('三端 UUID 与协议文档一致（大小写不敏感）', () => {
  const doc = read('docs/09-跨平台蓝牙联机协议.md').toLowerCase();
  const kt = read('clients/android/app/src/main/java/com/example/unobt/BleTransport.kt').toLowerCase();
  const swift = read('clients/ios/BoardGames/BleConstants.swift').toLowerCase();
  const ets = read('clients/harmony/entry/src/main/ets/viewmodel/BleConstants.ets').toLowerCase();
  for (const file of [doc, kt, swift, ets]) {
    for (const uuid of UUIDS) assert.ok(file.includes(uuid), `缺少 UUID ${uuid}`);
  }
});

test('iOS / 鸿蒙桥接暴露全部原生方法', () => {
  const swift = read('clients/ios/BoardGames/NativeBridge.swift');
  const ets = read('clients/harmony/entry/src/main/ets/pages/Index.ets');
  const kt = read('clients/android/app/src/main/java/com/example/unobt/BtJsBridge.kt');
  for (const method of BRIDGE_METHODS) {
    assert.ok(swift.includes(method), `iOS 桥缺少 ${method}`);
    assert.ok(ets.includes(`'${method}'`), `鸿蒙 javaScriptProxy 缺少 ${method}`);
    assert.ok(kt.includes(method), `Android 桥缺少 ${method}`);
  }
});

test('三端原生→JS 回调名一致，且 WebView 资源零改名', () => {
  const www = read('board-games/app/src/main/assets/www/app.js');
  const files = [
    'clients/android/app/src/main/java/com/example/unobt/BluetoothService.kt',
    'clients/ios/BoardGames/BleTransport.swift',
    'clients/harmony/entry/src/main/ets/viewmodel/BleTransport.ets',
    'clients/harmony/entry/src/main/ets/viewmodel/NativeBridge.ets',
  ].map(read);
  for (const cb of CALLBACKS) {
    assert.ok(www.includes(cb), `WebView 不使用回调 ${cb}`);
    assert.ok(files.some((f) => f.includes(cb)), `没有原生端实现 ${cb}`);
  }
});

test('资源同步脚本存在且覆盖三端目标目录', () => {
  const script = read('clients/sync-assets.mjs');
  for (const target of [
    'clients', 'android', 'ios', 'BoardGames', 'harmony', 'rawfile', 'www',
  ]) assert.ok(script.includes(target), `同步脚本缺少 ${target}`);
});

test('iOS / 鸿蒙不使用需要 MFi 的经典蓝牙 SPP', () => {
  for (const p of [
    'clients/ios/BoardGames/BleTransport.swift',
    'clients/harmony/entry/src/main/ets/viewmodel/BleTransport.ets',
  ]) {
    const src = read(p);
    assert.ok(!/\bRFCOMM\b|\bSPP\b/.test(src), `${p} 不应出现 SPP/RFCOMM`);
  }
});
