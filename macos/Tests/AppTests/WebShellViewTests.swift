#if os(macOS)
import XCTest
import WebKit
@testable import MatrixOS

final class WebShellViewTests: XCTestCase {
    func testHostedShellSettingsBridgeUsesShellSettingsControls() {
        let script = HostedShellSettingsBridge.openSettingsScript

        XCTAssertTrue(script.contains("[data-testid=\"dock-settings\"]"))
        XCTAssertTrue(script.contains("button[aria-label=\"Settings\"]"))
        XCTAssertTrue(script.contains("button[title=\"Settings\"]"))
        XCTAssertTrue(script.contains("button.click()"))
        XCTAssertTrue(script.contains("if (!open())"))
        XCTAssertFalse(script.contains("window.setTimeout(open, 500)"))
    }

    func testNativeAppSessionExchangePostsBearerTokenToAppSessionEndpoint() throws {
        let destination = try XCTUnwrap(URL(string: "https://app.matrix-os.com/vm/alice?runtime=staging"))

        let request = try XCTUnwrap(NativeAppSessionExchange.request(for: destination, token: "principal-token"))

        XCTAssertEqual(request.url?.absoluteString, "https://app.matrix-os.com/api/auth/app-session")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer principal-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json["redirectTo"], "/vm/alice?runtime=staging")
    }

    func testHostedShellDestinationRequestBypassesUnauthenticatedCache() throws {
        let destination = try XCTUnwrap(URL(string: "https://app.matrix-os.com/"))

        let request = webShellDestinationRequest(for: destination, token: "principal-token")

        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer principal-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Pragma"), "no-cache")
    }

    func testHostedShellLoginRedirectShowsNativeSignInInsteadOfExternalBrowser() throws {
        let destination = try XCTUnwrap(URL(string: "https://app.matrix-os.com/"))
        let login = try XCTUnwrap(URL(string: "https://matrix-os.com/login"))

        XCTAssertEqual(
            WebShellNavigationPolicy.decision(for: login, destinationURL: destination),
            .authRequired
        )
    }

    func testHostedShellClerkRedirectShowsNativeSignInInsteadOfExternalBrowser() throws {
        let destination = try XCTUnwrap(URL(string: "https://app.matrix-os.com/"))
        let clerk = try XCTUnwrap(URL(string: "https://accounts.clerk.com/sign-in"))

        XCTAssertEqual(
            WebShellNavigationPolicy.decision(for: clerk, destinationURL: destination),
            .authRequired
        )
    }

    func testNativeAppSessionExchangeUsesRootRedirectForRootDestination() throws {
        let destination = try XCTUnwrap(URL(string: "https://app.matrix-os.com"))

        let request = try XCTUnwrap(NativeAppSessionExchange.request(for: destination, token: "principal-token"))

        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json["redirectTo"], "/")
    }

    func testNativeAppSessionExchangePreservesRootRuntimeQuery() throws {
        let destination = try XCTUnwrap(URL(string: "https://app.matrix-os.com?runtime=staging"))

        let request = try XCTUnwrap(NativeAppSessionExchange.request(for: destination, token: "principal-token"))

        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json["redirectTo"], "/?runtime=staging")
    }

    func testNativeAppSessionExchangeAcceptsNativeSessionCookies() throws {
        let url = try XCTUnwrap(URL(string: "https://app.matrix-os.com/api/auth/app-session"))
        let response = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [
                "Set-Cookie": [
                    "matrix_app_session=jwt; Path=/; Secure; HttpOnly; SameSite=Lax",
                    "matrix_native_app_session=proof; Path=/; Secure; HttpOnly; SameSite=Lax",
                ].joined(separator: ", ")
            ]
        ))

        let cookies = try NativeAppSessionExchange.appSessionCookies(from: response, for: url)

        XCTAssertEqual(cookies.map(\.name), ["matrix_app_session", "matrix_native_app_session"])
    }

    func testNativeAppSessionExchangeAcceptsURLSessionStoredNativeCookies() throws {
        let url = try XCTUnwrap(URL(string: "https://app.matrix-os.com/api/auth/app-session"))
        let response = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [:]
        ))
        let appCookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "app.matrix-os.com",
            .path: "/",
            .name: "matrix_app_session",
            .value: "jwt",
            .secure: true,
        ]))
        let nativeCookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "app.matrix-os.com",
            .path: "/",
            .name: "matrix_native_app_session",
            .value: "proof",
            .secure: true,
        ]))

        let cookies = try NativeAppSessionExchange.appSessionCookies(
            from: response,
            storedCookies: [appCookie, nativeCookie],
            for: url
        )

        XCTAssertEqual(cookies.map(\.name), ["matrix_app_session", "matrix_native_app_session"])
    }

    func testNativeAppSessionExchangeRejectsResponseWithoutNativeSessionProofCookie() throws {
        let url = try XCTUnwrap(URL(string: "https://app.matrix-os.com/api/auth/app-session"))
        let response = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Set-Cookie": "matrix_app_session=jwt; Path=/; Secure; HttpOnly; SameSite=Lax"]
        ))

        XCTAssertThrowsError(try NativeAppSessionExchange.appSessionCookies(from: response, for: url)) { error in
            XCTAssertEqual(error as? NativeAppSessionExchangeError, .invalidResponse)
        }
    }

    func testNativeAppSessionExchangeRejectsResponseWithoutMatrixSessionCookie() throws {
        let url = try XCTUnwrap(URL(string: "https://app.matrix-os.com/api/auth/app-session"))
        let response = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Set-Cookie": "unrelated=value; Path=/; Secure; HttpOnly"]
        ))

        XCTAssertThrowsError(try NativeAppSessionExchange.appSessionCookies(from: response, for: url)) { error in
            XCTAssertEqual(error as? NativeAppSessionExchangeError, .invalidResponse)
        }
    }

    @MainActor
    func testNativeAppSessionInstallReplacesStaleMatrixSessionCookies() async throws {
        let dataStore = WKWebsiteDataStore.nonPersistent()
        let store = dataStore.httpCookieStore
        let staleAppCookie = try makeCookie(name: "matrix_app_session", value: "old-jwt", domain: ".matrix-os.com")
        let staleNativeCookie = try makeCookie(name: "matrix_native_app_session", value: "old-proof", domain: "app.matrix-os.com")
        let unrelatedCookie = try makeCookie(name: "unrelated", value: "keep", domain: "app.matrix-os.com")
        try await setCookie(staleAppCookie, in: store)
        try await setCookie(staleNativeCookie, in: store)
        try await setCookie(unrelatedCookie, in: store)

        let freshAppCookie = try makeCookie(name: "matrix_app_session", value: "new-jwt", domain: "app.matrix-os.com")
        let freshNativeCookie = try makeCookie(name: "matrix_native_app_session", value: "new-proof", domain: "app.matrix-os.com")

        await installCookies([freshAppCookie, freshNativeCookie], in: store)

        let cookies = await allCookies(in: store)
        let sessionCookies = cookies.filter { $0.name == "matrix_app_session" || $0.name == "matrix_native_app_session" }
        let valuesByName = Dictionary(uniqueKeysWithValues: sessionCookies.map { ($0.name, $0.value) })
        XCTAssertEqual(valuesByName["matrix_app_session"], "new-jwt")
        XCTAssertEqual(valuesByName["matrix_native_app_session"], "new-proof")
        XCTAssertFalse(sessionCookies.contains { $0.value == "old-jwt" || $0.value == "old-proof" })
        XCTAssertEqual(cookies.first(where: { $0.name == "unrelated" })?.value, "keep")
    }

    private func makeCookie(name: String, value: String, domain: String) throws -> HTTPCookie {
        try XCTUnwrap(HTTPCookie(properties: [
            .domain: domain,
            .path: "/",
            .name: name,
            .value: value,
            .secure: true,
        ]))
    }

    @MainActor
    private func setCookie(_ cookie: HTTPCookie, in store: WKHTTPCookieStore) async throws {
        await withCheckedContinuation { continuation in
            store.setCookie(cookie) {
                continuation.resume()
            }
        }
    }

    @MainActor
    private func installCookies(_ cookies: [HTTPCookie], in store: WKHTTPCookieStore) async {
        await withCheckedContinuation { continuation in
            NativeAppSessionExchange.installCookies(cookies, in: store) {
                continuation.resume()
            }
        }
    }

    @MainActor
    private func allCookies(in store: WKHTTPCookieStore) async -> [HTTPCookie] {
        await withCheckedContinuation { continuation in
            store.getAllCookies { cookies in
                continuation.resume(returning: cookies)
            }
        }
    }
}
#endif
