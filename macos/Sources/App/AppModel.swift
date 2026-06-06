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
#if canImport(AppKit)
import AppKit
#endif

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
    /// A project create/clone request failed.
    case createProjectFailed
    /// A task/card mutation failed.
    case taskMutationFailed
    /// A zellij session create request failed.
    case createSessionFailed

    public var message: String {
        switch self {
        case .noSession: return "This card has no live session to open."
        case .misconfigured: return "No computer is connected. Select a runtime to continue."
        case .unauthorized: return "Your session has expired. Please sign in again."
        case .createProjectFailed: return "Couldn't create that project. Check your connection and try again."
        case .taskMutationFailed: return "Couldn't update the board. Refresh and try again."
        case .createSessionFailed: return "Couldn't start a session. Check your connection and try again."
        }
    }
}

/// Device-authorization sign-in progress (drives the onboarding UI).
public enum SignInState: Equatable, Sendable {
    /// Not signing in.
    case idle
    /// Requesting a device code from the platform.
    case starting
    /// Waiting for the user to approve in the browser. Shows the user code.
    case awaitingApproval(userCode: String, verificationUri: String)
    /// Sign-in failed; generic, user-safe message (no internal leakage).
    case failed(String)
}

/// Top-level workspace sections (left rail). Board = task kanban; Terminals =
/// the live zellij session list opened in a full/side terminal.
public enum AppSection: String, CaseIterable, Sendable {
    case board
    case terminals

    public var title: String {
        switch self {
        case .board: return "Board"
        case .terminals: return "Terminals"
        }
    }

    public var symbol: String {
        switch self {
        case .board: return "rectangle.split.3x1"
        case .terminals: return "terminal"
        }
    }
}

/// A live zellij session entry for the Terminals section.
public struct WorkspaceSession: Identifiable, Equatable, Sendable {
    public let name: String
    public let status: String
    public var id: String { name }
    public var isActive: Bool { status == "active" }
}

/// A project the user can open/clone (project picker + Projects UI).
public struct ProjectSummary: Identifiable, Equatable, Sendable {
    public let slug: String
    public let name: String
    public let remote: String?
    public var id: String { slug }
    public init(slug: String, name: String, remote: String? = nil) {
        self.slug = slug; self.name = name; self.remote = remote
    }
}

@MainActor
public final class AppModel: ObservableObject {
    // MARK: - Published state (SwiftUI binds to these)

    /// The active top-level section (left rail selection).
    @Published public var section: AppSection = .board
    /// Live zellij sessions for the Terminals section.
    @Published public private(set) var sessions: [WorkspaceSession] = []
    /// The user's projects (for the project picker / Projects UI).
    @Published public private(set) var projects: [ProjectSummary] = []
    /// Command palette (⌘K) visibility.
    @Published public var showCommandPalette = false

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
    /// Device-auth sign-in progress (drives the onboarding sign-in UI).
    @Published public private(set) var signIn: SignInState = .idle

    // MARK: - Dependencies

    private let principal: PrincipalProvider
    /// Device-authorization client for in-app sign-in (same flow as the `matrix` CLI).
    private let deviceAuth: any DeviceAuthorizing
    /// Opens an external URL (browser) for device approval. Injected for tests.
    private let openExternalURL: @Sendable (URL) -> Void
    /// Gateway host for the profile created after a successful sign-in.
    private let signInGatewayHost: String
    /// Monotonic token used to ignore stale `openCard` calls that resume after a newer tap.
    private var openCardGeneration = 0
    /// In-flight sign-in task, so a re-tap cancels the previous attempt.
    private var signInTask: Task<Void, Never>?
    /// The project whose tasks the board renders.
    public private(set) var projectSlug: String

    /// Factory for the gateway client given a resolved base URL + token provider.
    /// Injected so tests can stub it without real networking.
    private let makeClient: @Sendable (URL, PrincipalProvider) -> GatewayHTTPClient

    /// Factory for a board loader given a gateway client. Injected for tests.
    private let makeLoader: @Sendable (GatewayHTTPClient) -> any BoardLoading

    /// Factory for a terminal session given a resolved WS URL, principal provider, and session id.
    /// Injected so tests can supply a mock event source instead of a real socket.
    private let makeTerminal: @MainActor (URL, PrincipalProvider, String, String) -> TerminalSession

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
            CompositeBoardLoader(client: client)
        },
        makeTerminal: @escaping @MainActor (URL, PrincipalProvider, String, String) -> TerminalSession = { url, provider, session, name in
            let tokenProvider = provider as any TokenProviding
            let client = ShellWSClient(
                url: url,
                tokenProvider: { await tokenProvider.token() ?? "" },
                session: session,
                transport: URLSessionShellTransport()
            )
            return TerminalSession(displayName: name, client: client)
        },
        deviceAuth: any DeviceAuthorizing = DeviceAuthClient(
            platformURL: URL(string: "https://app.matrix-os.com")!
        ),
        signInGatewayHost: String = "app.matrix-os.com",
        openExternalURL: @escaping @Sendable (URL) -> Void = AppModel.defaultOpenExternalURL
    ) {
        self.principal = principal
        self.projectSlug = projectSlug
        self.profile = profile
        self.makeClient = makeClient
        self.makeLoader = makeLoader
        self.makeTerminal = makeTerminal
        self.deviceAuth = deviceAuth
        self.signInGatewayHost = signInGatewayHost
        self.openExternalURL = openExternalURL
        // If a profile is already known (persisted sign-in), wire the real board
        // loader immediately so the first `refresh()` fetches. Otherwise a
        // placeholder keeps `board` non-nil until `selectProfile`.
        if let profile, let baseURL = try? profile.gatewayBaseURL() {
            self.board = BoardStore(loader: makeLoader(makeClient(baseURL, principal)))
            self.phase = .connecting
        } else {
            self.board = BoardStore(loader: UnconfiguredBoardLoader())
            self.phase = .needsProfile
        }
    }

    /// Convenience production initializer: Keychain principal, default app domain.
    /// Falls back to a persisted profile so a signed-in user stays signed in.
    public static func live(
        projectSlug: String,
        profile: ConnectionProfile? = nil
    ) -> AppModel {
        AppModel(
            principal: PrincipalProvider(store: KeychainStore()),
            projectSlug: projectSlug,
            profile: profile ?? loadPersistedProfile()
        )
    }

    // MARK: - Profile persistence (handle/host/slot only — token stays in Keychain)

    private static let handleKey = "matrix.profile.handle"
    private static let hostKey = "matrix.profile.host"
    private static let slotKey = "matrix.profile.slot"

    /// Loads a previously signed-in profile (non-secret) from UserDefaults.
    public static func loadPersistedProfile() -> ConnectionProfile? {
        let d = UserDefaults.standard
        guard let handle = d.string(forKey: handleKey), !handle.isEmpty else { return nil }
        let host = d.string(forKey: hostKey) ?? "app.matrix-os.com"
        let slot = d.string(forKey: slotKey)
        return ConnectionProfile(handle: handle, gatewayHost: host, runtimeSlot: slot)
    }

    private func persistProfile(_ profile: ConnectionProfile) {
        let d = UserDefaults.standard
        d.set(profile.handle, forKey: Self.handleKey)
        d.set(profile.gatewayHost, forKey: Self.hostKey)
        d.set(profile.runtimeSlot, forKey: Self.slotKey)
    }

    // MARK: - Sign in (device authorization)

    /// Default browser opener used outside tests.
    public static let defaultOpenExternalURL: @Sendable (URL) -> Void = { url in
        #if canImport(AppKit)
        NSWorkspace.shared.open(url)
        #endif
    }

    /// Starts the device-authorization sign-in: requests a device code, opens the
    /// verification page in the browser, and polls until approved. On success it
    /// stores the principal token, builds a profile, and loads the board.
    public func beginSignIn() {
        signInTask?.cancel()
        signIn = .starting
        signInTask = Task { [weak self] in await self?.runSignIn() }
    }

    /// Cancels an in-flight sign-in and returns to the idle onboarding state.
    public func cancelSignIn() {
        signInTask?.cancel()
        signInTask = nil
        signIn = .idle
    }

    private func runSignIn() async {
        do {
            let start = try await deviceAuth.startDeviceAuth()
            if Task.isCancelled { return }
            signIn = .awaitingApproval(userCode: start.userCode, verificationUri: start.verificationUri)
            if let url = URL(string: start.verificationUri) {
                openExternalURL(url)
            }

            let deadline = Date().addingTimeInterval(TimeInterval(max(1, start.expiresIn)))
            var interval = max(1, start.interval)
            while Date() < deadline {
                try await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000_000)
                if Task.isCancelled { return }
                let result = try await deviceAuth.pollForToken(deviceCode: start.deviceCode)
                switch result {
                case .pending:
                    continue
                case .slowDown:
                    interval += 5
                case .expired:
                    signIn = .failed("Sign-in expired. Try again.")
                    return
                case let .approved(token):
                    try await principal.setToken(token.accessToken)
                    signIn = .idle
                    let handle = (token.handle?.isEmpty == false ? token.handle : nil) ?? "me"
                    let newProfile = ConnectionProfile(handle: handle, gatewayHost: signInGatewayHost, runtimeSlot: nil)
                    persistProfile(newProfile)
                    selectProfile(newProfile)
                    await refresh()
                    return
                }
            }
            signIn = .failed("Sign-in timed out. Try again.")
        } catch is CancellationError {
            // Cancelled by a re-tap or sign-out; leave state as set by the canceller.
        } catch {
            // Generic, user-safe — never surface raw gateway/provider text.
            signIn = .failed("Sign-in failed. Check your connection and try again.")
        }
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
        await loadProjects()
        guard await resolveProjectIfNeeded() else { return }
        await loadSessions()
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

    // MARK: - Project + sessions

    private func gatewayClient() -> GatewayHTTPClient? {
        guard let profile, let baseURL = try? profile.gatewayBaseURL() else { return nil }
        return makeClient(baseURL, principal)
    }

    /// Resolves the active project slug from the user's projects when unset, so the
    /// board targets a real project instead of a hardcoded "default" (which 404s).
    private func resolveProjectIfNeeded() async -> Bool {
        guard projectSlug == "default" || projectSlug.isEmpty else { return true }
        guard let client = gatewayClient() else {
            phase = .needsProfile
            return false
        }
        struct ProjectsResponse: Decodable { struct Project: Decodable { let slug: String }; let projects: [Project] }
        if let first = projects.first {
            projectSlug = first.slug
            self.board = BoardStore(loader: makeLoader(client))
            return true
        }
        do {
            let response: ProjectsResponse = try await client.get("/api/workspace/projects")
            guard let first = response.projects.first else { return true }
            projectSlug = first.slug
            // Rebuild the board store against the resolved project.
            self.board = BoardStore(loader: makeLoader(client))
            return true
        } catch {
            phase = .disconnected
            return false
        }
    }

    /// Loads the live zellij session list for the Terminals section.
    public func loadSessions() async {
        guard let client = gatewayClient() else { return }
        struct SessionsResponse: Decodable {
            struct Session: Decodable { let name: String; let status: String }
            let sessions: [Session]
        }
        if let response: SessionsResponse = try? await client.get("/api/sessions") {
            sessions = response.sessions.map { WorkspaceSession(name: $0.name, status: $0.status) }
        }
    }

    /// Loads the user's projects (project picker / Projects UI).
    public func loadProjects() async {
        guard let client = gatewayClient() else { return }
        struct ProjectsResponse: Decodable {
            struct Project: Decodable { let slug: String; let name: String?; let remote: String? }
            let projects: [Project]
        }
        if let response: ProjectsResponse = try? await client.get("/api/workspace/projects") {
            projects = response.projects.map { ProjectSummary(slug: $0.slug, name: $0.name ?? $0.slug, remote: $0.remote) }
        }
    }

    /// Switches the active project and reloads its board.
    public func openProject(slug: String) {
        guard slug != projectSlug, let client = gatewayClient() else { return }
        projectSlug = slug
        board = BoardStore(loader: makeLoader(client))
        section = .board
        Task { await refresh() }
    }

    /// Creates a project (optionally from a git remote) and opens it.
    public func createProject(name: String, remote: String?) {
        guard let client = gatewayClient() else { return }
        openError = nil
        Task { [weak self] in
            struct CreateProjectRequest: Encodable { let name: String; let remote: String? }
            struct CreateProjectResponse: Decodable { let project: Project?; struct Project: Decodable { let slug: String } }
            do {
                let response: CreateProjectResponse = try await client.post(
                    "/api/projects", body: CreateProjectRequest(name: name, remote: remote)
                )
                await self?.loadProjects()
                if let slug = response.project?.slug { self?.openProject(slug: slug) }
            } catch {
                await MainActor.run { self?.openError = .createProjectFailed }
            }
        }
    }

    /// Moves a card to a new column/order (drag-to-move). Optimistic + persisted
    /// via PATCH; refreshes on completion to reconcile.
    public func updateTaskStatus(cardId: String, to status: TaskStatus, order: Double?) {
        guard let client = gatewayClient() else { return }
        openError = nil
        let slug = projectSlug
        Task { [weak self] in
            struct UpdateTaskRequest: Encodable { let status: String; let order: Double? }
            struct UpdateTaskResponse: Decodable {}
            do {
                let _: UpdateTaskResponse = try await client.patch(
                    "/api/projects/\(slug)/tasks/\(cardId)",
                    body: UpdateTaskRequest(status: status.rawValue, order: order)
                )
                await self?.refresh()
            } catch {
                await MainActor.run { self?.openError = .taskMutationFailed }
                await self?.refresh() // reconcile on failure too
            }
        }
    }

    /// Opens a raw zellij session (Terminals section) in the side terminal view.
    public func openSession(named name: String) {
        let card = Card(
            id: name, projectSlug: projectSlug, title: name,
            status: .running, priority: .normal, order: 0,
            linkedSessionId: name, updatedAt: ""
        )
        Task {
            do {
                try await openCard(card)
            } catch let error as OpenCardError {
                await MainActor.run { self.openError = error }
            } catch {
                await MainActor.run { self.openError = .misconfigured }
            }
        }
    }

    /// Creates a new task in the given column and refreshes the board (TE01/US7).
    public func createTask(status: TaskStatus = .todo) {
        guard !isCreatingWorkItem else { return }
        openError = nil
        isCreatingWorkItem = true
        Task { [weak self] in
            defer { Task { @MainActor in self?.isCreatingWorkItem = false } }
            guard let self, let client = self.gatewayClient() else { return }
            guard await self.resolveProjectIfNeeded() else { return }
            let slug = self.projectSlug
            struct CreateTaskRequest: Encodable { let title: String; let status: String }
            struct CreateTaskResponse: Decodable {}
            do {
                let _: CreateTaskResponse = try await client.post(
                    "/api/projects/\(slug)/tasks",
                    body: CreateTaskRequest(title: "New task", status: status.rawValue)
                )
                await self.refresh()
            } catch {
                await MainActor.run { self.openError = .taskMutationFailed }
            }
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
        openCardGeneration += 1
        let generation = openCardGeneration

        guard let profile else {
            let err = OpenCardError.misconfigured
            openError = err
            throw err
        }
        guard await principal.token() != nil else {
            let err = OpenCardError.unauthorized
            openError = err
            throw err
        }
        guard generation == openCardGeneration, selectedCard?.id == card.id else {
            throw OpenCardError.noSession
        }

        // Existing session → attach by name. No session yet → connect to
        // `/ws/terminal?cwd=` which auto-creates one (matrix shell connect -c).
        let hasSession = !(card.linkedSessionId ?? "").isEmpty
        let wsURL: URL
        do {
            if hasSession {
                wsURL = try profile.webSocketURL(
                    path: "/ws/terminal/session",
                    session: card.linkedSessionId!,
                    fromSeq: Int?.none
                )
            } else {
                wsURL = try profile.autoCreateTerminalURL(cwd: nil)
            }
        } catch {
            let err = OpenCardError.misconfigured
            openError = err
            throw err
        }

        // Tear down any previously open session before swapping in the new one.
        terminal?.shutdown()
        let label = hasSession ? card.linkedSessionId! : card.title
        let session = makeTerminal(wsURL, principal, card.linkedSessionId ?? "", label)
        terminal = session
<<<<<<< HEAD
        // After it opens, refresh the session list so the new session is tracked.
=======
>>>>>>> 6d9343d5 (feat(086): project service layer + app icon)
        if !hasSession {
            session.onNextAttach { [weak self] in
                Task { await self?.loadSessions() }
            }
        }
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

    /// ⌘N / column "+": create a new task card on the board.
    public func newCardPlaceholder() { createTask(status: .todo) }

    /// Whether a task or terminal-session create request is in flight.
    @Published public private(set) var isCreatingWorkItem = false

    /// Creates a new zellij session (Terminals section "+") and reloads the list.
    public func createSession() {
        guard !isCreatingWorkItem, let client = gatewayClient() else { return }
        openError = nil
        isCreatingWorkItem = true
        Task { [weak self] in
            defer { Task { @MainActor in self?.isCreatingWorkItem = false } }
            struct CreateSessionRequest: Encodable {
                let kind = "shell"
                let runtimePreference = "zellij"
            }
            struct CreateSessionResponse: Decodable {}
            do {
                let _: CreateSessionResponse = try await client.post(
                    "/api/sessions",
                    body: CreateSessionRequest()
                )
                await self?.loadSessions()
            } catch {
                await MainActor.run { self?.openError = .createSessionFailed }
            }
        }
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
