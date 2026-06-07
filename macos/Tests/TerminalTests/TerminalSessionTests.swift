import XCTest
@testable import MatrixTerminal

/// T034 — state-transition tests for `TerminalSession` against a mock event stream.
/// SwiftTerm view rendering is not unit-testable headlessly, so these assert the
/// view-model's published state, output sink wiring, and input/resize forwarding.
@MainActor
final class TerminalSessionTests: XCTestCase {
    private func makeSession(
        name: String = "zsh"
    ) -> (TerminalSession, MockShellEventSource) {
        let source = MockShellEventSource()
        let session = TerminalSession(displayName: name, client: source)
        return (session, source)
    }

    /// Awaits until `predicate` holds or a short timeout elapses (event delivery is async).
    private func eventually(
        _ predicate: @escaping @MainActor () -> Bool,
        timeout: TimeInterval = 2.0,
        _ message: String = "condition not met"
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            try? await Task.sleep(nanoseconds: 5_000_000) // 5ms
        }
        XCTFail(message)
    }

    /// Async-predicate variant of `eventually` for reading actor-isolated mock state.
    private func eventuallyAsync(
        _ predicate: @escaping () async -> Bool,
        timeout: TimeInterval = 2.0,
        _ message: String = "condition not met"
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await predicate() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail(message)
    }

    func testInitialStateIsConnecting() {
        let (session, _) = makeSession()
        XCTAssertEqual(session.connectionState, .connecting)
        XCTAssertEqual(session.lastSeq, 0)
        XCTAssertTrue(session.isPinnedToBottom)
    }

    func testStartConnectsTheClient() async {
        let (session, source) = makeSession()
        session.start()
        await eventuallyAsync({ await source.didConnect })
    }

    func testAttachedEventMovesToAttached() async {
        let (session, source) = makeSession()
        session.start()
        await source.emit(.attached(state: "running", fromSeq: 0))
        await eventually({ session.connectionState == .attached })
    }

    func testOutputAdvancesSeqAndFeedsSink() async {
        let (session, source) = makeSession()
        var fed: [String] = []
        session.setOutputSink { fed.append($0) }
        session.start()

        await source.emit(.output(seq: 1, data: "hello "))
        await source.emit(.output(seq: 2, data: "world"))

        await eventually({ session.lastSeq == 2 })
        XCTAssertEqual(fed, ["hello ", "world"])
        // A bare output (before an explicit attached) implies attachment.
        XCTAssertEqual(session.connectionState, .attached)
    }

    func testOutputBeforeSinkIsFlushedWhenSinkIsInstalled() async {
        let (session, source) = makeSession()
        var fed: [String] = []
        session.start()

        await source.emit(.output(seq: 1, data: "boot "))
        await source.emit(.output(seq: 2, data: "ready"))
        await eventually({ session.lastSeq == 2 })
        try? await Task.sleep(nanoseconds: 30_000_000)

        session.setOutputSink { fed.append($0) }

        await eventually({ fed == ["boot ready"] })
    }

    func testOutWhileScrolledUpAccumulatesUnseen() async {
        let (session, source) = makeSession()
        session.start()
        session.setPinnedToBottom(false)

        await source.emit(.output(seq: 1, data: "a"))
        await source.emit(.output(seq: 2, data: "b"))

        await eventually({ session.unseenLines == 2 })
        XCTAssertFalse(session.isPinnedToBottom)

        // Re-pinning clears the unseen counter.
        session.setPinnedToBottom(true)
        XCTAssertEqual(session.unseenLines, 0)
        XCTAssertTrue(session.isPinnedToBottom)
    }

    func testErrorEventMovesToGenericError() async {
        let (session, source) = makeSession()
        session.start()
        await source.emit(.error(code: "internal", message: "raw secret detail"))
        await eventually({
            if case .error(let code) = session.connectionState { return code == "internal" }
            return false
        })
        // The raw message must not be retained anywhere on the published state.
        if case .error(let code) = session.connectionState {
            XCTAssertFalse(code.contains("raw secret detail"))
        }
    }

    func testExitEventMovesToExitedWithCode() async {
        let (session, source) = makeSession()
        session.start()
        await source.emit(.exit(code: 137))
        await eventually({ session.connectionState == .exited(code: 137) })
    }

    func testReplayEvictedResetsAndReturnsToConnecting() async {
        let (session, source) = makeSession()
        session.start()
        await source.emit(.attached(state: "running", fromSeq: 0))
        await source.emit(.output(seq: 5, data: "x"))
        await eventually({ session.lastSeq == 5 })

        await source.emit(.replayEvicted)
        await eventually({ session.connectionState == .connecting && session.lastSeq == 0 })
        XCTAssertEqual(session.unseenLines, 0)
    }

    func testReconnectingThenAttachedClears() async {
        let (session, source) = makeSession()
        session.start()
        session.markReconnecting()
        XCTAssertEqual(session.connectionState, .reconnecting)

        await source.emit(.output(seq: 1, data: "back"))
        await eventually({ session.connectionState == .attached })
    }

    func testMarkReconnectingDoesNotOverrideTerminalStates() async {
        let (session, source) = makeSession()
        session.start()
        await source.emit(.exit(code: 0))
        await eventually({ session.connectionState == .exited(code: 0) })

        session.markReconnecting()
        XCTAssertEqual(session.connectionState, .exited(code: 0))
    }

    func testSendForwardsInput() async {
        let (session, source) = makeSession()
        session.send("ls\n")
        await eventuallyAsync({ await source.sentInputs == ["ls\n"] })
    }

    func testResizeForwardsAndRemembersSize() async {
        let (session, source) = makeSession()
        session.resize(cols: 120, rows: 40)
        await eventuallyAsync({ await source.resizes.first?.cols == 120 })
        let resizes = await source.resizes
        XCTAssertEqual(resizes.first?.cols, 120)
        XCTAssertEqual(resizes.first?.rows, 40)
    }

    func testResizeIgnoresNonPositiveDimensions() async {
        let (session, source) = makeSession()
        session.resize(cols: 0, rows: 0)
        // Give any (incorrect) forwarding a chance to land, then assert none did.
        try? await Task.sleep(nanoseconds: 50_000_000)
        let resizes = await source.resizes
        XCTAssertTrue(resizes.isEmpty)
    }

    func testAttachReSendsLastSize() async {
        let (session, source) = makeSession()
        session.start()
        session.resize(cols: 100, rows: 30)
        await eventuallyAsync({ await source.resizes.count >= 1 })

        await source.emit(.attached(state: "running", fromSeq: 0))
        // After attach there should be a second resize echoing the remembered size.
        await eventuallyAsync({ await source.resizes.count >= 2 })
        let resizes = await source.resizes
        XCTAssertGreaterThanOrEqual(resizes.count, 2)
        XCTAssertEqual(resizes.last?.cols, 100)
        XCTAssertEqual(resizes.last?.rows, 30)
    }

    func testDetachAndShutdownForward() async {
        let (session, source) = makeSession()
        session.start()
        session.detach()
        await eventuallyAsync({ await source.didDetach })

        session.shutdown()
        await eventuallyAsync({ await source.didShutdown })
    }
}
