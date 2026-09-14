import Foundation

/// Shell terminal WebSocket client (T024/T025).
///
/// Implements `contracts/shell-ws-protocol.md`:
/// - Connects to the gateway shell-WS route with `Authorization: Bearer <token>`
///   on the upgrade (FR-015a / S1 — header auth, never a query token).
/// - Tracks `lastSeq` from `output` frames; on reconnect resumes at `lastSeq + 1`.
/// - On a fresh connect attaches at the live-tail sentinel.
/// - On `replay-evicted` clears its buffer and re-attaches at live tail (accepts
///   the unrecoverable gap; never duplicates or silently re-requests evicted seqs).
/// - Bounded exponential reconnect backoff with jitter (F1) and a bounded
///   scrollback ring buffer with eviction (R1).
public actor ShellWSClient {
    private let baseURL: URL
    private let tokenProvider: @Sendable () async -> String
    private let terminalRef: TerminalRef?
    private let transport: ShellTransport
    private let backoff: BackoffPolicy
    private let clock: ShellClock
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var ring: ScrollbackRing
    private var lastSeqValue: Int = 0
    private var lastRevisionValue: Int = -1
    private var pendingSize: (cols: Int, rows: Int)?
    private var pendingInputs: [String] = []
    private var isAttached = false
    private var runLoop: Task<Void, Never>?
    private var heartbeatLoop: Task<Void, Never>?
    private var stopped = false

    private let eventStream: AsyncStream<ServerEvent>
    private let eventContinuation: AsyncStream<ServerEvent>.Continuation

    public init(
        url: URL,
        token: String,
        terminalRef: String,
        transport: ShellTransport,
        backoff: BackoffPolicy = .default,
        clock: ShellClock = SystemClock(),
        scrollbackCapacity: Int = 5_000
    ) {
        self.init(
            url: url,
            tokenProvider: { token },
            terminalRef: terminalRef,
            transport: transport,
            backoff: backoff,
            clock: clock,
            scrollbackCapacity: scrollbackCapacity
        )
    }

    public init(
        url: URL,
        tokenProvider: @escaping @Sendable () async -> String,
        terminalRef: String,
        transport: ShellTransport,
        backoff: BackoffPolicy = .default,
        clock: ShellClock = SystemClock(),
        scrollbackCapacity: Int = 5_000
    ) {
        self.baseURL = url
        self.tokenProvider = tokenProvider
        self.terminalRef = TerminalRef(key: terminalRef)
        self.transport = transport
        self.backoff = backoff
        self.clock = clock
        self.ring = ScrollbackRing(capacity: scrollbackCapacity)
        var continuation: AsyncStream<ServerEvent>.Continuation!
        self.eventStream = AsyncStream { continuation = $0 }
        self.eventContinuation = continuation
    }

    /// Stream of decoded server events for consumers (the terminal view).
    public var events: AsyncStream<ServerEvent> { eventStream }

    /// Last applied output sequence number (0 before any output / after reset).
    public var lastSeq: Int { lastSeqValue }

    /// Starts the connect+reconnect run loop.
    public func connect() {
        guard runLoop == nil, !stopped else { return }
        runLoop = Task { [weak self] in
            await self?.runUntilStopped()
        }
    }

    /// Sends a keystroke/byte payload to the PTY.
    public func sendInput(_ data: String) async {
        guard isAttached else {
            pendingInputs.append(data)
            if pendingInputs.count > 256 {
                pendingInputs.removeFirst(pendingInputs.count - 256)
            }
            return
        }
        guard let terminalRef else { return }
        await sendClient(.input(ref: terminalRef, data: data))
    }

    /// Records a resize; sent immediately if connected and once after each attach.
    public func resize(cols: Int, rows: Int) async {
        pendingSize = (cols, rows)
        guard let terminalRef else { return }
        await sendClient(.resize(ref: terminalRef, cols: cols, rows: rows))
    }

    /// Detaches (leave session running) and stops reconnecting.
    public func detach() async {
        if let terminalRef { await sendClient(.detach(ref: terminalRef)) }
        await shutdown()
    }

    /// Stops the run loop and tears down the connection.
    public func shutdown() async {
        stopped = true
        runLoop?.cancel()
        runLoop = nil
        heartbeatLoop?.cancel()
        heartbeatLoop = nil
        await transport.close()
        eventContinuation.finish()
    }

    // MARK: - Run loop

    private func runUntilStopped() async {
        var attempt = 0
        while !stopped && !Task.isCancelled {
            // Fresh connect → live tail; reconnect → resume at lastSeq + 1.
            let fromSeq = lastSeqValue > 0 ? lastSeqValue + 1 : SHELL_ATTACH_LIVE_TAIL_FROM_SEQ
            let request = await makeRequest(fromSeq: fromSeq)
            let frames = await transport.open(request)
            let cleanly = await consume(frames)
            if stopped || Task.isCancelled { break }
            isAttached = false
            heartbeatLoop?.cancel()
            heartbeatLoop = nil
            attempt = cleanly ? 0 : attempt + 1
            if !cleanly && attempt == 2 {
                eventContinuation.yield(.error(code: "connection_failed", message: "Terminal connection failed"))
            } else {
                eventContinuation.yield(.reconnecting)
            }
            await clock.sleep(seconds: backoff.delay(forAttempt: attempt))
        }
    }

    /// Drains one connection's frame stream. Returns `true` if it closed cleanly.
    private func consume(_ frames: AsyncThrowingStream<String, Error>) async -> Bool {
        do {
            for try await raw in frames {
                if stopped { return true }
                await handle(raw)
            }
            return true
        } catch {
            return false
        }
    }

    private func handle(_ raw: String) async {
        guard let data = raw.data(using: .utf8),
              let message = try? decoder.decode(ServerMessage.self, from: data) else {
            return // ignore malformed/unknown frames
        }
        if let frameRef = message.terminalRef, frameRef != terminalRef { return }
        if let revision = message.revision {
            guard revision >= lastRevisionValue else { return }
            lastRevisionValue = revision
        }
        switch message {
        case let .attached(_, _, _, nextSeq):
            isAttached = true
            eventContinuation.yield(.attached(state: "running", fromSeq: nextSeq))
            startHeartbeat()
            // Resize once immediately after attach.
            if let size = pendingSize {
                if let terminalRef { await sendClient(.resize(ref: terminalRef, cols: size.cols, rows: size.rows)) }
            }
            await flushPendingInputs()
        case let .output(_, _, seq, payload):
            lastSeqValue = max(lastSeqValue, seq)
            ring.append(seq: seq, data: payload)
            eventContinuation.yield(.output(seq: seq, data: payload))
        case let .snapshot(_, _, _, seq, ansi, _):
            lastSeqValue = max(lastSeqValue, seq)
            ring.clear()
            ring.append(seq: seq, data: ansi)
            eventContinuation.yield(.output(seq: seq, data: ansi))
        case let .exit(_, _, code):
            eventContinuation.yield(.exit(code: code ?? 0))
        case let .error(_, code, text):
            eventContinuation.yield(.error(code: code, message: text))
        case .pong:
            break
        case .replayStart, .replayEnd, .replayGap, .canonicalSize:
            break
        case .replayEvicted:
            // Unrecoverable gap: clear buffer + seq, re-attach at live tail.
            ring.clear()
            lastSeqValue = 0
            isAttached = false
            eventContinuation.yield(.replayEvicted)
            await transport.close() // drop current connection; run loop re-attaches at live tail
        }
    }

    // MARK: - Sending

    private func flushPendingInputs() async {
        guard !pendingInputs.isEmpty else { return }
        let inputs = pendingInputs
        pendingInputs.removeAll(keepingCapacity: true)
        for input in inputs {
            if let terminalRef { await sendClient(.input(ref: terminalRef, data: input)) }
        }
    }

    private func startHeartbeat() {
        heartbeatLoop?.cancel()
        heartbeatLoop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.clock.sleep(seconds: 30)
                await self.sendHeartbeat()
            }
        }
    }

    private func sendHeartbeat() async {
        guard isAttached, let terminalRef else { return }
        await sendClient(.ping(ref: terminalRef))
    }

    private func sendClient(_ message: ClientMessage) async {
        guard !stopped, let encoded = try? encoder.encode(message),
              let text = String(data: encoded, encoding: .utf8) else { return }
        try? await transport.send(text)
    }

    // MARK: - Request building

    private func makeRequest(fromSeq: Int) async -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        var items = components?.queryItems ?? []
        items.removeAll { $0.name == "fromSeq" || $0.name == "token" }
        items.append(URLQueryItem(name: "fromSeq", value: String(fromSeq)))
        components?.queryItems = items.isEmpty ? nil : items
        let url = components?.url ?? baseURL
        var request = URLRequest(url: url)
        // FR-015a / S1: principal token in the Authorization header, never the query string.
        let token = await tokenProvider()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
}

private extension ServerMessage {
    var terminalRef: TerminalRef? {
        switch self {
        case let .attached(ref, _, _, _),
             let .snapshot(ref, _, _, _, _, _),
             let .output(ref, _, _, _),
             let .exit(ref, _, _),
             let .pong(ref, _),
             let .replayStart(ref, _, _),
             let .replayEvicted(ref, _, _, _),
             let .replayGap(ref, _, _, _),
             let .replayEnd(ref, _, _, _),
             let .canonicalSize(ref, _, _):
            return ref
        case let .error(ref, _, _):
            return ref
        }
    }

    var revision: Int? {
        switch self {
        case let .attached(_, _, revision, _),
             let .snapshot(_, _, revision, _, _, _),
             let .output(_, revision, _, _),
             let .exit(_, revision, _),
             let .pong(_, revision),
             let .replayStart(_, revision, _),
             let .replayEvicted(_, revision, _, _),
             let .replayGap(_, revision, _, _),
             let .replayEnd(_, revision, _, _),
             let .canonicalSize(_, revision, _):
            return revision
        case .error:
            return nil
        }
    }
}
