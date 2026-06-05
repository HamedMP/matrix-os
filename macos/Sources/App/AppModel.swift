// Matrix OS — top-level app coordinator (US1 / T033 + T035 + T037).
//
// `AppModel` is the @MainActor ObservableObject the SwiftUI scene binds to. It owns:
//   * the selected `ConnectionProfile` (MatrixNet — carries gateway/WS URL resolution),
//   * a `PrincipalProvider` (Keychain-backed bearer token, async),
//   * a `GatewayHTTPClient` built from the resolved gateway base URL,
//   * a `BoardStore` (read-only board snapshot for US1),
//   * the active `projectSlug` and currently selected `Card`,
//   * a top-level `AppPhase` driving which root view renders.
//
// Phase logic is kept free of SwiftUI so it stays unit-testable. Opening a card
// builds a `ShellWSClient` for the card's `linkedSessionId` (header-auth bearer
// token, never a query token) and wraps it in a `TerminalSession`. All surfaced
// errors are GENERIC — raw gateway/provider/path text never reaches the UI (FR-023).
import Foundation
import MatrixBoard
import MatrixModel
import MatrixNet
import MatrixTerminal

/// Within the App module, `ConnectionProfile` means the MatrixNet one (carries
/// gateway/WS URL resolution). MatrixModel also defines a Keychain-ref profile;
/// this alias resolves the ambiguity at every call site.
public typealias ConnectionProfile = MatrixNet.ConnectionProfile

/// Top-level lifecycle of the app's root view. Drives onboarding vs board vs
/// disconnected chrome (design.md §6.6). Pure value type — no SwiftUI dependency.
public enum AppPhase: Equatable, Sendable {
    /// No VPS/runtime selected yet → onboarding empty state ("No Matrix computer yet").
    case needsProfile
    /// A profile is selected and the first board load is in flight.
    case connecting
    /// Board loaded; the operator is working.
    case ready
    /// Lost the live connection; board goes read-only with a reconnecting bar.
    case disconnected
}

/// Generic, user-safe reason a card couldn't be opened. No raw text (FR-023).
public enum OpenCardError: Error, Equatable, Sendable {
    /// The card has no linked session to attach to.
    case noSession
    /// The profile/runtime is missing or its URL could not be resolved.
    case misconfigured
    /// No principal token — the user must sign in again.
    case unauthorized

    public var message: String {
        switch self {
        case .noSession: return "This card has no live session to open."
        case .misconfigured: return "No computer is connected. Select a runtime to continue."
        case .unauthorized: return "Your session has expired. Please sign in again."
        }
    }
}

@MainActor
public final class AppModel: ObservableObject {
    // MARK: - Published state (SwiftUI binds to these)

    /// The currently selected connection profile (nil → onboarding).
    @Published public private(set) var profile: ConnectionProfile?
    /// Top-level phase driving the root view.
    @Published public private(set) var phase: AppPhase = .needsProfile
    /// The board the operator is working in (read-only in US1).
    @Published public private(set) var board: BoardStore
    /// The currently selected/open card (detail pane + terminal).
    @Published public private(set) var selectedCard: Card?
    /// The live terminal session for the open card, if one is attached.
    @Published public private(set) var terminal: TerminalSession?
    /// Which pane the detail view is showing (US1 ships Terminal only).
    @Published public var activePanel: Panel = .terminal
    /// A generic, user-safe error to surface in chrome (nil when clear).
    @Published public private(set) var openError: OpenCardError?

    // MARK: - Dependencies

    private let principal: PrincipalProvider
    /// The project whose tasks the board renders.
    public private(set) var projectSlug: String

    /// Factory for the gateway client given a resolved base URL + token provider.
    /// Injected so tests can stub it without real networking.
    private let makeClient: @Sendable (URL, PrincipalProvider) -> GatewayHTTPClient

    /// Factory for a board loader given a gateway client. Injected for tests.
    private let makeLoader: @Sendable (GatewayHTTPClient) -> any BoardLoading

    /// Factory for a terminal session given a resolved WS URL, token, and session id.
    /// Injected so tests can supply a mock event source instead of a real socket.
    private let makeTerminal: @MainActor (URL, String, String, String) -> TerminalSession

    // MARK: - Init

    /// Designated initializer. All collaborators are injectable for testability;
    /// the production app calls `AppModel()` which supplies real factories.
    public init(
        principal: PrincipalProvider,
        projectSlug: String,
        profile: ConnectionProfile? = nil,
        makeClient: @escaping @Sendable (URL, PrincipalProvider) -> GatewayHTTPClient = { url, provider in
            GatewayHTTPClient(baseURL: url, tokenProvider: provider)
        },
        makeLoader: @escaping @Sendable (GatewayHTTPClient) -> any BoardLoading = { client in
            GatewayBoardLoader(client: client)
        },
        makeTerminal: @escaping @MainActor (URL, String, String, String) -> TerminalSession = { url, token, session, name in
            let client = ShellWSClient(
                url: url,
                token: token,
                session: session,
                transport: URLSessionShellTransport()
            )
            return TerminalSession(displayName: name, client: client)
        }
    ) {
        self.principal = principal
        self.projectSlug = projectSlug
        self.profile = profile
        self.makeClient = makeClient
        self.makeLoader = makeLoader
        self.makeTerminal = makeTerminal
        // A placeholder loader so `board` is non-nil before a profile is selected.
        // Replaced on `selectProfile`. The placeholder never fetches (no profile).
        self.board = BoardStore(loader: UnconfiguredBoardLoader())
        self.phase = profile == nil ? .needsProfile : .connecting
    }

    /// Convenience production initializer: Keychain principal, default app domain.
    public static func live(
        projectSlug: String,
        profile: ConnectionProfile? = nil
    ) -> AppModel {
        AppModel(
            principal: PrincipalProvider(store: KeychainStore()),
            projectSlug: projectSlug,
            profile: profile
        )
    }

    // MARK: - Profile selection

    /// Selects a connection profile, rebuilds the gateway client + board store,
    /// and transitions to `.connecting`. The next `refresh()` loads the board.
    public func selectProfile(_ profile: ConnectionProfile) {
        self.profile = profile
        self.phase = .connecting
        self.openError = nil
        do {
            let baseURL = try profile.gatewayBaseURL()
            let client = makeClient(baseURL, principal)
            self.board = BoardStore(loader: makeLoader(client))
        } catch {
            // URL resolution failed → treat as misconfiguration, not "no data".
            self.board = BoardStore(loader: UnconfiguredBoardLoader())
            self.phase = .needsProfile
        }
    }

    // MARK: - Board lifecycle

    /// Loads the read-only board snapshot and reconciles the top-level phase.
    /// `.connecting → .ready` on success; `.disconnected` on a transient/offline
    /// failure (board stays read-only with last-known cards). Auth/config failures
    /// route back to onboarding.
    public func refresh() async {
        guard profile != nil else {
            phase = .needsProfile
            return
        }
        if phase == .ready {
            // Keep showing the board while refreshing; only drop to disconnected on failure.
        } else {
            phase = .connecting
        }
        await board.load(projectSlug: projectSlug)
        switch board.state {
        case .loaded:
            phase = .ready
        case let .failed(error):
            phase = reconcilePhase(for: error)
        case .idle, .loading:
            phase = .connecting
        }
    }

    /// Maps a board error to the appropriate top-level phase. Transient/offline
    /// errors keep the read-only board (`.disconnected`); auth/config send the
    /// user back to onboarding so they can reconnect.
    private func reconcilePhase(for error: BoardError) -> AppPhase {
        switch error {
        case .offline, .timeout, .generic:
            return .disconnected
        case .unauthorized, .misconfigured:
            return .needsProfile
        }
    }

    /// Marks the live connection as dropped: board goes read-only (design.md §6.6).
    /// Driven by an observed socket drop on the open terminal.
    public func markReconnecting() {
        if phase == .ready {
            phase = .disconnected
        }
        terminal?.markReconnecting()
    }

    // MARK: - Card → terminal wiring (T035)

    /// Opens a card: selects it and, if it has a linked session, builds a
    /// `ShellWSClient` for that session over the profile's WS URL (header bearer
    /// token) and wraps it in a `TerminalSession`. Returns the session, or throws
    /// a GENERIC `OpenCardError` (no raw text).
    @discardableResult
    public func openCard(_ card: Card) async throws -> TerminalSession {
        openError = nil
        selectedCard = card
        activePanel = .terminal

        guard let profile else {
            let err = OpenCardError.misconfigured
            openError = err
            throw err
        }
        guard let sessionId = card.linkedSessionId, !sessionId.isEmpty else {
            let err = OpenCardError.noSession
            openError = err
            throw err
        }
        guard let token = await principal.token() else {
            let err = OpenCardError.unauthorized
            openError = err
            throw err
        }

        let wsURL: URL
        do {
            wsURL = try profile.webSocketURL(
                path: "/shell",
                session: sessionId,
                fromSeq: Int?.none
            )
        } catch {
            let err = OpenCardError.misconfigured
            openError = err
            throw err
        }

        // Tear down any previously open session before swapping in the new one.
        terminal?.shutdown()
        let session = makeTerminal(wsURL, token, sessionId, displayName(for: card))
        terminal = session
        session.start()
        return session
    }

    /// Closes the open card's terminal and detail pane (Esc / light-dismiss).
    public func closeCard() {
        terminal?.shutdown()
        terminal = nil
        selectedCard = nil
        openError = nil
    }

    /// Switches the active detail panel (⌘1/2/3). US1 only renders Terminal.
    public func switchPanel(_ panel: Panel) {
        activePanel = panel
    }

    /// Placeholder ⌘N action — card creation lands in US2 (mutations).
    public func newCardPlaceholder() {
        // Intentionally a no-op in US1; wired in US2.
    }

    private func displayName(for card: Card) -> String {
        if let session = card.linkedSessionId, !session.isEmpty {
            return session
        }
        return card.title
    }
}

/// A `BoardLoading` that never fetches — used before a profile is selected or when
/// URL resolution fails. Always reports a generic misconfiguration so the UI shows
/// "no computer connected" rather than implying the board is simply empty.
private struct UnconfiguredBoardLoader: BoardLoading {
    func fetchTasks(projectSlug: String) async throws -> [Card] {
        throw GatewayError.misconfigured
    }
}
