import XCTest
@testable import MatrixNet

final class VPSResolverTests: XCTestCase {
    func testGatewayURLDefaultsToHostHTTPS() throws {
        let url = try VPSResolver.gatewayBaseURL(gatewayHost: "app.matrix-os.com", runtimeSlot: nil)
        XCTAssertEqual(url.absoluteString, "https://app.matrix-os.com")
    }

    func testGatewayURLAddsRuntimeQueryWhenSlotProvided() throws {
        let url = try VPSResolver.gatewayBaseURL(gatewayHost: "app.matrix-os.com", runtimeSlot: "staging")
        XCTAssertEqual(url.absoluteString, "https://app.matrix-os.com?runtime=staging")
    }

    func testPrimarySlotStillOmitsQueryWhenNil() throws {
        let url = try VPSResolver.gatewayBaseURL(gatewayHost: "app.localhost", runtimeSlot: nil)
        XCTAssertEqual(url.scheme, "https")
        XCTAssertNil(url.query)
    }

    func testEmptyHostThrows() {
        XCTAssertThrowsError(try VPSResolver.gatewayBaseURL(gatewayHost: "", runtimeSlot: nil)) { error in
            XCTAssertEqual(error as? GatewayError, .misconfigured)
        }
    }

    func testWebSocketURLBuildsWSSWithTerminalRefAndSeq() throws {
        let url = try VPSResolver.webSocketURL(
            gatewayHost: "app.matrix-os.com",
            runtimeSlot: nil,
            path: "/ws/terminal/tab",
            terminalRef: "tws_project:tt_build",
            fromSeq: 100
        )
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(comps.scheme, "wss")
        XCTAssertEqual(comps.host, "app.matrix-os.com")
        XCTAssertEqual(comps.path, "/ws/terminal/tab")
        let items = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(items["workspaceId"], "tws_project")
        XCTAssertEqual(items["tabId"], "tt_build")
        XCTAssertEqual(items["client"], "macos")
        XCTAssertEqual(items["fromSeq"], "100")
    }

    func testWebSocketURLOmitsSeqWhenNil() throws {
        let url = try VPSResolver.webSocketURL(
            gatewayHost: "app.matrix-os.com",
            runtimeSlot: nil,
            path: "/ws/terminal/tab",
            terminalRef: "tws_project:tt_build",
            fromSeq: nil
        )
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let names = (comps.queryItems ?? []).map(\.name)
        XCTAssertFalse(names.contains("fromSeq"))
        XCTAssertTrue(names.contains("workspaceId"))
        XCTAssertTrue(names.contains("tabId"))
    }

    func testWebSocketURLIncludesRuntimeSlot() throws {
        let url = try VPSResolver.webSocketURL(
            gatewayHost: "app.matrix-os.com",
            runtimeSlot: "staging",
            path: "/ws/terminal/tab",
            terminalRef: "tws_project:tt_build",
            fromSeq: nil
        )
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let items = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(items["runtime"], "staging")
    }

    func testWebSocketURLRejectsMalformedTerminalRef() {
        XCTAssertThrowsError(try VPSResolver.webSocketURL(
            gatewayHost: "app.matrix-os.com",
            runtimeSlot: nil,
            path: "/ws/terminal/tab",
            terminalRef: "legacy-session-name",
            fromSeq: nil
        )) { error in
            XCTAssertEqual(error as? GatewayError, .misconfigured)
        }
    }

    func testConnectionProfileResolvesGatewayURL() throws {
        let profile = ConnectionProfile(handle: "hamed", gatewayHost: "app.matrix-os.com", runtimeSlot: "staging")
        let url = try profile.gatewayBaseURL()
        XCTAssertEqual(url.absoluteString, "https://app.matrix-os.com?runtime=staging")
    }
}
