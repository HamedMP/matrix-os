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

enum TerminalStartupSettlePolicy {
    static let steadyResizeDebounceNanoseconds: UInt64 = 90_000_000
    static let startupResizeDebounceNanoseconds: UInt64 = 220_000_000
    static let postStableAttachSettleNanoseconds: UInt64 = 300_000_000
    static let attachWithoutResizeFallbackNanoseconds: UInt64 = 900_000_000
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
    /// Stable identity used by SwiftUI/AppKit bridges. Terminal tabs must be keyed
    /// by the session object, otherwise AppKit may reuse a `TerminalView` whose
    /// delegate still points at a previous zellij session.
    public let id = UUID()

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

    /// Keeps SwiftTerm covered during the attach replay/first-layout burst. This
    /// prevents early clicks/focus and the visible fast cursor repaint until zellij
    /// has attached and the terminal has sent one settled size.
    @Published public private(set) var isStartupSettling: Bool = true

    private let client: ShellEventSource
    /// Sink for decoded PTY output text. The view installs this to feed SwiftTerm.
    /// Called on the main actor.
    private var outputSink: (@MainActor (String) -> Void)?
    private var attachHandlers: [@MainActor () -> Void] = []
    /// Coalesced output waiting to be fed into SwiftTerm. Feeding SwiftTerm once
    /// per websocket frame can fall behind under zellij bursts, causing zellij to
    /// disconnect the client. Drain at UI cadence instead.
    private var pendingOutput = ""
    private var outputFlushTask: Task<Void, Never>?
    private var consumeTask: Task<Void, Never>?
    private var started = false
    /// Latest requested terminal size, re-sent once after each successful attach.
    private var lastSize: (cols: Int, rows: Int)?
    /// Coalesced pending resize and its debounce task (see `resize`).
    private var pendingResize: (cols: Int, rows: Int)?
    private var resizeDebounceTask: Task<Void, Never>?
    private var hasAttachedSinceStartup = false
    private var hasStableResizeSinceStartup = false
    private var startupSettleTask: Task<Void, Never>?

    public init(displayName: String, client: ShellEventSource) {
        self.displayName = displayName
        self.client = client
    }

    deinit {
        consumeTask?.cancel()
        outputFlushTask?.cancel()
        resizeDebounceTask?.cancel()
        startupSettleTask?.cancel()
    }

    /// Installs the output sink (the SwiftTerm feed) before/while starting.
    public func setOutputSink(_ sink: @escaping @MainActor (String) -> Void) {
        outputSink = sink
        flushPendingOutput()
    }

    /// Runs once when the terminal first reaches an attached/output state.
    public func onNextAttach(_ handler: @escaping @MainActor () -> Void) {
        attachHandlers.append(handler)
    }

    /// Connects the client and begins consuming its event stream. Idempotent.
    @MainActor
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
        // Coalesce rapid size reports (initial layout, window drags, font changes).
        // SwiftTerm emits many intermediate grid sizes before settling; forwarding each
        // makes zellij thrash/rearrange panes and can leave it stuck at an early,
        // smaller-than-the-view grid. Debounce so only the settled size reaches the
        // server (the client re-sends it after each attach).
        pendingResize = (cols, rows)
        resizeDebounceTask?.cancel()
        let debounce = hasStableResizeSinceStartup
            ? TerminalStartupSettlePolicy.steadyResizeDebounceNanoseconds
            : TerminalStartupSettlePolicy.startupResizeDebounceNanoseconds
        resizeDebounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: debounce)
            guard !Task.isCancelled else { return }
            self?.flushPendingResize()
        }
    }

    private func flushPendingResize() {
        guard let size = pendingResize else { return }
        pendingResize = nil
        if let last = lastSize, last.cols == size.cols, last.rows == size.rows {
            markStableResize()
            return
        }
        lastSize = size
        markStableResize()
        let client = self.client
        Task { await client.resize(cols: size.cols, rows: size.rows) }
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
        flushPendingOutput()
        outputFlushTask?.cancel()
        outputFlushTask = nil
        resizeDebounceTask?.cancel()
        resizeDebounceTask = nil
        startupSettleTask?.cancel()
        startupSettleTask = nil
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
            resetStartupSettling(keepStableResize: lastSize != nil)
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
            markAttached()
            // Re-send the last known size once after attach (protocol requirement).
            if let size = lastSize {
                let client = self.client
                Task { await client.resize(cols: size.cols, rows: size.rows) }
            }
        case let .output(seq, data):
            lastSeq = max(lastSeq, seq)
            // A late output frame while still "connecting" implies we're attached.
            if case .connecting = connectionState { markAttached() }
            if case .reconnecting = connectionState { markAttached() }
            enqueueOutput(data)
            if !isPinnedToBottom {
                unseenLines += 1
            }
        case let .exit(code):
            connectionState = .exited(code: code)
            isStartupSettling = false
            startupSettleTask?.cancel()
        case let .error(code, _):
            // Never surface raw `message`; keep only the internal code.
            connectionState = .error(code: code)
            isStartupSettling = false
            startupSettleTask?.cancel()
        case .reconnecting:
            markReconnecting()
        case .replayEvicted:
            // Client cleared its buffer and re-attaches at live tail. Reset local seq
            // and show the connecting state until the next `attached`/`output`.
            lastSeq = 0
            unseenLines = 0
            connectionState = .connecting
            resetStartupSettling(keepStableResize: lastSize != nil)
        }
    }

    private func markAttached() {
        connectionState = .attached
        hasAttachedSinceStartup = true
        notifyAttached()
        scheduleStartupSettlingIfReady()
        scheduleAttachFallbackIfNeeded()
    }

    private func markStableResize() {
        hasStableResizeSinceStartup = true
        scheduleStartupSettlingIfReady()
    }

    private func resetStartupSettling(keepStableResize: Bool) {
        hasAttachedSinceStartup = false
        hasStableResizeSinceStartup = keepStableResize
        isStartupSettling = true
        startupSettleTask?.cancel()
        startupSettleTask = nil
    }

    private func scheduleStartupSettlingIfReady() {
        guard isStartupSettling, hasAttachedSinceStartup, hasStableResizeSinceStartup else { return }
        startupSettleTask?.cancel()
        startupSettleTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: TerminalStartupSettlePolicy.postStableAttachSettleNanoseconds)
            guard !Task.isCancelled else { return }
            self?.isStartupSettling = false
            self?.startupSettleTask = nil
        }
    }

    private func scheduleAttachFallbackIfNeeded() {
        guard isStartupSettling, !hasStableResizeSinceStartup else { return }
        startupSettleTask?.cancel()
        startupSettleTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: TerminalStartupSettlePolicy.attachWithoutResizeFallbackNanoseconds)
            guard let self, !Task.isCancelled else { return }
            guard self.isStartupSettling, self.hasAttachedSinceStartup else { return }
            self.isStartupSettling = false
            self.startupSettleTask = nil
        }
    }

    private func notifyAttached() {
        guard !attachHandlers.isEmpty else { return }
        let handlers = attachHandlers
        attachHandlers.removeAll(keepingCapacity: true)
        for handler in handlers {
            handler()
        }
    }

    private func enqueueOutput(_ data: String) {
        pendingOutput += data
        guard outputFlushTask == nil else { return }
        outputFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 16_000_000)
            self?.drainOutput()
        }
    }

    private func drainOutput() {
        outputFlushTask = nil
        flushPendingOutput()
    }

    private func flushPendingOutput() {
        guard !pendingOutput.isEmpty, let outputSink else { return }
        let chunk = pendingOutput
        pendingOutput.removeAll(keepingCapacity: true)
        outputSink(chunk)
    }
}
