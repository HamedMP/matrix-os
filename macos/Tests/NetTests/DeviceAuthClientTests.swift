import XCTest
@testable import MatrixNet

final class DeviceAuthClientTests: XCTestCase {
    private let platformURL = URL(string: "https://app.matrix-os.com")!

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient() -> DeviceAuthClient {
        DeviceAuthClient(platformURL: platformURL, sessionConfiguration: .mocked())
    }

    func testStartDeviceAuthParsesResponse() async throws {
        MockURLProtocol.setHandler { req in
            XCTAssertEqual(req.url?.path, "/api/auth/device/code")
            XCTAssertEqual(req.httpMethod, "POST")
            let json = """
            {"deviceCode":"DC","userCode":"ABCD-EFGH","verificationUri":"https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH","expiresIn":900,"interval":5}
            """
            return (httpResponse(req.url!, 200), Data(json.utf8))
        }
        let client = makeClient()
        let start = try await client.startDeviceAuth()
        XCTAssertEqual(start.deviceCode, "DC")
        XCTAssertEqual(start.userCode, "ABCD-EFGH")
        XCTAssertEqual(start.interval, 5)
        XCTAssertEqual(start.expiresIn, 900)
    }

    func testPollPendingReturnsPending() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 428), Data("{\"error\":\"authorization_pending\"}".utf8))
        }
        let client = makeClient()
        let result = try await client.pollForToken(deviceCode: "DC")
        guard case .pending = result else { return XCTFail("expected pending, got \(result)") }
    }

    func testPollSlowDownReturnsSlowDown() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 429), Data("{\"error\":\"slow_down\"}".utf8))
        }
        let client = makeClient()
        let result = try await client.pollForToken(deviceCode: "DC")
        guard case .slowDown = result else { return XCTFail("expected slowDown, got \(result)") }
    }

    func testPollExpiredReturnsExpired() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 410), Data("{\"error\":\"expired_token\"}".utf8))
        }
        let client = makeClient()
        let result = try await client.pollForToken(deviceCode: "DC")
        guard case .expired = result else { return XCTFail("expected expired, got \(result)") }
    }

    func testPollApprovedReturnsToken() async throws {
        MockURLProtocol.setHandler { req in
            let json = """
            {"accessToken":"JWT","expiresAt":"2026-01-01T00:00:00Z","userId":"user_1","handle":"hamed"}
            """
            return (httpResponse(req.url!, 200), Data(json.utf8))
        }
        let client = makeClient()
        let result = try await client.pollForToken(deviceCode: "DC")
        guard case let .approved(token) = result else { return XCTFail("expected approved, got \(result)") }
        XCTAssertEqual(token.accessToken, "JWT")
        XCTAssertEqual(token.handle, "hamed")
    }

    func testPollServerErrorThrowsGenericError() async {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 500), Data("internal postgres meltdown".utf8))
        }
        let client = makeClient()
        do {
            _ = try await client.pollForToken(deviceCode: "DC")
            XCTFail("expected throw")
        } catch let error as GatewayError {
            XCTAssertEqual(error, .server)
            XCTAssertFalse(error.userMessage.lowercased().contains("postgres"))
        } catch {
            XCTFail("expected GatewayError, got \(error)")
        }
    }
}
