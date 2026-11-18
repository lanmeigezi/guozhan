import SwiftUI
import WebKit

struct GameWebView: UIViewRepresentable {
    let role: String
    let game: String
    let roomURL: String?

    func makeCoordinator() -> NativeBridge {
        NativeBridge(role: role, game: game, roomURL: roomURL)
    }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "UnoBtAndroid")
        contentController.addUserScript(
            WKUserScript(source: context.coordinator.startupScript(),
                         injectionTime: .atDocumentStart,
                         forMainFrameOnly: true)
        )
        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.bounces = false
        context.coordinator.attach(webView)
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.loadHTMLString("<h1>缺少 www/index.html，请先运行 clients/sync-assets.mjs</h1>", baseURL: nil)
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
