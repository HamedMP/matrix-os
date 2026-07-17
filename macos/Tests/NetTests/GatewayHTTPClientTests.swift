import XCTest
@testable import MatrixNet

final class GatewayHTTPClientTests: XCTestCase {
    private struct Sample: Codable, Equatable { let id: String; let count: Int }
    private struct Payload: Codable, Equatable { let title: String }

    private let baseURL = URL(string: "https://app.matrix-os.com")!

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient(token: String? = "principal-token", timeout: TimeInterval = 10) -> GatewayHTTPClient {
        GatewayHTTPClient(
            baseURL: baseURL,
            tokenProvider: StaticTokenProvider(token: token),
            sessionConfiguration: .mocked(),
            defaultTimeout: timeout
        )
    }

    func testGetDecodesAndSetsAuthorizationHeader() async throws {
        MockURLProtocol.setHandler { req in
            let body = try JSONEncoder().encode(Sample(id: "abc", count: 3))
            return (httpResponse(req.url!, 200), body)
        }
        let client = makeClient()
        let result: Sample = try await client.get("/api/workspace/projects", as: Sample.self)
        XCTAssertEqual(result, Sample(id: "abc", count: 3))

        let req = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer principal-token")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.url?.path, "/api/workspace/projects")
    }

    func testGetPreservesBaseRuntimeAndRelativeQuery() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), Data("{\"id\":\"abc\",\"count\":3}".utf8))
        }
        let client = GatewayHTTPClient(
            baseURL: URL(string: "https://app.matrix-os.com?runtime=staging")!,
            tokenProvider: StaticTokenProvider(token: "principal-token"),
            sessionConfiguration: .mocked()
        )
        let _: Sample = try await client.get("/api/files/list?path=projects/matrix-os", as: Sample.self)

        let req = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertEqual(req.url?.path, "/api/files/list")
        let query = req.url?.query ?? ""
        XCTAssertTrue(query.contains("runtime=staging"), query)
        XCTAssertTrue(query.contains("path=projects/matrix-os"), query)
    }

    func testGetAppendsPathBelowBasePathAndPreservesRepeatedQueryItems() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), Data("{\"id\":\"abc\",\"count\":3}".utf8))
        }
        let client = GatewayHTTPClient(
            baseURL: URL(string: "https://app.matrix-os.com/vm/alice?runtime=staging")!,
            tokenProvider: StaticTokenProvider(token: "principal-token"),
            sessionConfiguration: .mocked()
        )
        let _: Sample = try await client.get("/api/search?tag=one&tag=two", as: Sample.self)

        let req = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertEqual(req.url?.path, "/vm/alice/api/search")
        let items = URLComponents(url: try XCTUnwrap(req.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.filter { $0.name == "runtime" }.map(\.value), ["staging"])
        XCTAssertEqual(items.filter { $0.name == "tag" }.map(\.value), ["one", "two"])
    }

    func testRelativeQueryOverridesMatchingBaseQueryKeys() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), Data("{\"id\":\"abc\",\"count\":3}".utf8))
        }
        let client = GatewayHTTPClient(
            baseURL: URL(string: "https://app.matrix-os.com/vm/alice?runtime=staging&flag=1")!,
            tokenProvider: StaticTokenProvider(token: "principal-token"),
            sessionConfiguration: .mocked()
        )
        let _: Sample = try await client.get("/api/search?runtime=production&runtime=canary", as: Sample.self)

        let req = try XCTUnwrap(MockURLProtocol.lastRequest)
        let items = URLComponents(url: try XCTUnwrap(req.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.filter { $0.name == "flag" }.map(\.value), ["1"])
        XCTAssertEqual(items.filter { $0.name == "runtime" }.map(\.value), ["production", "canary"])
    }

    func testTimeoutIsConfiguredOnRequest() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), Data("{\"id\":\"x\",\"count\":1}".utf8))
        }
        let client = makeClient(timeout: 7)
        _ = try await client.get("/api/workspace/projects", as: Sample.self)
        let req = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertEqual(req.timeoutInterval, 7, accuracy: 0.001)
    }

    func testNoAuthorizationHeaderWhenTokenMissing() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), Data("{\"id\":\"x\",\"count\":1}".utf8))
        }
        let client = makeClient(token: nil)
        _ = try await client.get("/api/workspace/projects", as: Sample.self)
        let req = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
    }

    func testPostSendsBodyAndDecodes() async throws {
        MockURLProtocol.setHandler { req in
            // body is delivered via httpBodyStream under URLProtocol; assert method/path here.
            let body = try JSONEncoder().encode(Sample(id: "new", count: 9))
            return (httpResponse(req.url!, 201), body)
        }
        let client = makeClient()
        let result: Sample = try await client.post("/api/projects/foo/tasks", body: Payload(title: "hi"), as: Sample.self)
        XCTAssertEqual(result, Sample(id: "new", count: 9))
        let req = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testPatchUsesPatchMethod() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), try JSONEncoder().encode(Sample(id: "p", count: 1)))
        }
        let client = makeClient()
        let _: Sample = try await client.patch("/api/projects/foo/tasks/1", body: Payload(title: "x"), as: Sample.self)
        XCTAssertEqual(MockURLProtocol.lastRequest?.httpMethod, "PATCH")
    }

    func testRawGetReturnsData() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), Data("hello".utf8))
        }
        let client = makeClient()
        let data = try await client.getData("/files/projects/demo/README.md")
        XCTAssertEqual(String(data: data, encoding: .utf8), "hello")
        XCTAssertEqual(MockURLProtocol.lastRequest?.httpMethod, "GET")
    }

    func testPutDataUsesPutAndContentType() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), Data("{}".utf8))
        }
        let client = makeClient()
        try await client.putData("/files/projects/demo/README.md", data: Data("saved".utf8))
        let req = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertEqual(req.httpMethod, "PUT")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "text/plain; charset=utf-8")
    }

    func testDeleteUsesDeleteMethod() async throws {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), Data("{}".utf8))
        }
        let client = makeClient()
        try await client.delete("/api/projects/foo/tasks/1")
        XCTAssertEqual(MockURLProtocol.lastRequest?.httpMethod, "DELETE")
    }

    // MARK: - Error mapping (generic, no leakage)

    func testUnauthorizedMapsTo401() async {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 401), Data("Postgres connection string leaked: postgres://secret".utf8))
        }
        let client = makeClient()
        await assertThrows(client) { _ = try await $0.get("/x", as: Sample.self) } expecting: { error in
            XCTAssertEqual(error, .unauthorized)
        }
    }

    func testNotFoundMapsTo404() async {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 404), Data("/home/matrix/secret/path not found".utf8))
        }
        let client = makeClient()
        await assertThrows(client) { _ = try await $0.get("/x", as: Sample.self) } expecting: { error in
            XCTAssertEqual(error, .notFound)
        }
    }

    func testServerErrorMapsToServerForAll5xx() async {
        for status in [500, 502, 503] {
            MockURLProtocol.setHandler { req in
                (httpResponse(req.url!, status), Data("Twilio upstream exploded: account SID AC123".utf8))
            }
            let client = makeClient()
            await assertThrows(client) { _ = try await $0.get("/x", as: Sample.self) } expecting: { error in
                XCTAssertEqual(error, .server)
            }
        }
    }

    func testUnexpectedClientStatusMapsToServer() async {
        // A non-401/404 4xx still must not leak; map to a generic bucket.
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 418), Data("teapot internals".utf8))
        }
        let client = makeClient()
        await assertThrows(client) { _ = try await $0.get("/x", as: Sample.self) } expecting: { error in
            XCTAssertEqual(error, .server)
        }
    }

    func testConflictPreservesAllowlistedSafeErrorCode() async {
        MockURLProtocol.setHandler { req in
            (
                httpResponse(req.url!, 409),
                Data(#"{"error":{"code":"session_exists","message":"Postgres path /secret leaked"}}"#.utf8)
            )
        }
        let client = makeClient()
        await assertThrows(client) { _ = try await $0.get("/x", as: Sample.self) } expecting: { error in
            XCTAssertEqual(error, .conflict(code: "session_exists"))
            XCTAssertEqual(error.safeCode, "session_exists")
            XCTAssertFalse(error.userMessage.lowercased().contains("postgres"))
            XCTAssertFalse(error.userMessage.contains("/secret"))
        }
    }

    func testMalformedJSONMapsToDecoding() async {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 200), Data("not json at all".utf8))
        }
        let client = makeClient()
        await assertThrows(client) { _ = try await $0.get("/x", as: Sample.self) } expecting: { error in
            XCTAssertEqual(error, .decoding)
        }
    }

    func testTransportTimeoutMapsToTimeout() async {
        MockURLProtocol.setHandler { _ in throw URLError(.timedOut) }
        let client = makeClient()
        await assertThrows(client) { _ = try await $0.get("/x", as: Sample.self) } expecting: { error in
            XCTAssertEqual(error, .timeout)
        }
    }

    func testTransportFailureMapsToNetwork() async {
        MockURLProtocol.setHandler { _ in throw URLError(.cannotConnectToHost) }
        let client = makeClient()
        await assertThrows(client) { _ = try await $0.get("/x", as: Sample.self) } expecting: { error in
            XCTAssertEqual(error, .network)
        }
    }

    func testErrorDescriptionNeverLeaksServerBody() async {
        MockURLProtocol.setHandler { req in
            (httpResponse(req.url!, 500), Data("postgres://user:pass@db internal stack trace".utf8))
        }
        let client = makeClient()
        await assertThrows(client) { _ = try await $0.get("/x", as: Sample.self) } expecting: { error in
            let text = error.userMessage + " " + String(describing: error)
            XCTAssertFalse(text.lowercased().contains("postgres"))
            XCTAssertFalse(text.contains("stack trace"))
        }
    }

    // MARK: - helper

    private func assertThrows(
        _ client: GatewayHTTPClient,
        _ block: (GatewayHTTPClient) async throws -> Void,
        expecting: (GatewayError) -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await block(client)
            XCTFail("expected GatewayError to be thrown", file: file, line: line)
        } catch let error as GatewayError {
            expecting(error)
        } catch {
            XCTFail("expected GatewayError, got \(error)", file: file, line: line)
        }
    }
}
