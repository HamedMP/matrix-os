#if os(macOS)
import SwiftUI
import WebKit
import AppKit
import DesignSystem

struct MatrixWebShellPanel: View {
    @ObservedObject var model: AppModel
    let url: URL?
    let title: String
    var openSettingsOnLoad = false

    @State private var authState = WebShellAuthState()

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

            if url == nil {
                ContentUnavailableView(
                    "No Matrix shell",
                    systemImage: "globe.badge.chevron.backward",
                    description: Text("Connect a Matrix computer to open the online shell.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.surfaceCard)
            } else if !authState.didResolveToken {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.canvasVoid)
            } else if authState.shouldShowSignInPrompt {
                NoProfileView(
                    onCreate: { model.beginSignIn(mode: .signUp) },
                    onSignIn: { model.beginSignIn(mode: .signIn) },
                    onCancelSignIn: { model.cancelSignIn() },
                    signIn: model.signIn
                )
            } else if let url, let token = authState.token {
                WebShellView(
                    url: url,
                    bearerToken: token,
                    authRevision: authState.authRevision,
                    openSettingsOnLoad: openSettingsOnLoad,
                    onAuthRequired: {
                        let shouldRetry = authState.markHostedAuthRequired()
                        guard shouldRetry else { return }
                        authState.markResolving()
                        Task {
                            await reloadBearerToken()
                        }
                    }
                )
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
            await reloadBearerToken()
        }
        .onChange(of: model.signInCompletionID) { _, _ in
            Task {
                await reloadBearerToken()
            }
        }
    }

    @MainActor
    private func reloadBearerToken() async {
        guard url != nil else {
            authState.resolveToken(nil)
            return
        }
        authState.markResolving()
        let current = await model.currentBearerToken()
        authState.resolveToken(current)
    }
}

struct WebShellAuthState: Equatable, Sendable {
    private(set) var token: String?
    private(set) var didResolveToken = false
    private(set) var hostedAuthRequired = false
    private(set) var hostedRetryAttempted = false
    private(set) var authRevision = 0

    var shouldShowSignInPrompt: Bool {
        didResolveToken && (token == nil || hostedAuthRequired)
    }

    mutating func markResolving() {
        didResolveToken = false
    }

    mutating func resolveToken(_ nextToken: String?) {
        token = nextToken
        didResolveToken = true
        if nextToken == nil {
            hostedAuthRequired = false
            hostedRetryAttempted = false
            authRevision += 1
            return
        }
        hostedAuthRequired = false
        hostedRetryAttempted = false
        authRevision += 1
    }

    mutating func markHostedAuthRequired() -> Bool {
        hostedAuthRequired = true
        didResolveToken = true
        guard token != nil, !hostedRetryAttempted else { return false }
        hostedRetryAttempted = true
        return true
    }
}

private struct WebShellView: NSViewRepresentable {
    let url: URL
    let bearerToken: String?
    let authRevision: Int
    let openSettingsOnLoad: Bool
    let onAuthRequired: @MainActor () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onAuthRequired: onAuthRequired)
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
            || context.coordinator.lastBearerToken != bearerToken
            || context.coordinator.lastAuthRevision != authRevision else { return }
        load(url, in: view, coordinator: context.coordinator)
    }

    private func load(_ url: URL, in view: WKWebView, coordinator: Coordinator) {
        coordinator.lastBearerToken = bearerToken
        coordinator.lastRequestedURL = url
        coordinator.lastAuthRevision = authRevision
        coordinator.openSettingsOnLoad = openSettingsOnLoad
        coordinator.destinationURL = url
        guard let bearerToken, !bearerToken.isEmpty else {
            coordinator.cancelExchange()
            view.load(webShellDestinationRequest(for: url, token: bearerToken))
            return
        }
        coordinator.exchangeAppSession(for: url, token: bearerToken, in: view)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastBearerToken: String?
        var lastRequestedURL: URL?
        var lastAuthRevision: Int?
        var destinationURL: URL?
        var openSettingsOnLoad = false
        private var exchangeTask: Task<Void, Never>?
        private var exchangeGeneration = 0

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
            if shouldHandleAsAuthRequired(url) {
                onAuthRequired()
                decisionHandler(.cancel)
                return
            }
            if Self.shouldOpenExternally(url) {
                cancelExchange()
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard openSettingsOnLoad else { return }
            openSettingsOnLoad = false
            webView.evaluateJavaScript(HostedShellSettingsBridge.openSettingsScript, completionHandler: nil)
        }

        @MainActor
        func exchangeAppSession(for destination: URL, token: String, in webView: WKWebView) {
            cancelExchange()
            guard let request = NativeAppSessionExchange.request(for: destination, token: token) else {
                onAuthRequired()
                return
            }
            exchangeGeneration += 1
            let generation = exchangeGeneration
            exchangeTask = Task { [weak self, weak webView] in
                do {
                    let response = try await NativeAppSessionExchange.perform(request: request)
                    guard !Task.isCancelled else { return }
                    await MainActor.run {
                        guard let self, let webView, self.exchangeGeneration == generation else { return }
                        self.exchangeTask = nil
                        NativeAppSessionExchange.installCookies(response.cookies, in: webView.configuration.websiteDataStore.httpCookieStore) {
                            guard self.exchangeGeneration == generation else { return }
                            webView.load(webShellDestinationRequest(for: destination, token: token))
                        }
                    }
                } catch is CancellationError {
                    // A newer navigation superseded this exchange.
                } catch let error as URLError where error.code == .cancelled {
                    // URLSession reports task cancellation as URLError.cancelled.
                } catch {
                    await MainActor.run {
                        guard let self, self.exchangeGeneration == generation else { return }
                        self.exchangeTask = nil
                        self.onAuthRequired()
                    }
                }
            }
        }

        @MainActor
        func cancelExchange() {
            exchangeGeneration += 1
            exchangeTask?.cancel()
            exchangeTask = nil
        }

        private let onAuthRequired: @MainActor () -> Void

        init(onAuthRequired: @escaping @MainActor () -> Void) {
            self.onAuthRequired = onAuthRequired
        }

        private func shouldHandleAsAuthRequired(_ url: URL) -> Bool {
            guard let destinationHost = destinationURL?.host()?.lowercased(),
                  let host = url.host()?.lowercased(),
                  host == destinationHost else { return false }
            let path = url.path.lowercased()
            return Self.isAuthPath(path)
        }

        private static func shouldOpenExternally(_ url: URL) -> Bool {
            guard let host = url.host()?.lowercased() else { return false }
            let path = url.path.lowercased()
            if host.contains("clerk") || host.contains("accounts.") {
                return true
            }
            return isAuthPath(path)
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
        }
    }
}

enum HostedShellSettingsBridge {
    static let openSettingsScript = """
    (() => {
      const selectors = [
        '[data-testid="dock-settings"]',
        'button[aria-label="Settings"]',
        'button[title="Settings"]'
      ];
      const open = () => {
        for (const selector of selectors) {
          const button = document.querySelector(selector);
          if (button instanceof HTMLElement) {
            button.click();
            return true;
          }
        }
        return false;
      };
      if (!open()) {
        window.setTimeout(() => {
          if (!open()) {
            window.setTimeout(open, 350);
          }
        }, 150);
      }
    })();
    """
}

struct NativeAppSessionExchange {
    private struct Body: Encodable {
        let redirectTo: String
    }

    struct Response: Sendable {
        let cookies: [HTTPCookie]
    }

    static func request(for destination: URL, token: String) -> URLRequest? {
        guard var comps = URLComponents(url: destination, resolvingAgainstBaseURL: false) else { return nil }
        let path = destination.path.isEmpty ? "/" : destination.path
        let redirectTo = path + (destination.query.map { "?\($0)" } ?? "")
        comps.path = "/api/auth/app-session"
        comps.query = nil
        guard let exchangeURL = comps.url else { return nil }
        var request = URLRequest(url: exchangeURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(Body(redirectTo: redirectTo))
        return request
    }

    static func perform(request: URLRequest) async throws -> Response {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        let cookieStorage = configuration.httpCookieStorage
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeAppSessionExchangeError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw NativeAppSessionExchangeError.unauthorized }
        guard let url = request.url else { throw NativeAppSessionExchangeError.invalidResponse }
        return try Response(cookies: appSessionCookies(
            from: http,
            storedCookies: cookieStorage?.cookies(for: url) ?? [],
            for: url
        ))
    }

    static func appSessionCookies(
        from response: HTTPURLResponse,
        storedCookies: [HTTPCookie] = [],
        for url: URL
    ) throws -> [HTTPCookie] {
        let headerCookies = response.allHeaderFields.flatMap { entry -> [HTTPCookie] in
            guard let key = entry.key as? String,
                  key.caseInsensitiveCompare("Set-Cookie") == .orderedSame else { return [] }

            let values: [String]
            if let value = entry.value as? String {
                values = splitSetCookieHeader(value)
            } else if let value = entry.value as? [String] {
                values = value.flatMap(splitSetCookieHeader)
            } else {
                values = []
            }
            return values.flatMap { value in
                HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": value], for: url)
            }
        }

        var seen = Set<String>()
        let cookies = (storedCookies + headerCookies).filter { cookie in
            let key = "\(cookie.name)\u{1f}\(cookie.domain)\u{1f}\(cookie.path)"
            return seen.insert(key).inserted
        }
        guard cookies.contains(where: { $0.name == "matrix_app_session" && !$0.value.isEmpty }),
              cookies.contains(where: { $0.name == "matrix_native_app_session" && !$0.value.isEmpty }) else {
            throw NativeAppSessionExchangeError.invalidResponse
        }
        return cookies
    }

    private static func splitSetCookieHeader(_ value: String) -> [String] {
        value
            .split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .flatMap { splitConcatenatedSetCookieLine(String($0)) }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func splitConcatenatedSetCookieLine(_ line: String) -> [String] {
        var values: [String] = []
        var start = line.startIndex
        var index = line.startIndex
        while index < line.endIndex {
            guard line[index] == "," else {
                index = line.index(after: index)
                continue
            }
            var candidate = line.index(after: index)
            while candidate < line.endIndex, line[candidate] == " " {
                candidate = line.index(after: candidate)
            }
            if beginsCookieName(at: candidate, in: line) {
                values.append(String(line[start..<index]))
                start = candidate
                index = candidate
                continue
            }
            index = line.index(after: index)
        }
        values.append(String(line[start..<line.endIndex]))
        return values
    }

    private static func beginsCookieName(at index: String.Index, in line: String) -> Bool {
        var cursor = index
        var hasName = false
        while cursor < line.endIndex {
            let character = line[cursor]
            if character == "=" {
                return hasName
            }
            guard character.isASCII,
                  (character.isLetter || character.isNumber || character == "_" || character == "-") else {
                return false
            }
            hasName = true
            cursor = line.index(after: cursor)
        }
        return false
    }

    @MainActor
    static func installCookies(_ cookies: [HTTPCookie], in store: WKHTTPCookieStore, completion: @escaping @MainActor () -> Void) {
        guard !cookies.isEmpty else {
            completion()
            return
        }
        func installCookie(at index: Int) {
            guard cookies.indices.contains(index) else {
                completion()
                return
            }
            let cookie = cookies[index]
            store.setCookie(cookie) {
                Task { @MainActor in
                    installCookie(at: index + 1)
                }
            }
        }
        installCookie(at: 0)
    }
}

enum NativeAppSessionExchangeError: Error, Equatable {
    case invalidResponse
    case unauthorized
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
