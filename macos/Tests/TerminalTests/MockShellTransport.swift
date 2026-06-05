import Foundation
@testable import MatrixTerminal

// Deterministic in-memory transport + clock so ShellWSClient state-machine tests
// run with no real socket or wall-clock sleeps. All waiting is signal-based
// (no polling) so there are no missed-wakeup races against the actor run loop.

actor MockShellTransport: ShellTransport {
    private(set) var connectCount = 0
    private(set) var lastConnectRequest: URLRequest?
    private var continuation: AsyncThrowingStream<String, Error>.Continuation?
    private var connectWaiters: [(target: Int, continuation: CheckedContinuation<Void, Never>)] = []

    func open(_ request: URLRequest) -> AsyncThrowingStream<String, Error> {
        connectCount += 1
        lastConnectRequest = request
        resolveConnectWaiters()
        return AsyncThrowingStream { continuation in
            self.continuation = continuation
        }
    }

    func send(_ text: String) async throws {
        // No-op for state-machine tests; client→server payloads are asserted via codec tests.
    }

    func close() {
        continuation?.finish()
        continuation = nil
    }

    // MARK: test drivers

    func emit(_ json: String) {
        continuation?.yield(json)
    }

    func failCurrent() {
        continuation?.finish(throwing: ShellTransportError.disconnected)
        continuation = nil
    }

    /// Suspends until at least `count` connections have been opened.
    func waitForConnect(count: Int) async {
        if connectCount >= count { return }
        await withCheckedContinuation { continuation in
            connectWaiters.append((count, continuation))
        }
    }

    private func resolveConnectWaiters() {
        let ready = connectWaiters.filter { connectCount >= $0.target }
        connectWaiters.removeAll { connectCount >= $0.target }
        for waiter in ready { waiter.continuation.resume() }
    }
}

enum ShellTransportError: Error {
    case disconnected
}

actor MutableTokenProvider {
    private var value: String

    init(_ value: String) {
        self.value = value
    }

    func token() -> String {
        value
    }

    func set(_ value: String) {
        self.value = value
    }
}

/// A clock whose sleeps complete only when the test advances them. Uses a latch
/// so an `advanceAll()` that arrives before the run loop parks is not lost — the
/// next `sleep` returns immediately. Also exposes `waitForSleeper()` so tests can
/// await the run loop reaching its backoff park deterministically.
actor MockClock: ShellClock {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var pendingAdvances = 0
    private var sleeperWaiters: [CheckedContinuation<Void, Never>] = []

    func sleep(seconds: Double) async {
        if pendingAdvances > 0 {
            pendingAdvances -= 1
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
            let parked = sleeperWaiters
            sleeperWaiters.removeAll()
            for waiter in parked { waiter.resume() }
        }
    }

    /// Releases all parked sleepers; if none are parked, latches one advance for the next sleep.
    func advanceAll() {
        if waiters.isEmpty {
            pendingAdvances += 1
            return
        }
        let parked = waiters
        waiters.removeAll()
        for waiter in parked { waiter.resume() }
    }

    /// Suspends until the run loop is parked in `sleep` (a backoff wait).
    func waitForSleeper() async {
        if !waiters.isEmpty { return }
        await withCheckedContinuation { continuation in
            sleeperWaiters.append(continuation)
        }
    }
}
