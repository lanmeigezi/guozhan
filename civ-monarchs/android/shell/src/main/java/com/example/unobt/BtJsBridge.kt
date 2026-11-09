package com.example.unobt

import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The object injected into the WebView as `window.UnoBtAndroid`.
 * The JS game calls these to drive Bluetooth; the native layer calls back into
 * window.UnoBtOnJoin / UnoBtOnData / UnoBtOnDisconnect / UnoBtOnConnected / UnoBtOnStatus.
 *
 * It also provides an in-memory HTTPS bridge for the on-device LLM seat. The API
 * key never reaches a game peer or the room server; it is kept only in this
 * process's memory and is not persisted. Re-enter it after restarting the app.
 */
class BtJsBridge(
    private val service: BluetoothService?,   // null in room mode
    private val roomUrl: String?,             // non-null only in room mode
    private val game: String = "uno",         // which game was chosen
    private val dispatch: (String) -> Unit = {}
) {

    @JavascriptInterface
    fun getRole(): String = service?.role ?: "room"

    @JavascriptInterface
    fun getDeviceName(): String = service?.deviceName() ?: "联网玩家"

    @JavascriptInterface
    fun getRoomUrl(): String? = roomUrl

    @JavascriptInterface
    fun getGame(): String = game

    @JavascriptInterface
    fun openServer() = service?.openServer()

    @JavascriptInterface
    fun closeServer() = service?.closeServer()

    @JavascriptInterface
    fun findAndConnect() = service?.connect()

    @JavascriptInterface
    fun sendToChannel(channelId: Int, b64Data: String) = service?.sendToChannel(channelId, b64Data)

    @JavascriptInterface
    fun closeChannel(channelId: Int) = service?.closeChannel(channelId)

    @JavascriptInterface
    fun sendToHost(b64Data: String) = service?.sendToChannel(0, b64Data)

    @JavascriptInterface
    fun disconnect() = service?.disconnect()

    // ---- on-device LLM seat: native HTTPS, no browser CORS ----

    @JavascriptInterface
    fun llmInfo(): String {
        val cfg = LocalLlmConfig
        return JSONObject()
            .put("configured", cfg.apiKey.isNotEmpty() && cfg.baseUrl.isNotEmpty())
            .put("baseUrl", cfg.baseUrl)
            .put("model", cfg.model)
            .toString()
    }

    @JavascriptInterface
    fun llmConfigure(baseUrl: String, model: String, apiKey: String): Boolean {
        val base = baseUrl.trim()
        // Blank key = keep the existing in-memory key (edit base/model only).
        val key = apiKey.trim().ifEmpty { LocalLlmConfig.apiKey }
        if (base.isEmpty() || key.isEmpty()) return false
        LocalLlmConfig.baseUrl = base
        LocalLlmConfig.model = model.trim().ifEmpty { "deepseek-chat" }
        LocalLlmConfig.apiKey = key
        return true
    }

    @JavascriptInterface
    fun llmClear() {
        LocalLlmConfig.baseUrl = ""
        LocalLlmConfig.model = ""
        LocalLlmConfig.apiKey = ""
    }

    @JavascriptInterface
    fun llmChat(requestId: String, messagesJson: String) {
        val cfg = LocalLlmConfig.snapshot()
        if (cfg.apiKey.isEmpty() || cfg.baseUrl.isEmpty()) {
            sendLlmResult(requestId, false, "LLM 未配置")
            return
        }
        Thread({
            var conn: HttpURLConnection? = null
            try {
                val base = cfg.baseUrl.trimEnd('/')
                val endpoint = if (base.endsWith("/chat/completions")) base else "$base/chat/completions"
                val messages = JSONArray(messagesJson)
                val body = JSONObject()
                    .put("model", cfg.model.ifEmpty { "deepseek-chat" })
                    .put("messages", messages)
                    .put("temperature", 0.35)
                    .put("max_tokens", 450)
                    .put("stream", false)
                    .toString()
                    .toByteArray(Charsets.UTF_8)

                conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 15000
                    readTimeout = 30000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("Authorization", "Bearer ${cfg.apiKey}")
                }
                conn.outputStream.use { it.write(body) }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val raw = stream?.bufferedReader()?.use { it.readText() } ?: ""
                if (code !in 200..299) {
                    sendLlmResult(requestId, false, "LLM HTTP $code: ${raw.take(300)}")
                    return@Thread
                }
                val json = JSONObject(raw)
                val content = json
                    .optJSONArray("choices")
                    ?.optJSONObject(0)
                    ?.optJSONObject("message")
                    ?.optString("content")
                    ?.trim()
                    .orEmpty()
                if (content.isEmpty()) sendLlmResult(requestId, false, "LLM 返回空内容")
                else sendLlmResult(requestId, true, content)
            } catch (err: Exception) {
                sendLlmResult(requestId, false, err.message ?: err.javaClass.simpleName)
            } finally {
                try { conn?.disconnect() } catch (_: Exception) {}
            }
        }, "unobt-llm").start()
    }

    /**
     * 群星君主专用：与 llmChat 相同的原生 HTTPS 通道，但 token 上限与超时由
     * 规则配置（config/rules.json 的 rules.ai）传进来，避免 file:// 页面的 CORS
     * 限制。Key 仍然只存在进程内存，结果回调同一个 UnoBtOnLlmResponse。
     */
    @JavascriptInterface
    fun civLlmChat(requestId: String, messagesJson: String, maxTokens: Int, timeoutMs: Int) {
        val cfg = LocalLlmConfig.snapshot()
        if (cfg.apiKey.isEmpty() || cfg.baseUrl.isEmpty()) {
            sendLlmResult(requestId, false, "LLM 未配置")
            return
        }
        Thread({
            var conn: HttpURLConnection? = null
            try {
                val base = cfg.baseUrl.trimEnd('/')
                val endpoint = if (base.endsWith("/chat/completions")) base else "$base/chat/completions"
                val messages = JSONArray(messagesJson)
                val body = JSONObject()
                    .put("model", cfg.model.ifEmpty { "deepseek-chat" })
                    .put("messages", messages)
                    .put("temperature", 0.8)
                    .put("max_tokens", maxTokens)
                    .put("stream", false)
                    .toString()
                    .toByteArray(Charsets.UTF_8)

                conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = timeoutMs
                    readTimeout = timeoutMs
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("Authorization", "Bearer ${cfg.apiKey}")
                }
                conn.outputStream.use { it.write(body) }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val raw = stream?.bufferedReader()?.use { it.readText() } ?: ""
                if (code !in 200..299) {
                    sendLlmResult(requestId, false, "LLM HTTP $code: ${raw.take(200)}")
                    return@Thread
                }
                val content = JSONObject(raw)
                    .optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")
                    ?.optString("content")?.trim().orEmpty()
                if (content.isEmpty()) sendLlmResult(requestId, false, "LLM 返回空内容")
                else sendLlmResult(requestId, true, content)
            } catch (err: Exception) {
                sendLlmResult(requestId, false, err.message ?: err.javaClass.simpleName)
            } finally {
                try { conn?.disconnect() } catch (_: Exception) {}
            }
        }, "unobt-civ-llm").start()
    }

    private fun sendLlmResult(requestId: String, ok: Boolean, text: String) {
        val payload = JSONObject()
            .put("ok", ok)
            .put(if (ok) "text" else "error", text)
            .toString()
        dispatch("window.UnoBtOnLlmResponse(${JSONObject.quote(requestId)},$payload)")
    }
}

/** Process-memory only: no key on disk; cleared when the process dies. */
private object LocalLlmConfig {
    @Volatile var baseUrl: String = ""
    @Volatile var model: String = ""
    @Volatile var apiKey: String = ""

    data class Snapshot(val baseUrl: String, val model: String, val apiKey: String)

    fun snapshot(): Snapshot = Snapshot(baseUrl, model, apiKey)
}
