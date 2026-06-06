#if os(macOS)
import SwiftUI
import WebKit
import AppKit
import DesignSystem

struct MatrixWebShellPanel: View {
    @ObservedObject var model: AppModel
    let url: URL?
    let title: String

    @State private var token: String?
    @State private var tokenLoaded = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Spacing.x2) {
                Image(systemName: "globe")
                    .foregroundStyle(Color.signalLive)
                Text(title)
                    .font(.plexSans(13, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Spacer()
                if let url {
                    Text(url.host() ?? url.absoluteString)
                        .font(.plexMono(11))
                        .foregroundStyle(Color.inkTertiary)
                        .lineLimit(1)
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Image(systemName: "arrow.up.forward.square")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color.inkSecondary)
                            .iconHitTarget(30)
                    }
                    .buttonStyle(.plain)
                    .help("Open in browser")
                }
            }
            .padding(.horizontal, Spacing.x3)
            .padding(.vertical, Spacing.x2)
            .background(Color.surfaceRail)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color.hairlineDark).frame(height: 1)
            }

            if let url, tokenLoaded {
                WebShellView(url: url, bearerToken: token)
            } else if url != nil {
                ProgressView("Opening \(title)...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.surfaceCard)
            } else {
                ContentUnavailableView(
                    "No Matrix shell",
                    systemImage: "globe.badge.chevron.backward",
                    description: Text("Connect a Matrix computer to open the online shell.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.surfaceCard)
            }
        }
        .task(id: url) {
            guard url != nil else {
                token = nil
                tokenLoaded = false
                return
            }
            tokenLoaded = false
            token = await model.currentBearerToken()
            tokenLoaded = true
        }
    }
}

private struct WebShellView: NSViewRepresentable {
    let url: URL
    let bearerToken: String?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.underPageBackgroundColor = .clear
        load(url, in: view, coordinator: context.coordinator)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        guard context.coordinator.lastRequestedURL != url
            || context.coordinator.lastBearerToken != bearerToken else { return }
        load(url, in: view, coordinator: context.coordinator)
    }

    private func load(_ url: URL, in view: WKWebView, coordinator: Coordinator) {
        coordinator.lastBearerToken = bearerToken
        coordinator.lastRequestedURL = url
        coordinator.destinationURL = url
        guard let bearerToken, !bearerToken.isEmpty, let request = appSessionExchangeRequest(for: url, token: bearerToken) else {
<<<<<<< HEAD
            coordinator.exchangeInFlight = false
            view.load(destinationRequest(for: url, token: bearerToken))
=======
            view.load(webShellDestinationRequest(for: url, token: bearerToken))
>>>>>>> 81595539 (fix(086): harden native auth routing retries)
            return
        }
        coordinator.exchangeInFlight = true
        view.load(request)
    }

    private func appSessionExchangeRequest(for destination: URL, token: String) -> URLRequest? {
        guard var comps = URLComponents(url: destination, resolvingAgainstBaseURL: false) else { return nil }
        let redirectTo = destination.path.isEmpty
            ? "/"
            : destination.path + (destination.query.map { "?\($0)" } ?? "")
        comps.path = "/api/auth/app-session"
        comps.query = nil
        guard let exchangeURL = comps.url else { return nil }
        var request = URLRequest(url: exchangeURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(AppSessionExchangeBody(redirectTo: redirectTo))
        return request
    }

    private struct AppSessionExchangeBody: Encodable {
        let redirectTo: String
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastBearerToken: String?
        var lastRequestedURL: URL?
        var destinationURL: URL?
        var exchangeInFlight = false

        @MainActor
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            if Self.shouldOpenExternally(url) {
                if exchangeInFlight {
                    exchangeInFlight = false
                }
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            if exchangeInFlight, !Self.isAppSessionExchangeURL(url) {
                exchangeInFlight = false
            }
            decisionHandler(.allow)
        }

        @MainActor
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
        ) {
            guard exchangeInFlight,
                  let responseURL = navigationResponse.response.url,
                  Self.isAppSessionExchangeURL(responseURL),
                  let httpResponse = navigationResponse.response as? HTTPURLResponse,
                  !(200..<300).contains(httpResponse.statusCode) else {
                decisionHandler(.allow)
                return
            }
            loadDestinationAfterExchangeFailure(in: webView)
            decisionHandler(.cancel)
        }

        @MainActor
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard exchangeInFlight,
                  webView.url.map(Self.isAppSessionExchangeURL) == true,
                  let destinationURL else { return }
            exchangeInFlight = false
            webView.load(webShellDestinationRequest(for: destinationURL, token: lastBearerToken))
        }

        @MainActor
        func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
            if exchangeInFlight {
                exchangeInFlight = false
            }
        }

        @MainActor
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            loadDestinationAfterExchangeFailure(in: webView)
        }

        @MainActor
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            loadDestinationAfterExchangeFailure(in: webView)
        }

        @MainActor
        private func loadDestinationAfterExchangeFailure(in webView: WKWebView) {
            guard exchangeInFlight, let destinationURL else { return }
            exchangeInFlight = false
            webView.load(webShellDestinationRequest(for: destinationURL, token: lastBearerToken))
        }

        private static func shouldOpenExternally(_ url: URL) -> Bool {
            guard let host = url.host()?.lowercased() else { return false }
            let path = url.path.lowercased()
            let firstSegment = url.pathComponents.dropFirst().first?.lowercased()
            if path == "/api/auth/app-session" { return false }
            if host.contains("clerk") || host.contains("accounts.") {
                return true
            }
<<<<<<< HEAD
            return firstSegment == "sign-in"
                || firstSegment == "sign-up"
                || firstSegment == "login"
                || firstSegment == "oauth"
                || firstSegment == "sso"
                || firstSegment == "auth"
                || path == "/login"
=======
            return isAuthPath(path)
        }

        private static func isAppSessionExchangeURL(_ url: URL) -> Bool {
            url.path == "/api/auth/app-session"
        }

        private static func isAuthPath(_ path: String) -> Bool {
            path == "/sign-in"
                || path.hasPrefix("/sign-in/")
                || path == "/sign-up"
                || path.hasPrefix("/sign-up/")
                || path == "/login"
                || path.hasPrefix("/login/")
                || path == "/oauth"
                || path.hasPrefix("/oauth/")
                || path == "/sso"
                || path.hasPrefix("/sso/")
                || path == "/auth/device"
                || path.hasPrefix("/auth/device/")
                || path == "/auth/callback"
                || path.hasPrefix("/auth/callback/")
>>>>>>> 5ffea89c (fix(086): harden native auth routing retries)
        }
    }
}

private func webShellDestinationRequest(for url: URL, token: String?) -> URLRequest {
    var request = URLRequest(url: url)
    request.timeoutInterval = 20
    if let token, !token.isEmpty {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    return request
}
#endif
