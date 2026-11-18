# 跨平台客户端（Android / iOS / HarmonyOS）

三端共用 `board-games/app/src/main/assets/www` 里的 WebView 资源，**逐字节一致**；修改资源后先运行：

```bash
node clients/sync-assets.mjs
```

三端都把原生桥暴露为 `window.UnoBtAndroid`（方法名不变），原生回调仍是 `UnoBtOnJoin/Data/Disconnect/Connected/Status/LlmResponse`。BLE 契约见 `docs/09-跨平台蓝牙联机协议.md`。

| 平台 | 说明 | 本机编译 |
|---|---|---|
| `android/` | uno-bt 工程镜像；主机 = BLE Peripheral，客机 = Central | ✅ Gradle 8.9 + JDK 17 |
| `ios/` | SwiftUI + WKWebView + CoreBluetooth，XcodeGen 工程 | ❌ 需 macOS/Xcode 15+ |
| `harmony/` | DevEco 5+ / ArkTS WebView + `@ohos.bluetooth.ble` | ❌ 需 DevEco Studio |

Android 构建注意：源工程在中文路径下会让 Kotlin 编译器失败；复制到 ASCII 路径（如 `C:/Temp/unobt-ble-build`），设置 `JAVA_HOME=JDK17`、`GRADLE_USER_HOME` 为 ASCII 路径，`local.properties` 的 SDK 路径也用 ASCII junction，再运行 `gradle assembleDebug`。

`tests/deterministic/ble-protocol.test.ts` 是零依赖静态闸门：三端 UUID、桥方法、回调名任一处漂移即失败。iOS / HarmonyOS 源码**未在真机编译验证**，首次上真机应重点核对蓝牙权限弹窗、BLE 分片吞吐与后台限制。
