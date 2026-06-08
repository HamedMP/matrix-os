#if os(macOS)
import XCTest
@testable import MatrixOS

final class WebShellViewTests: XCTestCase {
    func testHostedShellSettingsBridgeUsesShellSettingsControls() {
        let script = HostedShellSettingsBridge.openSettingsScript

        XCTAssertTrue(script.contains("[data-testid=\"dock-settings\"]"))
        XCTAssertTrue(script.contains("button[aria-label=\"Settings\"]"))
        XCTAssertTrue(script.contains("button[title=\"Settings\"]"))
        XCTAssertTrue(script.contains("button.click()"))
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

    func testNativeAppSessionExchangeAcceptsMatrixAppSessionCookie() throws {
        let url = try XCTUnwrap(URL(string: "https://app.matrix-os.com/api/auth/app-session"))
        let response = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Set-Cookie": "matrix_app_session=jwt; Path=/; Secure; HttpOnly; SameSite=Lax"]
        ))

        let cookies = try NativeAppSessionExchange.appSessionCookies(from: response, for: url)

        XCTAssertEqual(cookies.map(\.name), ["matrix_app_session"])
    }

    func testNativeAppSessionExchangeRejectsResponseWithoutMatrixAppSessionCookie() throws {
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
}
#endif
