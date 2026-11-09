package com.example.unobt

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Hosts the game in a WebView and wires the JS core to the transport.
 * Transport can be either the native Bluetooth service ("host"/"guest") or a
 * remote WebSocket room server ("room" + roomUrl) for LAN/internet play.
 */
class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var service: BluetoothService? = null   // null in room mode
    private var roomUrl: String? = null
    private var game: String = "uno"
    private val ready = AtomicBoolean(false)
    private val pendingJs = CopyOnWriteArrayList<String>() // scripts queued until the page is ready

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val role = intent.getStringExtra(EXTRA_ROLE) ?: "host"
        val hostAddress = intent.getStringExtra(EXTRA_HOST_ADDRESS)
        roomUrl = intent.getStringExtra(EXTRA_ROOM_URL)
        game = intent.getStringExtra(EXTRA_GAME) ?: "uno"
        val isRoom = role == "room" && roomUrl != null
        // 群星君主是离线单机：既不建蓝牙服务，也不申请蓝牙权限。
        val isSolo = game == "civmonarchs"

        if (!isRoom && !isSolo) {
            service = BluetoothService(this, role, hostAddress) { script -> dispatchToJs(script) }
        }

        webView = WebView(this)
        setContentView(webView)
        configureWebView()
        if (!isRoom && !isSolo) requestBluetoothPermissions()
    }

    private fun configureWebView() {
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = true
        s.allowContentAccess = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            s.allowFileAccessFromFileURLs = true
            s.allowUniversalAccessFromFileURLs = true
        }
        webView.addJavascriptInterface(BtJsBridge(service, roomUrl, game) { script -> dispatchToJs(script) }, "UnoBtAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                ready.set(true)
                for (script in pendingJs) webView.evaluateJavascript(script, null)
                pendingJs.clear()
            }
        }
        webView.loadUrl("file:///android_asset/www/index.html")
    }

    /** Queue or run a JS call on the UI thread. Called from Bluetooth read threads. */
    private fun dispatchToJs(script: String) {
        if (!ready.get()) { pendingJs.add(script); return }
        webView.post { webView.evaluateJavascript(script, null) }
    }

    private fun requestBluetoothPermissions() {
        val perms = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            perms.add(Manifest.permission.BLUETOOTH_CONNECT)
            perms.add(Manifest.permission.BLUETOOTH_SCAN)
        } else {
            perms.add(Manifest.permission.BLUETOOTH)
            perms.add(Manifest.permission.BLUETOOTH_ADMIN)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val missing = perms.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
            if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 100)
        }
    }

    override fun onDestroy() {
        service?.disconnect()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ROLE = "role"
        const val EXTRA_HOST_ADDRESS = "host_address"
        const val EXTRA_ROOM_URL = "room_url"
        const val EXTRA_GAME = "game"
    }
}
