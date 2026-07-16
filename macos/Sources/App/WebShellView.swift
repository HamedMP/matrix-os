#if os(macOS)
import SwiftUI
import WebKit
import AppKit
import DesignSystem
import OSLog

private let webShellLogger = Logger(subsystem: "com.matrixos.native-shell", category: "WebShell")

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
                        if shouldRetry {
                            authState.markResolving()
                            Task {
                                await reloadBearerToken()
                            }
                        } else {
                            // Retry exhausted: the hosted web session needs sign-in.
                            // `markHostedAuthRequired()` already set the panel to show
                            // the native sign-in prompt. Do NOT sign out — the native
                            // principal/gateway session is still valid; signing out
                            // here caused a redirect -> sign-out -> re-show loop.
                            model.markHostedShellAuthRequired()
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
            await reloadBearerToken(resetHostedRetry: true)
        }
        .onChange(of: model.signInCompletionID) { _, _ in
            Task {
                await reloadBearerToken(resetHostedRetry: true)
            }
        }
    }

    @MainActor
    private func reloadBearerToken(resetHostedRetry: Bool = false) async {
        guard url != nil else {
            webShellLogger.info("Hosted shell token skipped because url is nil")
            authState.resolveToken(nil, resetHostedRetry: true)
            return
        }
        if resetHostedRetry {
            // A fresh attempt (URL change or completed sign-in): re-arm the hosted
            // shell so a previously-flagged needs-sign-in state does not stick.
            model.markHostedShellAuthorized()
        }
        authState.markResolving()
        let current = await model.currentBearerToken()
        webShellLogger.info("Hosted shell token resolved present=\(current != nil, privacy: .public)")
        authState.resolveToken(current, resetHostedRetry: resetHostedRetry)
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

    mutating func resolveToken(_ nextToken: String?, resetHostedRetry: Bool = false) {
        let tokenChanged = nextToken != token
        token = nextToken
        didResolveToken = true
        if nextToken == nil {
            hostedAuthRequired = false
            hostedRetryAttempted = false
            authRevision += 1
            return
        }
        hostedAuthRequired = false
        if resetHostedRetry || tokenChanged {
            hostedRetryAttempted = false
        }
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
        // Persist the hosted-shell data store so the Home tab keeps its cache across visits
        // (a non-persistent store forces a full reload every time). Stale Clerk client cookies
        // are stripped per-load by clearInterferingClerkCookies instead.
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
        webShellLogger.info("Hosted shell load requested host=\(url.host() ?? "unknown", privacy: .public) path=\(url.path, privacy: .public) tokenPresent=\((bearerToken?.isEmpty == false), privacy: .public)")
        guard let bearerToken, !bearerToken.isEmpty else {
            coordinator.cancelExchange()
            webShellLogger.warning("Hosted shell loading without bearer token")
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
            webShellLogger.info("WK navigation requested host=\(url.host() ?? "unknown", privacy: .public) path=\(url.path, privacy: .public)")
            switch WebShellNavigationPolicy.decision(for: url, destinationURL: destinationURL) {
            case .authRequired:
                webShellLogger.warning("WK navigation treated as hosted auth required path=\(url.path, privacy: .public)")
                onAuthRequired()
                decisionHandler(.cancel)
            case .external:
                cancelExchange()
                webShellLogger.info("WK navigation opened externally host=\(url.host() ?? "unknown", privacy: .public) path=\(url.path, privacy: .public)")
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            case .allow:
                decisionHandler(.allow)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if let url = webView.url {
                webShellLogger.info("WK navigation finished host=\(url.host() ?? "unknown", privacy: .public) path=\(url.path, privacy: .public)")
            } else {
                webShellLogger.info("WK navigation finished without current url")
            }
            guard openSettingsOnLoad else { return }
            openSettingsOnLoad = false
            webView.evaluateJavaScript(HostedShellSettingsBridge.openSettingsScript, completionHandler: nil)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            webShellLogger.warning("WK navigation failed error=\(String(describing: error), privacy: .private)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            webShellLogger.warning("WK provisional navigation failed error=\(String(describing: error), privacy: .private)")
        }

        @MainActor
        func exchangeAppSession(for destination: URL, token: String, in webView: WKWebView) {
            cancelExchange()
            guard let request = NativeAppSessionExchange.request(for: destination, token: token) else {
                webShellLogger.warning("Native app session exchange request could not be built")
                onAuthRequired()
                return
            }
            exchangeGeneration += 1
            let generation = exchangeGeneration
            webShellLogger.info("Native app session exchange started host=\(destination.host() ?? "unknown", privacy: .public) path=\(destination.path, privacy: .public)")
            exchangeTask = Task { [weak self, weak webView] in
                do {
                    let response = try await NativeAppSessionExchange.perform(request: request)
                    guard !Task.isCancelled else { return }
                    await MainActor.run {
                        guard let self, let webView, self.exchangeGeneration == generation else { return }
                        self.exchangeTask = nil
                        let cookieStore = webView.configuration.websiteDataStore.httpCookieStore
                        NativeAppSessionExchange.installCookies(response.cookies, in: cookieStore) {
                            guard self.exchangeGeneration == generation else { return }
                            let names = response.cookies.map(\.name).joined(separator: ",")
                            webShellLogger.info("Native app session cookies installed names=\(names, privacy: .public)")
                            // The hosted shell authenticates via the native app-session cookies
                            // (matrix_app_session / matrix_native_app_session). Stale Clerk client
                            // cookies (accumulated from prior /login redirects) make the platform's
                            // identity resolution fall back to an unrouted Clerk identity and serve
                            // the sign-in page. Strip them so we present a clean native-only session.
                            NativeAppSessionExchange.clearInterferingClerkCookies(in: cookieStore) {
                                guard self.exchangeGeneration == generation else { return }
                                webView.load(webShellDestinationRequest(for: destination, token: token))
                            }
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
                        webShellLogger.warning("Native app session exchange failed error=\(String(describing: error), privacy: .private)")
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
    }
}

enum WebShellNavigationDecision: Equatable {
    case allow
    case authRequired
    case external
}

enum WebShellNavigationPolicy {
    static func decision(for url: URL, destinationURL: URL?) -> WebShellNavigationDecision {
        if isAuthNavigation(url) {
            return .authRequired
        }
        return .allow
    }

    private static func isAuthNavigation(_ url: URL) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        if host.contains("clerk") || host.contains("accounts.") {
            return true
        }
        return isAuthPath(url.path.lowercased())
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
    private static let sessionCookieNames = Set([
        "matrix_app_session",
        "matrix_native_app_session",
    ])

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
        webShellLogger.info("Native app session response status=\(http.statusCode, privacy: .public)")
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
            let names = cookies.map(\.name).joined(separator: ",")
            webShellLogger.warning("Native app session response missing required cookies names=\(names, privacy: .public)")
            throw NativeAppSessionExchangeError.invalidResponse
        }
        let names = cookies.map(\.name).joined(separator: ",")
        webShellLogger.info("Native app session cookies parsed names=\(names, privacy: .public)")
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
        let sessionCookies = cookies.filter { sessionCookieNames.contains($0.name) }
        guard !sessionCookies.isEmpty else {
            completion()
            return
        }

        store.getAllCookies { existingCookies in
            let staleCookies = existingCookies.filter(shouldReplaceExistingCookie)
            let staleNames = staleCookies.map(\.name).joined(separator: ",")
            webShellLogger.info("Replacing stale native session cookies count=\(staleCookies.count, privacy: .public) names=\(staleNames, privacy: .public)")
            Task { @MainActor in
                deleteCookie(at: 0, cookies: staleCookies, store: store) {
                    installCookie(at: 0, cookies: sessionCookies, store: store, completion: completion)
                }
            }
        }
    }

    private static func shouldReplaceExistingCookie(_ cookie: HTTPCookie) -> Bool {
        guard sessionCookieNames.contains(cookie.name) else { return false }
        let normalizedDomain = cookie.domain
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return normalizedDomain == "app.matrix-os.com" || normalizedDomain == "matrix-os.com"
    }

    @MainActor
    private static func deleteCookie(
        at index: Int,
        cookies: [HTTPCookie],
        store: WKHTTPCookieStore,
        completion: @escaping @MainActor () -> Void
    ) {
        guard cookies.indices.contains(index) else {
            completion()
            return
        }
        store.delete(cookies[index]) {
            Task { @MainActor in
                deleteCookie(at: index + 1, cookies: cookies, store: store, completion: completion)
            }
        }
    }

    @MainActor
    private static func installCookie(
        at index: Int,
        cookies: [HTTPCookie],
        store: WKHTTPCookieStore,
        completion: @escaping @MainActor () -> Void
    ) {
        guard cookies.indices.contains(index) else {
            completion()
            return
        }
        store.setCookie(cookies[index]) {
            Task { @MainActor in
                installCookie(at: index + 1, cookies: cookies, store: store, completion: completion)
            }
        }
    }

    /// Clerk client cookies (`__client*`, `__session*`) and Clerk-domain cookies linger in the
    /// WKWebView store after a `/login` redirect. When present alongside a valid native app-session,
    /// the platform resolves an unrouted Clerk identity and serves the sign-in page instead of the
    /// shell. Remove them so the hosted shell load presents only the native app-session.
    @MainActor
    static func clearInterferingClerkCookies(in store: WKHTTPCookieStore, completion: @escaping @MainActor () -> Void) {
        store.getAllCookies { cookies in
            let clerkCookies = cookies.filter(isClerkCookie)
            guard !clerkCookies.isEmpty else {
                completion()
                return
            }
            let names = clerkCookies.map(\.name).joined(separator: ",")
            webShellLogger.info("Clearing interfering Clerk cookies before hosted shell load names=\(names, privacy: .public)")
            Task { @MainActor in
                deleteCookie(at: 0, cookies: clerkCookies, store: store, completion: completion)
            }
        }
    }

    private static func isClerkCookie(_ cookie: HTTPCookie) -> Bool {
        let domain = cookie.domain.lowercased()
        if domain.contains("clerk") { return true }
        let name = cookie.name
        return name.hasPrefix("__client") || name.hasPrefix("__session")
    }
}

enum NativeAppSessionExchangeError: Error, Equatable {
    case invalidResponse
    case unauthorized
}

func webShellDestinationRequest(for url: URL, token: String?) -> URLRequest {
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
    request.timeoutInterval = 20
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    request.setValue("no-cache", forHTTPHeaderField: "Pragma")
    if let token, !token.isEmpty {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    return request
}
#endif
