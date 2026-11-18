import Foundation
import UIKit
import WebKit

/// Injected into WKWebView as window.UnoBtAndroid.
/// Sync getters are answered from a pre-injected JS config; async methods postMessage.
final class NativeBridge: NSObject, WKScriptMessageHandler {

    let role: String
    let game: String
    let roomURL: String?
    private weak var webView: WKWebView?
    private var ble: BleTransport?
    private var llm: LlmBridge!

    init(role: String, game: String, roomURL: String?) {
        self.role = role
        self.game = game
        self.roomURL = roomURL
        super.init()
        // Rebind LLM callback once self exists.
        llm = LlmBridge { [weak self] script in self?.evaluate(script) }
        if role == "host" || role == "guest" {
            ble = BleTransport(role: role == "host" ? .host : .guest) { [weak self] script in
                self?.evaluate(script)
            }
        }
    }

    func attach(_ webView: WKWebView) { self.webView = webView }

    /// JS shim installed at document start (before app.js reads window.UnoBtAndroid).
    func startupScript() -> String {
        let cfg: [String: Any] = [
            "role": role,
            "game": game,
            "deviceName": UIDevice.current.name,
            "roomUrl": roomURL ?? NSNull(),
        ]
        let json = String(data: try! JSONSerialization.data(withJSONObject: cfg), encoding: .utf8)!
        return """
        window.__unoBtConfig = \(json);
        (function () {
          var cfg = window.__unoBtConfig;
          function call(method, args) {
            window.webkit.messageHandlers.UnoBtAndroid.postMessage({ method: method, args: args || [] });
          }
          var llmCfg = { configured: false, baseUrl: '', model: '' };
          window.UnoBtAndroid = {
            getRole: function () { return cfg.role; },
            getDeviceName: function () { return cfg.deviceName; },
            getRoomUrl: function () { return cfg.roomUrl; },
            getGame: function () { return cfg.game; },
            openServer: function () { call('openServer'); },
            closeServer: function () { call('closeServer'); },
            findAndConnect: function () { call('findAndConnect'); },
            disconnect: function () { call('disconnect'); },
            sendToChannel: function (id, b64) { call('sendToChannel', [id, b64]); },
            closeChannel: function (id) { call('closeChannel', [id]); },
            sendToHost: function (b64) { call('sendToHost', [b64]); },
            llmInfo: function () { return JSON.stringify(llmCfg); },
            llmConfigure: function (base, model, key) {
              call('llmConfigure', [base, model, key]);
              llmCfg = { configured: true, baseUrl: base, model: model || 'deepseek-chat' };
              return true;
            },
            llmClear: function () { call('llmClear'); llmCfg = { configured: false, baseUrl: '', model: '' }; },
            llmChat: function (id, json) { call('llmChat', [id, json]); },
            civLlmChat: function (id, json, maxTokens, timeoutMs) {
              call('civLlmChat', [id, json, maxTokens, timeoutMs]);
            }
          };
        })();
        """
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let method = body["method"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        switch method {
        case "openServer": ble?.openServer()
        case "closeServer": ble?.closeServer()
        case "findAndConnect": ble?.findAndConnect()
        case "disconnect": ble?.disconnect()
        case "sendToChannel":
            if let id = args[0] as? Int, let b64 = args[1] as? String { ble?.sendToChannel(id, b64: b64) }
        case "closeChannel":
            if let id = args[0] as? Int { ble?.closeChannel(id) }
        case "sendToHost":
            if let b64 = args[0] as? String { ble?.sendToHost(b64) }
        case "llmConfigure":
            if let base = args[0] as? String, let model = args[1] as? String, let key = args[2] as? String {
                _ = llm.configure(base: base, model: model, key: key)
            }
        case "llmClear": llm.clear()
        case "llmChat":
            if let id = args[0] as? String, let json = args[1] as? String {
                llm.chat(requestId: id, messagesJson: json, maxTokens: 450, timeoutMs: 30000)
            }
        case "civLlmChat":
            if let id = args[0] as? String, let json = args[1] as? String,
               let max = args[2] as? Int, let timeout = args[3] as? Int {
                llm.chat(requestId: id, messagesJson: json, maxTokens: max, timeoutMs: timeout)
            }
        default: break
        }
    }

    func evaluate(_ script: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(script, completionHandler: nil)
        }
    }
}
