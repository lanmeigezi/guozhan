package com.example.unobt

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.util.Base64
import android.util.Log
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Bluetooth Classic (RFCOMM) peer-to-peer transport.
 *
 * Host mode  : listens for incoming connections; each accepted socket becomes a
 *              numbered channel that the WebView game registers on.
 * Guest mode : connects to a pre-chosen host device (single channel id 0).
 *
 * The service is deliberately transport-only: it relays raw bytes as base64 to
 * and from the WebView. All UNO framing/rules stay in the JS core.
 */
class BluetoothService(
    private val context: Context,
    val role: String,                 // "host" | "guest"
    private val hostAddress: String?, // guest-only: target device address
    private val onJs: (String) -> Unit
) {
    private var running = false
    private var waitingForBt = false
    private var nextChannel = 1
    private val connections = ConcurrentHashMap<Int, Connection>()
    @Volatile private var serverSocket: BluetoothServerSocket? = null

    // A per-socket writer that also consumes the inbound byte stream.
    inner class Connection(val channelId: Int, val socket: BluetoothSocket) {
        private val inStream = socket.inputStream
        private val outStream = socket.outputStream
        @Volatile private var closed = false

        fun start() {
            onJs("UnoBtOnJoin($channelId)")
            Thread({
                val buf = ByteArray(4096)
                try {
                    while (!closed) {
                        val n = inStream.read(buf)
                        if (n <= 0) break
                        val chunk = buf.copyOf(n)
                        onJs("UnoBtOnData($channelId, \"${b64(chunk)}\")")
                    }
                } catch (_: IOException) {
                    // stream closed
                } finally {
                    closed = true
                    connections.remove(channelId)
                    onJs("UnoBtOnDisconnect($channelId)")
                    closeQuietly()
                }
            }, "uno-bt-read-$channelId").also { it.isDaemon = true; it.start() }
        }

        @Synchronized
        fun write(data: ByteArray) {
            if (closed) return
            try {
                outStream.write(data)
                outStream.flush()
            } catch (_: IOException) {
                // dropped; reader thread will notice the close
            }
        }

        fun closeQuietly() {
            try { socket.close() } catch (_: IOException) {}
        }
    }

    // ---- Bluetooth access ----
    @SuppressLint("MissingPermission")
    fun adapter(): BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    @SuppressLint("MissingPermission")
    fun deviceName(): String =
        try { adapter()?.name ?: "UNO 设备" } catch (_: SecurityException) { "UNO 设备" }

    @SuppressLint("MissingPermission")
    fun bluetoothEnabled(): Boolean =
        try { adapter()?.isEnabled == true } catch (_: SecurityException) { false }

    // ---- Host mode ----
    @SuppressLint("MissingPermission")
    fun openServer() {
        if (role != "host") return
        val adapter = adapter() ?: run { onJs("UnoBtOnStatus(\"蓝牙不可用\")"); return }
        if (!bluetoothEnabled()) {
            onJs("UnoBtOnStatus(\"请先开启蓝牙，等待蓝牙开启后自动开始…\")")
            retryWhenEnabled()
            return
        }
        startServer(adapter)
    }

    @SuppressLint("MissingPermission")
    private fun retryWhenEnabled() {
        if (waitingForBt) return
        waitingForBt = true
        Thread({
            while (waitingForBt && !bluetoothEnabled()) {
                try { Thread.sleep(2500) } catch (_: InterruptedException) {}
            }
            waitingForBt = false
            if (bluetoothEnabled() && !running) {
                adapter()?.let { startServer(it) }
            }
        }, "uno-bt-bt-wait").also { it.isDaemon = true; it.start() }
    }

    @SuppressLint("MissingPermission")
    private fun startServer(adapter: BluetoothAdapter) {
        if (running) return
        running = true
        Thread({
            try {
                val ss = adapter.listenUsingInsecureRfcommWithServiceRecord(SERVICE_NAME, MY_UUID)
                serverSocket = ss
                try {
                    while (running) {
                        val socket = ss.accept()
                        if (socket != null) acceptConn(socket)
                    }
                } finally {
                    serverSocket = null
                    try { ss.close() } catch (_: IOException) {}
                }
            } catch (e: Exception) {
                val wasRunning = running
                running = false
                serverSocket = null
                if (wasRunning) {
                    log("server error: ${e.message}")
                    onJs("UnoBtOnStatus(\"主机服务断开\")")
                }
            }
        }, "uno-bt-server").also { it.isDaemon = true; it.start() }
    }

    @SuppressLint("MissingPermission")
    private fun acceptConn(socket: BluetoothSocket) {
        val channelId = nextChannel++
        val conn = Connection(channelId, socket)
        connections[channelId] = conn
        log("guest joined channel $channelId")
        conn.start()
    }

    // ---- Guest mode ----
    @SuppressLint("MissingPermission")
    fun connect() {
        if (role != "guest") return
        val adapter = adapter() ?: run { onJs("UnoBtOnStatus(\"蓝牙不可用\")"); return }
        val address = hostAddress ?: run { onJs("UnoBtOnStatus(\"没有选择主机\")"); return }
        onJs("UnoBtOnStatus(\"正在连接主机…\")")
        Thread({
            val connected = java.util.concurrent.atomic.AtomicBoolean(false)
            val timedOut = java.util.concurrent.atomic.AtomicBoolean(false)
            try {
                val device: BluetoothDevice = adapter.getRemoteDevice(address)
                val s = device.createInsecureRfcommSocketToServiceRecord(MY_UUID)
                // Watchdog: if the socket isn't connected after ~12s, close it to
                // cancel the potentially-blocking connect() and report a timeout.
                Thread({
                    try { Thread.sleep(CONNECT_TIMEOUT_MS) } catch (_: InterruptedException) {}
                    if (!connected.get() && !s.isConnected) {
                        timedOut.set(true)
                        try { s.close() } catch (_: IOException) {}
                    }
                }, "uno-bt-connect-timeout").also { it.isDaemon = true; it.start() }
                s.connect()
                connected.set(true)
                val conn = Connection(0, s)
                connections[0] = conn
                onJs("UnoBtOnConnected()")
                conn.start()
            } catch (e: Exception) {
                log("connect error: ${e.message} (timeout=${if (timedOut.get()) "yes" else "no"})")
                onJs("UnoBtOnStatus(\"连接失败：无法连接到主机，请确认主机已开始游戏\")")
            }
        }, "uno-bt-client").also { it.isDaemon = true; it.start() }
    }

    // ---- Data path (called from the JS bridge) ----
    fun sendToChannel(channelId: Int, b64Data: String) {
        val bytes = try { Base64.decode(b64Data, Base64.NO_WRAP) } catch (_: IllegalArgumentException) { return }
        connections[channelId]?.write(bytes)
    }

    fun closeChannel(channelId: Int) {
        connections.remove(channelId)?.closeQuietly()
    }

    fun closeServer() {
        running = false
        for ((_, c) in connections) c.closeQuietly()
        connections.clear()
        // Closing the listening socket unblocks ss.accept() so the server thread
        // can exit cleanly instead of leaking after the host stops hosting.
        try { serverSocket?.close() } catch (_: IOException) {}
        serverSocket = null
    }

    fun disconnect() {
        closeServer()
    }

    private fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)

    private fun log(m: String) { Log.i("UnoBT", m) }

    companion object {
        private const val SERVICE_NAME = "UNO-BT Game"
        // App-specific RFCOMM UUID (not the reserved SPP UUID) — more reliable for
        // device-to-device usage. Both host and guest must use the same value.
        private val MY_UUID: UUID = UUID.fromString("3b0f1e2a-9c5b-4a7d-8e6f-1a2b3c4d5e6f")
        private const val CONNECT_TIMEOUT_MS = 12000L
    }
}
