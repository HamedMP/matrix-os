import Foundation

/// A minimal seam over the live shell connection so `TerminalSession` can be driven
/// deterministically in tests without a real socket. The production `ShellWSClient`
/// already exposes exactly this surface (an `events` `AsyncStream`, `connect`, input,
/// resize, detach, shutdown), so it conforms via the extension below — no behavioral
/// change to the client itself.
///
/// Tests inject a `MockShellEventSource` that yields `ServerEvent`s on demand.
public protocol ShellEventSource: Sendable {
    /// Stream of decoded server events for the terminal view-model to consume.
    var events: AsyncStream<ServerEvent> { get async }

    /// Starts the connect+reconnect run loop.
    func connect() async

    /// Sends a keystroke/byte payload to the PTY.
    func sendInput(_ data: String) async

    /// Records a resize; sent immediately if connected and once after each attach.
    func resize(cols: Int, rows: Int) async

    /// Detaches (leave session running) and stops reconnecting.
    func detach() async

    /// Stops the run loop and tears down the connection.
    func shutdown() async
}

extension ShellWSClient: ShellEventSource {}
