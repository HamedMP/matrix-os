import XCTest
@testable import MatrixTerminal

// T024 — failing-first state-machine + codec tests for ShellWSClient.
// No real socket/network: a MockShellTransport + manual clock drive the actor
// deterministically. Wire shapes mirror packages/gateway/src/shell/ws.ts.

final class ShellMessageCodecTests: XCTestCase {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: ClientMessage encoding

    func testClientInputEncodesWireShape() throws {
        let data = try encoder.encode(ClientMessage.input(data: "ls -la\n"))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "input")
        XCTAssertEqual(obj?["data"] as? String, "ls -la\n")
        XCTAssertEqual(obj?.count, 2)
    }

    func testClientResizeEncodesWireShape() throws {
        let data = try encoder.encode(ClientMessage.resize(cols: 120, rows: 40))
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "resize")
        XCTAssertEqual(obj?["cols"] as? Int, 120)
        XCTAssertEqual(obj?["rows"] as? Int, 40)
    }

    func testClientDetachEncodesWireShape() throws {
        let data = try encoder.encode(ClientMessage.detach)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "detach")
        XCTAssertEqual(obj?.count, 1)
    }

    func testClientPingEncodesWireShape() throws {
        let data = try encoder.encode(ClientMessage.ping)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "ping")
        XCTAssertEqual(obj?.count, 1)
    }

    func testClientMessageRoundTrips() throws {
        let cases: [ClientMessage] = [
            .input(data: "x"),
            .resize(cols: 80, rows: 24),
            .detach,
            .ping,
        ]
        for message in cases {
            let encoded = try encoder.encode(message)
            let decoded = try decoder.decode(ClientMessage.self, from: encoded)
            XCTAssertEqual(decoded, message)
        }
    }

    // MARK: ServerMessage decoding

    func testServerAttachedDecodes() throws {
        let json = #"{"type":"attached","session":"main","state":"running","fromSeq":12}"#
        let message = try decoder.decode(ServerMessage.self, from: Data(json.utf8))
        guard case let .attached(session, state, fromSeq) = message else {
            return XCTFail("expected attached, got \(message)")
        }
        XCTAssertEqual(session, "main")
        XCTAssertEqual(state, "running")
        XCTAssertEqual(fromSeq, 12)
    }

    func testServerOutputDecodes() throws {
        let json = #"{"type":"output","seq":7,"data":"hello"}"#
        let message = try decoder.decode(ServerMessage.self, from: Data(json.utf8))
        guard case let .output(seq, data) = message else {
            return XCTFail("expected output, got \(message)")
        }
        XCTAssertEqual(seq, 7)
        XCTAssertEqual(data, "hello")
    }

    func testServerExitDecodes() throws {
        let json = #"{"type":"exit","code":0}"#
        let message = try decoder.decode(ServerMessage.self, from: Data(json.utf8))
        guard case let .exit(code) = message else {
            return XCTFail("expected exit, got \(message)")
        }
        XCTAssertEqual(code, 0)
    }

    func testServerErrorDecodes() throws {
        let json = #"{"type":"error","code":"session_not_found","message":"Session not found"}"#
        let message = try decoder.decode(ServerMessage.self, from: Data(json.utf8))
        guard case let .error(code, text) = message else {
            return XCTFail("expected error, got \(message)")
        }
        XCTAssertEqual(code, "session_not_found")
        XCTAssertEqual(text, "Session not found")
    }

    func testServerPongDecodes() throws {
        let json = #"{"type":"pong"}"#
        let message = try decoder.decode(ServerMessage.self, from: Data(json.utf8))
        guard case .pong = message else {
            return XCTFail("expected pong, got \(message)")
        }
    }

    func testServerReplayEvictedDecodes() throws {
        let json = #"{"type":"replay-evicted","fromSeq":3,"nextSeq":50}"#
        let message = try decoder.decode(ServerMessage.self, from: Data(json.utf8))
        guard case let .replayEvicted(fromSeq, nextSeq) = message else {
            return XCTFail("expected replayEvicted, got \(message)")
        }
        XCTAssertEqual(fromSeq, 3)
        XCTAssertEqual(nextSeq, 50)
    }

    func testUnknownServerTypeThrows() {
        let json = #"{"type":"nope"}"#
        XCTAssertThrowsError(try decoder.decode(ServerMessage.self, from: Data(json.utf8)))
    }
}

final class ShellWSClientStateMachineTests: XCTestCase {
    func testLiveTailSentinelIsMaxSafeInteger() {
        // Mirrors packages/sync-client/src/protocol/shell.js (Number.MAX_SAFE_INTEGER).
        XCTAssertEqual(SHELL_ATTACH_LIVE_TAIL_FROM_SEQ, 9_007_199_254_740_991)
        XCTAssertEqual(SHELL_ATTACH_RECENT_REPLAY_EVENTS, 50)
    }

    func testFirstConnectAttachesAtLiveTail() async throws {
        let transport = MockShellTransport()
        let client = ShellWSClient(
            url: URL(string: "wss://vps.example/ws/terminal/session")!,
            token: "secret-token",
            session: "main",
            transport: transport,
            backoff: .test,
            clock: MockClock()
        )
        await client.connect()
        await transport.waitForConnect(count: 1)
        let first = await transport.lastConnectRequest
        // Auth must be a header, never a query token (FR-015a / S1).
        XCTAssertEqual(first?.value(forHTTPHeaderField: "Authorization"), "Bearer secret-token")
        let query = first?.url?.query ?? ""
        XCTAssertFalse(query.contains("token="), "token must not be in query: \(query)")
        XCTAssertTrue(query.contains("session=main"))
        XCTAssertTrue(query.contains("fromSeq=\(SHELL_ATTACH_LIVE_TAIL_FROM_SEQ)"))
        await client.shutdown()
    }

    func testLastSeqAdvancesOnOutput() async throws {
        let transport = MockShellTransport()
        let client = makeClient(transport: transport)
        await client.connect()
        await transport.waitForConnect(count: 1)
        await transport.emit(#"{"type":"attached","session":"main","state":"running","fromSeq":0}"#)
        await transport.emit(#"{"type":"output","seq":1,"data":"a"}"#)
        await transport.emit(#"{"type":"output","seq":2,"data":"b"}"#)
        // drain the three events (attached + 2 output)
        var seen: [ServerEvent] = []
        let stream = await client.events
        for await event in stream {
            seen.append(event)
            if seen.count == 3 { break }
        }
        let lastSeq = await client.lastSeq
        XCTAssertEqual(lastSeq, 2)
        await client.shutdown()
    }

    func testReconnectResumesFromLastSeqPlusOne() async throws {
        let transport = MockShellTransport()
        let clock = MockClock()
        let client = makeClient(transport: transport, clock: clock)
        await client.connect()
        await transport.waitForConnect(count: 1)
        await transport.emit(#"{"type":"output","seq":5,"data":"x"}"#)
        _ = await drain(client, count: 1)
        // simulate server-side disconnect → run loop parks in backoff sleep
        await transport.failCurrent()
        await clock.waitForSleeper()
        await clock.advanceAll()
        await transport.waitForConnect(count: 2)
        let reconnect = await transport.lastConnectRequest
        let query = reconnect?.url?.query ?? ""
        XCTAssertTrue(query.contains("fromSeq=6"), "expected resume fromSeq=6, got \(query)")
        await client.shutdown()
    }

    func testReplayEvictedResetsToLiveTail() async throws {
        let transport = MockShellTransport()
        let clock = MockClock()
        let client = makeClient(transport: transport, clock: clock)
        await client.connect()
        await transport.waitForConnect(count: 1)
        await transport.emit(#"{"type":"output","seq":9,"data":"y"}"#)
        _ = await drain(client, count: 1)
        let seqAfterOutput = await client.lastSeq
        XCTAssertEqual(seqAfterOutput, 9)

        // replay-evicted: client clears buffer + seq, drops the socket, re-attaches at live tail.
        await transport.emit(#"{"type":"replay-evicted","fromSeq":6,"nextSeq":40}"#)
        _ = await drain(client, count: 1) // the .replayEvicted event
        await clock.waitForSleeper()
        await clock.advanceAll()
        await transport.waitForConnect(count: 2)

        let lastSeq = await client.lastSeq
        XCTAssertEqual(lastSeq, 0, "buffer/seq must reset after replay-evicted")
        let reattach = await transport.lastConnectRequest
        let query = reattach?.url?.query ?? ""
        XCTAssertTrue(query.contains("fromSeq=\(SHELL_ATTACH_LIVE_TAIL_FROM_SEQ)"), "got \(query)")
        await client.shutdown()
    }

    func testBackoffIsBoundedAndCapped() {
        let policy = BackoffPolicy(base: 0.5, factor: 2, cap: 8, jitter: 0)
        let delays = (0..<8).map { policy.delay(forAttempt: $0) }
        // 0.5, 1, 2, 4, 8, 8, 8, 8 — never exceeds cap.
        XCTAssertEqual(delays[0], 0.5, accuracy: 0.0001)
        XCTAssertEqual(delays[1], 1.0, accuracy: 0.0001)
        XCTAssertEqual(delays[2], 2.0, accuracy: 0.0001)
        XCTAssertEqual(delays[3], 4.0, accuracy: 0.0001)
        XCTAssertEqual(delays[4], 8.0, accuracy: 0.0001)
        for delay in delays {
            XCTAssertLessThanOrEqual(delay, policy.cap)
            XCTAssertGreaterThanOrEqual(delay, 0)
        }
    }

    func testBackoffJitterStaysWithinBounds() {
        let policy = BackoffPolicy(base: 1, factor: 2, cap: 30, jitter: 0.5)
        for attempt in 0..<10 {
            let delay = policy.delay(forAttempt: attempt)
            XCTAssertGreaterThanOrEqual(delay, 0)
            XCTAssertLessThanOrEqual(delay, policy.cap)
        }
    }

    // MARK: Ring buffer

    func testRingBufferEvictsAtCap() {
        var ring = ScrollbackRing(capacity: 3)
        ring.append(seq: 1, data: "a")
        ring.append(seq: 2, data: "b")
        ring.append(seq: 3, data: "c")
        ring.append(seq: 4, data: "d")
        XCTAssertEqual(ring.count, 3)
        XCTAssertEqual(ring.oldestSeq, 2)
        XCTAssertEqual(ring.newestSeq, 4)
    }

    func testRingBufferClearResets() {
        var ring = ScrollbackRing(capacity: 4)
        ring.append(seq: 1, data: "a")
        ring.append(seq: 2, data: "b")
        ring.clear()
        XCTAssertEqual(ring.count, 0)
        XCTAssertNil(ring.newestSeq)
    }

    // MARK: helpers

    private func makeClient(transport: MockShellTransport, clock: MockClock = MockClock()) -> ShellWSClient {
        ShellWSClient(
            url: URL(string: "wss://vps.example/ws/terminal/session")!,
            token: "secret-token",
            session: "main",
            transport: transport,
            backoff: .test,
            clock: clock
        )
    }

    private func drain(_ client: ShellWSClient, count: Int) async -> [ServerEvent] {
        var seen: [ServerEvent] = []
        let stream = await client.events
        for await event in stream {
            seen.append(event)
            if seen.count == count { break }
        }
        return seen
    }
}
