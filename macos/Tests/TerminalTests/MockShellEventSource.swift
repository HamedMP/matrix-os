import Foundation
@testable import MatrixTerminal

/// Deterministic in-memory `ShellEventSource` for `TerminalSession` state-machine tests.
/// Tests `emit(_:)` `ServerEvent`s and the session applies them on the main actor.
/// Sent input/resize/detach/shutdown calls are recorded for assertions.
actor MockShellEventSource: ShellEventSource {
    private let stream: AsyncStream<ServerEvent>
    private let continuation: AsyncStream<ServerEvent>.Continuation

    private(set) var didConnect = false
    private(set) var sentInputs: [String] = []
    private(set) var resizes: [(cols: Int, rows: Int)] = []
    private(set) var didDetach = false
    private(set) var didShutdown = false

    init() {
        var cont: AsyncStream<ServerEvent>.Continuation!
        self.stream = AsyncStream { cont = $0 }
        self.continuation = cont
    }

    var events: AsyncStream<ServerEvent> { stream }

    func connect() { didConnect = true }

    func sendInput(_ data: String) { sentInputs.append(data) }

    func resize(cols: Int, rows: Int) { resizes.append((cols, rows)) }

    func detach() { didDetach = true }

    func shutdown() {
        didShutdown = true
        continuation.finish()
    }

    // MARK: test driver

    /// Pushes a server event into the stream consumed by the session.
    func emit(_ event: ServerEvent) {
        continuation.yield(event)
    }

    func finish() {
        continuation.finish()
    }
}
