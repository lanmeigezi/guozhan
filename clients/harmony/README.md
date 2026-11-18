# HarmonyOS 客户端（ArkTS + WebView + @ohos.bluetooth.ble）

## 状态

**源码已生成，未在本机编译**：构建机是 Windows，没有 DevEco Studio / hdc。需在 DevEco Studio 5.0+ 打开 `clients/harmony`，配签名后编译到真机。

## 同步资源与编译

```bash
node clients/sync-assets.mjs       # 把 www 同步到 entry/src/main/resources/rawfile/www
# DevEco Studio 打开 clients/harmony → Build → Build HAP(s)
```

`module.json5` 已声明 `ohos.permission.ACCESS_BLUETOOTH`、定位（扫描需要）与 `INTERNET`。

## 桥接与 BLE

- `Index.ets` 通过 `javaScriptProxy` 注入 `window.UnoBtAndroid`，同步方法与 Android 同名；加载 `rawfile/www/index.html`。
- Host = `ble.createGattServer()` + 广播 service UUID；Guest = `createGattClientDevice()` + 订阅 TX notify。UUID / channelId / 分片规则严格按 `docs/09-跨平台蓝牙联机协议.md`。
- Base64 用纯 TS 实现，避免依赖 ArkTS 运行时的 `btoa/atob`。

## 已知限制（未测项）

- DevEco 真机权限申请弹窗、BLE 分片吞吐、`file:///etc/rawfile/www/index.html` 加载路径均未在真机验证。
- 平台 API（`GattServer.on('characteristicWriteRequest')` 等）依据华为官方 BLE 文档；如 SDK 小版本签名变化，按编译错误微调。
- 三端协议一致性由 `tests/deterministic/ble-protocol.test.ts` 静态闸门覆盖。
