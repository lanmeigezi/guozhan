import Foundation

/// Same contract as BtJsBridge.llmChat / civLlmChat. Key is process-memory only.
final class LlmBridge {
    private var baseURL = ""
    private var model = ""
    private var apiKey = ""
    private var onJS: (String) -> Void

    init(onJS: @escaping (String) -> Void) { self.onJS = onJS }

    func infoJSON() -> String {
        let obj: [String: Any] = [
            "configured": !apiKey.isEmpty && !baseURL.isEmpty,
            "baseUrl": baseURL,
            "model": model,
        ]
        return String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!
    }

    func configure(base: String, model m: String, key: String) -> Bool {
        let b = base.trimmingCharacters(in: .whitespacesAndNewlines)
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? apiKey
            : key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !b.isEmpty, !k.isEmpty else { return false }
        baseURL = b
        model = m.isEmpty ? "deepseek-chat" : m
        apiKey = k
        return true
    }

    func clear() { baseURL = ""; model = ""; apiKey = "" }

    func chat(requestId: String, messagesJson: String, maxTokens: Int, timeoutMs: Int) {
        guard !apiKey.isEmpty, !baseURL.isEmpty else {
            result(requestId, ok: false, text: "LLM 未配置")
            return
        }
        let base = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        let endpoint = base.hasSuffix("/chat/completions") ? base : base + "/chat/completions"
        guard let url = URL(string: endpoint),
              let messages = try? JSONSerialization.jsonObject(with: Data(messagesJson.utf8)) else {
            result(requestId, ok: false, text: "LLM 地址或消息格式非法")
            return
        }
        let body: [String: Any] = [
            "model": model.isEmpty ? "deepseek-chat" : model,
            "messages": messages,
            "temperature": 0.35,
            "max_tokens": maxTokens,
            "stream": false,
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = bodyData
        request.timeoutInterval = Double(timeoutMs) / 1000.0
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            if let error { self.result(requestId, ok: false, text: error.localizedDescription); return }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard let data, (200...299).contains(code) else {
                self.result(requestId, ok: false, text: "LLM HTTP \(code)")
                return
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let choices = json["choices"] as? [[String: Any]],
                  let message = choices.first?["message"] as? [String: Any],
                  let text = message["content"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                self.result(requestId, ok: false, text: "LLM 返回空内容")
                return
            }
            self.result(requestId, ok: true, text: text)
        }.resume()
    }

    private func result(_ requestId: String, ok: Bool, text: String) {
        let key = ok ? "text" : "error"
        let payload = "{\(key):\(BleTransport.jsString(text))}"
        onJS("window.UnoBtOnLlmResponse(\(BleTransport.jsString(requestId)),\(payload))")
    }
}
