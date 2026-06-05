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

    func testWebSocketURLBuildsWSSWithSessionAndSeq() throws {
        let url = try VPSResolver.webSocketURL(
            gatewayHost: "app.matrix-os.com",
            runtimeSlot: nil,
            path: "/ws/terminal/session",
            session: "card-42",
            fromSeq: 100
        )
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(comps.scheme, "wss")
        XCTAssertEqual(comps.host, "app.matrix-os.com")
        XCTAssertEqual(comps.path, "/ws/terminal/session")
        let items = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(items["session"], "card-42")
        XCTAssertEqual(items["fromSeq"], "100")
    }

    func testWebSocketURLOmitsSeqWhenNil() throws {
        let url = try VPSResolver.webSocketURL(
            gatewayHost: "app.matrix-os.com",
            runtimeSlot: nil,
            path: "/ws/terminal/session",
            session: "card-42",
            fromSeq: nil
        )
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let names = (comps.queryItems ?? []).map(\.name)
        XCTAssertFalse(names.contains("fromSeq"))
        XCTAssertTrue(names.contains("session"))
    }

    func testWebSocketURLIncludesRuntimeSlot() throws {
        let url = try VPSResolver.webSocketURL(
            gatewayHost: "app.matrix-os.com",
            runtimeSlot: "staging",
            path: "/ws/terminal/session",
            session: "s",
            fromSeq: nil
        )
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let items = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(items["runtime"], "staging")
    }

    func testConnectionProfileResolvesGatewayURL() throws {
        let profile = ConnectionProfile(handle: "hamed", gatewayHost: "app.matrix-os.com", runtimeSlot: "staging")
        let url = try profile.gatewayBaseURL()
        XCTAssertEqual(url.absoluteString, "https://app.matrix-os.com?runtime=staging")
    }
}
