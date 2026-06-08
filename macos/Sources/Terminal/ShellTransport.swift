import Foundation

/// Abstraction over the WebSocket transport so the client state machine can be
/// driven deterministically in tests. Production impl wraps `URLSessionWebSocketTask`.
public protocol ShellTransport: Sendable {
    /// Opens a connection for `request` and returns a stream of received text frames.
    /// The stream finishes (optionally throwing) when the socket closes/errors.
    func open(_ request: URLRequest) async -> AsyncThrowingStream<String, Error>
    /// Sends a text frame to the server.
    func send(_ text: String) async throws
    /// Closes the active connection.
    func close() async
}

/// Abstraction over time so reconnect backoff is deterministic in tests.
public protocol ShellClock: Sendable {
    func sleep(seconds: Double) async
}

/// Production clock backed by `Task.sleep`.
public struct SystemClock: ShellClock {
    public init() {}
    public func sleep(seconds: Double) async {
        let nanos = UInt64((max(0, seconds) * 1_000_000_000).rounded())
        try? await Task.sleep(nanoseconds: nanos)
    }
}

/// Production transport over `URLSessionWebSocketTask`.
/// Auth travels in the `Authorization` header on the upgrade request (FR-015a / S1).
public actor URLSessionShellTransport: ShellTransport {
    private let session: URLSession
    private var task: URLSessionWebSocketTask?

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func open(_ request: URLRequest) async -> AsyncThrowingStream<String, Error> {
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        return AsyncThrowingStream { continuation in
            let receiver = Task {
                while !Task.isCancelled {
                    do {
                        let message = try await task.receive()
                        switch message {
                        case let .string(text):
                            continuation.yield(text)
                        case let .data(data):
                            if let text = String(data: data, encoding: .utf8) {
                                continuation.yield(text)
                            }
                        @unknown default:
                            break
                        }
                    } catch {
                        continuation.finish(throwing: error)
                        return
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                receiver.cancel()
            }
        }
    }

    public func send(_ text: String) async throws {
        guard let task else { throw URLError(.badServerResponse) }
        try await task.send(.string(text))
    }

    public func close() async {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }
}
