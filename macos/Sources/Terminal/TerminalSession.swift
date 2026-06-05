import Foundation
import SwiftUI

/// Connection/UI state for a terminal panel, derived from the shell-WS event stream.
///
/// These are calm, generic states surfaced to the user (design.md §6.4) — never a raw
/// error string. `error` carries an internal `code` for diagnostics/telemetry only; the
/// view renders a fixed generic message for it.
public enum TerminalConnectionState: Equatable, Sendable {
    /// Socket opening / waiting for the first `attached` ack.
    case connecting
    /// Attached and streaming live output.
    case attached
    /// Lost the connection; the client is backing off and retrying.
    case reconnecting
    /// The session/process exited (`exit`). Carries the exit code for the UI.
    case exited(code: Int)
    /// A generic, non-recoverable error. `code` is internal-only (not shown raw).
    case error(code: String)
}

/// `@MainActor` view-model that owns a `ShellEventSource` (the shell-WS client),
/// consumes its `AsyncStream<ServerEvent>`, and publishes UI-facing state for the
/// SwiftTerm-backed `TerminalPanelView`.
///
/// Responsibilities (T034 / US1):
/// - Drive connection state: `connecting → attached`, drop → `reconnecting`,
///   `exit → exited`, `error → error` (generic), `replay-evicted → connecting`
///   (buffer cleared; the client re-attaches at live tail).
/// - Feed `output` bytes to a sink (the SwiftTerm view) and track the last applied seq.
/// - Forward user keystrokes (`sendInput`) and `resize` to the client.
/// - Track scroll-pin ("● LIVE" vs "↓ N new") so the view can render the affordance.
@MainActor
public final class TerminalSession: ObservableObject {
    /// Human-readable session label shown in the top strip.
    public let displayName: String

    /// Current connection state (drives inline status UI).
    @Published public private(set) var connectionState: TerminalConnectionState = .connecting

    /// Last output `seq` applied to the terminal (0 before any output / after a reset).
    @Published public private(set) var lastSeq: Int = 0

    /// Whether the view is pinned to the live tail ("● LIVE"). When false the user has
    /// scrolled up and `unseenLines` accumulates ("↓ N new").
    @Published public private(set) var isPinnedToBottom: Bool = true

    /// Count of output flushes received while scrolled up (for the "↓ N new" badge).
    @Published public private(set) var unseenLines: Int = 0

    private let client: ShellEventSource
    /// Sink for decoded PTY output text. The view installs this to feed SwiftTerm.
    /// Called on the main actor.
    private var outputSink: (@MainActor (String) -> Void)?
    private var consumeTask: Task<Void, Never>?
    private var started = false
    /// Latest requested terminal size, re-sent once after each successful attach.
    private var lastSize: (cols: Int, rows: Int)?

    public init(displayName: String, client: ShellEventSource) {
        self.displayName = displayName
        self.client = client
    }

    deinit {
        consumeTask?.cancel()
    }

    /// Installs the output sink (the SwiftTerm feed) before/while starting.
    public func setOutputSink(_ sink: @escaping @MainActor (String) -> Void) {
        outputSink = sink
    }

    /// Connects the client and begins consuming its event stream. Idempotent.
    public func start() {
        guard !started else { return }
        started = true
        let client = self.client
        consumeTask = Task { [weak self] in
            await client.connect()
            let stream = await client.events
            for await event in stream {
                if Task.isCancelled { break }
                self?.apply(event)
            }
        }
    }

    /// Forwards a keystroke/byte payload to the PTY.
    public func send(_ data: String) {
        let client = self.client
        Task { await client.sendInput(data) }
    }

    /// Forwards a resize to the client and remembers it for re-send after attach.
    /// De-duplicates identical sizes so layout passes that report the same grid do
    /// not spam the server (which made zellij thrash/rearrange panes).
    public func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        if let last = lastSize, last.cols == cols, last.rows == rows { return }
        lastSize = (cols, rows)
        let client = self.client
        Task { await client.resize(cols: cols, rows: rows) }
    }

    /// Detaches (leaves the session running) and stops consuming.
    public func detach() {
        consumeTask?.cancel()
        let client = self.client
        Task { await client.detach() }
    }

    /// Tears down the connection and stops consuming.
    public func shutdown() {
        consumeTask?.cancel()
        consumeTask = nil
        let client = self.client
        Task { await client.shutdown() }
    }

    /// Marks the session as reconnecting. The shell-WS client reconnects internally
    /// (it does not emit a disconnect event), so the transport-aware layer drives this
    /// when it observes a socket drop; the next `attached`/`output` clears it.
    public func markReconnecting() {
        switch connectionState {
        case .exited, .error:
            return // terminal states are not overridden by a transient drop
        default:
            connectionState = .reconnecting
        }
    }

    // MARK: - Scroll pin (driven by the SwiftTerm view's scroll delegate)

    /// Updates the pinned-to-bottom affordance. Pinning back to the bottom clears the
    /// unseen counter ("↓ N new" → "● LIVE").
    public func setPinnedToBottom(_ pinned: Bool) {
        if pinned {
            unseenLines = 0
        }
        isPinnedToBottom = pinned
    }

    // MARK: - Event application

    private func apply(_ event: ServerEvent) {
        switch event {
        case .attached:
            connectionState = .attached
            // Re-send the last known size once after attach (protocol requirement).
            if let size = lastSize {
                let client = self.client
                Task { await client.resize(cols: size.cols, rows: size.rows) }
            }
        case let .output(seq, data):
            lastSeq = max(lastSeq, seq)
            // A late output frame while still "connecting" implies we're attached.
            if case .connecting = connectionState { connectionState = .attached }
            if case .reconnecting = connectionState { connectionState = .attached }
            outputSink?(data)
            if !isPinnedToBottom {
                unseenLines += 1
            }
        case let .exit(code):
            connectionState = .exited(code: code)
        case let .error(code, _):
            // Never surface raw `message`; keep only the internal code.
            connectionState = .error(code: code)
        case .replayEvicted:
            // Client cleared its buffer and re-attaches at live tail. Reset local seq
            // and show the connecting state until the next `attached`/`output`.
            lastSeq = 0
            unseenLines = 0
            connectionState = .connecting
        }
    }
}
