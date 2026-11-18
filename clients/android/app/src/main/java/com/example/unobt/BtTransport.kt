package com.example.unobt

/**
 * Transport contract shared by the classic SPP service and the BLE GATT service.
 *
 * The JS side only ever talks to BtJsBridge, so adding a third platform means
 * implementing this exact surface and injecting the same window.UnoBtAndroid
 * object name; no WebView asset changes are needed.
 */
interface BtTransport {
    val role: String // "host" | "guest"
    fun deviceName(): String
    fun openServer()
    fun closeServer()
    fun connect()
    fun sendToChannel(channelId: Int, b64Data: String)
    fun closeChannel(channelId: Int)
    fun sendToHost(b64Data: String)
    fun disconnect()
}
