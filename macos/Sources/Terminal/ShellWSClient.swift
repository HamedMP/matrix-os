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
    private let session: String
    private let transport: ShellTransport
    private let backoff: BackoffPolicy
    private let clock: ShellClock
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var ring: ScrollbackRing
    private var lastSeqValue: Int = 0
    private var pendingSize: (cols: Int, rows: Int)?
    private var pendingInputs: [String] = []
    private var isAttached = false
    private var runLoop: Task<Void, Never>?
    private var stopped = false

    private let eventStream: AsyncStream<ServerEvent>
    private let eventContinuation: AsyncStream<ServerEvent>.Continuation

    public init(
        url: URL,
        token: String,
        session: String,
        transport: ShellTransport,
        backoff: BackoffPolicy = .default,
        clock: ShellClock = SystemClock(),
        scrollbackCapacity: Int = 5_000
    ) {
        self.init(
            url: url,
            tokenProvider: { token },
            session: session,
            transport: transport,
            backoff: backoff,
            clock: clock,
            scrollbackCapacity: scrollbackCapacity
        )
    }

    public init(
        url: URL,
        tokenProvider: @escaping @Sendable () async -> String,
        session: String,
        transport: ShellTransport,
        backoff: BackoffPolicy = .default,
        clock: ShellClock = SystemClock(),
        scrollbackCapacity: Int = 5_000
    ) {
        self.baseURL = url
        self.tokenProvider = tokenProvider
        self.session = session
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
        await sendClient(.input(data: data))
    }

    /// Records a resize; sent immediately if connected and once after each attach.
    public func resize(cols: Int, rows: Int) async {
        pendingSize = (cols, rows)
        await sendClient(.resize(cols: cols, rows: rows))
    }

    /// Detaches (leave session running) and stops reconnecting.
    public func detach() async {
        await sendClient(.detach)
        await shutdown()
    }

    /// Stops the run loop and tears down the connection.
    public func shutdown() async {
        stopped = true
        runLoop?.cancel()
        runLoop = nil
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
            attempt = cleanly ? 0 : attempt + 1
            if !cleanly && attempt >= 2 {
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
        switch message {
        case let .attached(_, state, fromSeq):
            isAttached = true
            eventContinuation.yield(.attached(state: state, fromSeq: fromSeq))
            // Resize once immediately after attach.
            if let size = pendingSize {
                await sendClient(.resize(cols: size.cols, rows: size.rows))
            }
            await flushPendingInputs()
        case let .output(seq, payload):
            lastSeqValue = max(lastSeqValue, seq)
            ring.append(seq: seq, data: payload)
            eventContinuation.yield(.output(seq: seq, data: payload))
        case let .exit(code):
            eventContinuation.yield(.exit(code: code))
        case let .error(code, text):
            eventContinuation.yield(.error(code: code, message: text))
        case .pong:
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
            await sendClient(.input(data: input))
        }
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
        items.removeAll { $0.name == "session" || $0.name == "fromSeq" || $0.name == "token" }
        // Empty session = auto-create path (/ws/terminal?cwd=...): do not add a
        // blank session param. Named attach keeps session + fromSeq.
        if !session.isEmpty {
            items.append(URLQueryItem(name: "session", value: session))
            items.append(URLQueryItem(name: "fromSeq", value: String(fromSeq)))
        }
        components?.queryItems = items.isEmpty ? nil : items
        let url = components?.url ?? baseURL
        var request = URLRequest(url: url)
        // FR-015a / S1: principal token in the Authorization header, never the query string.
        let token = await tokenProvider()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
}
