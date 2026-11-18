# iOS 客户端（SwiftUI + WKWebView + CoreBluetooth）

## 状态

**源码已生成，未在本机编译**：当前构建机是 Windows，没有 Xcode / macOS。必须在 macOS 14+ / Xcode 15+ 上完成编译与真机联机验证。

## 生成工程与编译

```bash
# 1. 同步 WebView 静态资源（与 Android/HarmonyOS 逐字节一致）
node clients/sync-assets.mjs

# 2. 用 XcodeGen 生成 .xcodeproj（若未安装：brew install xcodegen）
cd clients/ios && xcodegen generate

# 3. Xcode 打开 clients/ios/BoardGames.xcodeproj，选开发者团队后编译到真机
```

`Info.plist` 已声明 `NSBluetoothAlwaysUsageDescription` / `NSBluetoothPeripheralUsageDescription`。

## 桥接方式

- 原生对象名仍是 `window.UnoBtAndroid`，JS 资源零修改。
- WKWebView 没有 Android 那种同步 `addJavascriptInterface`：这里在 `WKUserContentController` 注册 messageHandler，并用 **document start 脚本**注入同名 JS 对象；同步 getter 从 `window.__unoBtConfig` 读，异步方法 `postMessage`。
- 原生 → JS 仍调用 `window.UnoBtOnJoin/Data/Disconnect/Connected/Status/LlmResponse`。

## BLE

`BleTransport.swift` 严格遵守 `docs/09-跨平台蓝牙联机协议.md`：

- Host = `CBPeripheralManager` + 广播 service UUID；每个订阅 TX 的 Central 分配一个 channelId。
- Guest = `CBCentralManager` 按 service UUID 扫描 → 连接 → 订阅 TX → `UnoBtOnConnected()`。
- 写入按 `maximumWriteValueLength` 分片并按顺序发出；通知队列在 `peripheralManagerIsReady(toUpdateSubscribers:)` 里续传。

## 已知限制（未测项）

- iOS 真机需要蓝牙权限弹窗；首次使用请允许。
- iPhone 后台 BLE 会被系统限制；请保持前台联机。
- -room 模式在 WKWebView 里走 JS WebSocket；未在本机验证服务端连通性。
