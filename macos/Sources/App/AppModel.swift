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
import OSLog
#if canImport(AppKit)
import AppKit
#endif
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif

private let appModelLogger = Logger(subsystem: "com.matrixos.native-shell", category: "AppModel")

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

/// Generic, user-safe operation errors shown in the board chrome. No raw text (FR-023).
public enum OperatorError: Error, Equatable, Sendable {
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

/// Which Clerk screen the device approval page should mount first.
public enum SignInMode: String, Sendable {
    case signIn = "sign-in"
    case signUp = "sign-up"
}

/// Top-level workspace sections (left rail). Home is the web shell package;
/// Terminal is the live zellij session list opened in a full terminal surface.
public enum AppSection: String, CaseIterable, Sendable {
    case home
    case board
    case terminal
    case settings
    case resources
    case browser

    public var title: String {
        switch self {
        case .home: return "Home"
        case .board: return "Board"
        case .terminal: return "Terminal"
        case .settings: return "Settings"
        case .resources: return "Resources"
        case .browser: return "Browser"
        }
    }

    public var symbol: String {
        switch self {
        case .home: return "house"
        case .board: return "rectangle.split.3x1"
        case .terminal: return "terminal"
        case .settings: return "gearshape"
        case .resources: return "gauge.with.dots.needle.67percent"
        case .browser: return "globe"
        }
    }
}

public enum NativeSettingsSection: String, CaseIterable, Identifiable, Sendable {
    case account
    case runtime
    case editor
    case workspace

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .account: return "Account"
        case .runtime: return "Runtime"
        case .editor: return "Editor"
        case .workspace: return "Workspace"
        }
    }

    public var symbol: String {
        switch self {
        case .account: return "person.crop.circle"
        case .runtime: return "desktopcomputer"
        case .editor: return "chevron.left.forwardslash.chevron.right"
        case .workspace: return "folder.badge.gearshape"
        }
    }
}

/// A live zellij session entry for the Terminals section.
public struct WorkspaceSession: Identifiable, Equatable, Sendable {
    public let name: String
    public let attachName: String
    public let status: String
    public var id: String { name }
    public var isActive: Bool {
        ["active", "running", "attached", "ready"].contains(status.lowercased())
    }

    public init(name: String, attachName: String? = nil, status: String) {
        self.name = name
        self.attachName = attachName ?? name
        self.status = status
    }
}

/// Open workspace tab for a task card or raw zellij session. The tab is the
/// stable unit of work shown in the native chrome.
public struct WorkspaceTab: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case home
        case board
        case task
        case session
        case settings
        case resources
        case app
    }

    public let id: String
    public let title: String
    public let projectSlug: String
    public let projectName: String
    public let kind: Kind
    public let card: Card?
    public var panel: Panel

    public init(
        id: String? = nil,
        title: String,
        projectSlug: String,
        projectName: String,
        kind: Kind,
        card: Card? = nil,
        panel: Panel
    ) {
        self.id = id ?? "\(kind.rawValue):\(projectSlug):\(card?.id ?? title)"
        self.title = title
        self.projectSlug = projectSlug
        self.projectName = projectName
        self.kind = kind
        self.card = card
        self.panel = panel
    }
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

public enum ProjectStartMode: String, CaseIterable, Sendable {
    case scratch
    case github
    case linear
}

public struct WorkspaceFileEntry: Identifiable, Equatable, Sendable {
    public let name: String
    public let type: String
    public let size: Int?
    public let gitStatus: String?
    public let changedCount: Int?
    public var id: String { "\(type):\(name)" }
}

public struct WorkspaceFileTreeNode: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let type: String
    public let path: String
    public let size: Int?
    public let gitStatus: String?
    public let changedCount: Int?
    public var children: [WorkspaceFileTreeNode]?
    public var expanded: Bool

    public var isDirectory: Bool { type == "directory" }
}

public struct GitBranchSummary: Identifiable, Equatable, Sendable {
    public let name: String
    public var id: String { name }
}

public struct GitPullRequestSummary: Identifiable, Equatable, Sendable {
    public let number: Int
    public let title: String
    public let headRefName: String?
    public let baseRefName: String?
    public var id: Int { number }
}

public struct GitWorktreeSummary: Identifiable, Equatable, Sendable {
    public let id: String
    public let path: String
    public let currentBranch: String
    public let dirtyState: String
    public let dirtyCount: Int?
}

public struct PreviewSummary: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let url: String
    public let lastStatus: String
}

public struct SystemResourceRow: Identifiable, Equatable, Sendable {
    public let label: String
    public let value: String
    public let detail: String
    public let symbol: String
    public var id: String { label }
}

public struct NativeSystemInfoSummary: Decodable, Equatable, Sendable {
    public struct Runtime: Decodable, Equatable, Sendable {
        public let handle: String?
        public let machineId: String?
        public let runtimeSlot: String
    }

    public struct Build: Decodable, Equatable, Sendable {
        public let sha: String
        public let ref: String
        public let date: String
    }

    public struct Resources: Decodable, Equatable, Sendable {
        public let cpuCount: Int
        public let loadAverage: [Double]
        public let memoryTotalBytes: Int64
        public let memoryFreeBytes: Int64
        public let diskTotalBytes: Int64?
        public let diskFreeBytes: Int64?
        public let homeDiskTotalBytes: Int64?
        public let homeDiskFreeBytes: Int64?
    }

    public struct Release: Decodable, Equatable, Sendable {
        public let version: String?
        public let channel: String?
    }

    public let version: String
    public let uptime: Int
    public let runtime: Runtime
    public let build: Build
    public let resources: Resources
    public let release: Release?

    public var displayRuntimeName: String {
        guard let handle = runtime.handle?.trimmingCharacters(in: .whitespacesAndNewlines), !handle.isEmpty else {
            return "Matrix computer"
        }
        return handle.prefix(1).uppercased() + handle.dropFirst()
    }

    public var summaryText: String {
        let installed = release?.version ?? version
        let channel = release?.channel.map { " on \($0)" } ?? ""
        return "\(displayRuntimeName) running \(installed)\(channel)"
    }

    public var uptimeText: String {
        Self.formatUptime(seconds: uptime)
    }

    private static func formatUptime(seconds rawSeconds: Int) -> String {
        let seconds = max(0, rawSeconds)
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        let minutes = (seconds % 3_600) / 60
        let remainingSeconds = seconds % 60

        if days > 0 {
            return "\(days)d \(hours)h \(minutes)m"
        }
        if hours > 0 {
            return "\(hours)h \(minutes)m \(remainingSeconds)s"
        }
        if minutes > 0 {
            return "\(minutes)m \(remainingSeconds)s"
        }
        return "\(remainingSeconds)s"
    }

    public var resourceRows: [SystemResourceRow] {
        let load1 = resources.loadAverage.first ?? 0
        let memoryUsed = max(0, resources.memoryTotalBytes - resources.memoryFreeBytes)
        let diskUsage = Self.diskUsage(from: resources)
        return [
            SystemResourceRow(
                label: "CPU",
                value: "\(resources.cpuCount) cores",
                detail: "Load \(String(format: "%.2f", load1))",
                symbol: "cpu"
            ),
            SystemResourceRow(
                label: "Memory",
                value: Self.formatBytes(memoryUsed),
                detail: "\(Self.formatBytes(resources.memoryFreeBytes)) available",
                symbol: "memorychip"
            ),
            SystemResourceRow(
                label: "Disk",
                value: diskUsage.map { Self.formatBytes(max(0, $0.total - $0.free)) } ?? "Unknown",
                detail: diskUsage.map { "\(Self.formatBytes($0.free)) available" } ?? "Storage unavailable",
                symbol: "internaldrive"
            ),
        ]
    }

    private static func diskUsage(from resources: Resources) -> (total: Int64, free: Int64)? {
        if let homeTotal = resources.homeDiskTotalBytes,
           let homeFree = resources.homeDiskFreeBytes {
            return (homeTotal, homeFree)
        }
        if let rootTotal = resources.diskTotalBytes,
           let rootFree = resources.diskFreeBytes {
            return (rootTotal, rootFree)
        }
        return nil
    }

    private static func formatBytes(_ bytes: Int64) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = Double(bytes)
        var index = 0
        while value >= 1024, index < units.count - 1 {
            value /= 1024
            index += 1
        }
        if index == 0 { return "\(Int(value)) \(units[index])" }
        return "\(String(format: "%.1f", value)) \(units[index])"
    }
}

@MainActor
public final class AppModel: ObservableObject {
    // MARK: - Published state (SwiftUI binds to these)

    /// The active top-level section (left rail selection).
    @Published public var section: AppSection = .board
    /// Live zellij sessions for the Terminals section.
    @Published public private(set) var sessions: [WorkspaceSession] = []
    /// Open task/session tabs in the workspace. Tabs are project-marked so work
    /// from multiple Matrix projects stays legible.
    @Published public private(set) var openTabs: [WorkspaceTab] = []
    /// The currently active workspace tab, if any.
    @Published public private(set) var activeTabID: String?
    /// Terminal sessions are retained per terminal tab so tab switching does not
    /// tear down sockets or drop zellij output.
    @Published public private(set) var terminalSessions: [String: TerminalSession] = [:]
    /// The user's projects (for the project picker / Projects UI).
    @Published public private(set) var projects: [ProjectSummary] = []
    /// Files for the active project/editor panel.
    @Published public private(set) var fileEntries: [WorkspaceFileEntry] = []
    /// Expandable file tree for the active project/editor panel.
    @Published public private(set) var fileTree: [WorkspaceFileTreeNode] = []
    /// Current directory path shown by the native editor panel.
    @Published public private(set) var filePanelPath: String = ""
    /// Selected file path and contents for lightweight native editing.
    @Published public private(set) var selectedFilePath: String?
    @Published public private(set) var selectedFileData: Data?
    @Published public var selectedFileContent: String = ""
    @Published public private(set) var fileSaveState: String?
    @Published public private(set) var isLoadingSelectedFile = false
    /// Git branches for the active project.
    @Published public private(set) var gitBranches: [GitBranchSummary] = []
    /// Pull requests for the active project, when GitHub is linked.
    @Published public private(set) var gitPullRequests: [GitPullRequestSummary] = []
    /// Managed worktrees for the active project.
    @Published public private(set) var gitWorktrees: [GitWorktreeSummary] = []
    /// Preview/artifact records for the active project/task/session.
    @Published public private(set) var previews: [PreviewSummary] = []
    /// Current runtime/resource summary from `/api/system/info`.
    @Published public private(set) var systemInfo: NativeSystemInfoSummary?
    /// Shared loading flag for secondary panels.
    @Published public private(set) var isLoadingPanelData = false
    /// Command palette (⌘K) visibility.
    @Published public var showCommandPalette = false
    /// Search/filter text shared by native tabs and the project task board.
    @Published public var workspaceSearchQuery = ""
    /// Selected section inside the native Settings surface.
    @Published public private(set) var nativeSettingsSection: NativeSettingsSection = .account

    /// The currently selected connection profile (nil → onboarding).
    @Published public private(set) var profile: ConnectionProfile?
    /// Top-level phase driving the root view.
    @Published public private(set) var phase: AppPhase = .needsProfile
    /// Whether the user has explicitly opened a project in this session. Until
    /// then the ready state shows the Matrix home/onboarding surface instead of
    /// auto-opening a kanban board.
    @Published public private(set) var hasSelectedProject: Bool
    /// The board the operator is working in (read-only in US1).
    @Published public private(set) var board: BoardStore
    /// The currently selected/open card (detail pane + terminal).
    @Published public private(set) var selectedCard: Card?
    /// The live terminal session for the open card, if one is attached.
    @Published public private(set) var terminal: TerminalSession?
    /// Which pane the detail view is showing. The agent terminal is always the
    /// left split; the right pane defaults to the editor.
    @Published public var activePanel: Panel = .app(slug: "editor")
    /// Task panes currently available in the detail surface. Keyboard commands
    /// and fallback logic use this list when restoring an active panel.
    @Published public private(set) var enabledPanels: [Panel] = [.terminal, .app(slug: "editor")]
    /// Native editor appearance and text-system preferences.
    @Published public private(set) var editorTheme: CodeEditorTheme
    @Published public private(set) var editorPreferences: CodeEditorPreferences
    /// A generic, user-safe error to surface in chrome (nil when clear).
    @Published public private(set) var openError: OperatorError?
    /// Device-auth sign-in progress (drives the onboarding sign-in UI).
    @Published public private(set) var signIn: SignInState = .idle
    /// Monotonic marker for completed sign-ins. Cancellation returns `signIn` to
    /// idle too, so hosted-shell recovery listens to this instead of idle alone.
    @Published public private(set) var signInCompletionID = 0

    // MARK: - Dependencies

    private let principal: PrincipalProvider
    /// Device-authorization client for in-app sign-in (same flow as the `matrix` CLI).
    private let deviceAuth: any DeviceAuthorizing
    /// Opens an external URL (browser) for device approval. Injected for tests.
    private let openExternalURL: @Sendable (URL) -> Void
    /// Cancels a native approval browser session if one is currently presented.
    private let cancelExternalAuth: @MainActor @Sendable () -> Void
    /// Gateway host for the profile created after a successful sign-in.
    private let signInGatewayHost: String
    /// Monotonic token used to ignore stale `openCard` calls that resume after a newer tap.
    private var openCardGeneration = 0
    /// In-flight sign-in task, so a re-tap cancels the previous attempt.
    private var signInTask: Task<Void, Never>?
    /// Prevents Settings/Resources tab changes from issuing duplicate runtime summary requests.
    private var isLoadingSystemInfo = false
    /// The project whose tasks the board renders.
    public private(set) var projectSlug: String
    /// Maps workspace session ids / terminal ids to the zellij shell session name
    /// required by `/ws/terminal/session`.
    private var sessionAttachNames: [String: String] = [:]
    private let maxCachedTerminalSessions = 8
    private var terminalSessionAccessOrder: [String] = []

    /// Factory for the gateway client given a resolved base URL + token provider.
    /// Injected so tests can stub it without real networking.
    private let makeClient: @Sendable (URL, PrincipalProvider) -> GatewayHTTPClient

    /// Factory for a board loader given a gateway client. Injected for tests.
    private let makeLoader: @Sendable (GatewayHTTPClient) -> any BoardLoading

    /// Factory for a terminal session given a resolved WS URL, principal provider, and session id.
    /// Injected so tests can supply a mock event source instead of a real socket.
    private let makeTerminal: @MainActor (URL, PrincipalProvider, String, String) -> TerminalSession
    private var signInMode: SignInMode = .signUp

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
            // Project boards are task-first. Generic shells live in the Terminal
            // section, not inside project kanban.
            GatewayBoardLoader(client: client)
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
        openExternalURL: @escaping @Sendable (URL) -> Void = AppModel.defaultOpenExternalURL,
        cancelExternalAuth: @escaping @MainActor @Sendable () -> Void = AppModel.defaultCancelExternalAuth
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
        self.cancelExternalAuth = cancelExternalAuth
        self.hasSelectedProject = false
        self.editorTheme = Self.loadPersistedEditorTheme()
        self.editorPreferences = Self.loadPersistedEditorPreferences()
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
    private static let editorThemeKey = "matrix.editor.theme"
    private static let editorFontSizeKey = "matrix.editor.font-size"
    private static let editorWrapKey = "matrix.editor.wrap-lines"
    private static let editorTabWidthKey = "matrix.editor.tab-width"
    private static let editorInvisiblesKey = "matrix.editor.show-invisibles"

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

    private static func clearPersistedProfile() {
        let d = UserDefaults.standard
        d.removeObject(forKey: handleKey)
        d.removeObject(forKey: hostKey)
        d.removeObject(forKey: slotKey)
    }

    private static func loadPersistedEditorTheme() -> CodeEditorTheme {
        let raw = UserDefaults.standard.string(forKey: editorThemeKey)
        return raw.flatMap(CodeEditorTheme.init(rawValue:)) ?? .xcodeDark
    }

    private static func loadPersistedEditorPreferences() -> CodeEditorPreferences {
        let defaults = UserDefaults.standard
        var preferences = CodeEditorPreferences.default
        let fontSize = defaults.double(forKey: editorFontSizeKey)
        if fontSize > 0 {
            preferences.fontSize = min(max(fontSize, 11), 20)
        }
        if defaults.object(forKey: editorWrapKey) != nil {
            preferences.wrapsLines = defaults.bool(forKey: editorWrapKey)
        }
        let tabWidth = defaults.integer(forKey: editorTabWidthKey)
        if tabWidth > 0 {
            preferences.tabWidth = min(max(tabWidth, 2), 8)
        }
        if defaults.object(forKey: editorInvisiblesKey) != nil {
            preferences.showsInvisibleCharacters = defaults.bool(forKey: editorInvisiblesKey)
        }
        return preferences
    }

    public func setEditorTheme(_ theme: CodeEditorTheme) {
        editorTheme = theme
        UserDefaults.standard.set(theme.rawValue, forKey: Self.editorThemeKey)
    }

    public func setEditorFontSize(_ fontSize: Double) {
        editorPreferences.fontSize = min(max(fontSize, 11), 20)
        UserDefaults.standard.set(editorPreferences.fontSize, forKey: Self.editorFontSizeKey)
    }

    public func setEditorWrapsLines(_ wraps: Bool) {
        editorPreferences.wrapsLines = wraps
        UserDefaults.standard.set(wraps, forKey: Self.editorWrapKey)
    }

    public func setEditorTabWidth(_ width: Int) {
        editorPreferences.tabWidth = min(max(width, 2), 8)
        UserDefaults.standard.set(editorPreferences.tabWidth, forKey: Self.editorTabWidthKey)
    }

    public func setEditorShowsInvisibleCharacters(_ shows: Bool) {
        editorPreferences.showsInvisibleCharacters = shows
        UserDefaults.standard.set(shows, forKey: Self.editorInvisiblesKey)
    }

    // MARK: - Sign in (device authorization)

    /// Default browser opener used outside tests.
    public static let defaultOpenExternalURL: @Sendable (URL) -> Void = { url in
        #if canImport(AppKit)
        #if canImport(AuthenticationServices)
        Task { @MainActor in
            NativeAuthBrowser.shared.open(url)
        }
        #else
        NSWorkspace.shared.open(url)
        #endif
        #endif
    }

    public static let defaultCancelExternalAuth: @MainActor @Sendable () -> Void = {
        #if canImport(AppKit) && canImport(AuthenticationServices)
        NativeAuthBrowser.shared.cancel()
        #endif
    }

    /// Starts the device-authorization sign-in: requests a device code, opens the
    /// verification page in the browser, and polls until approved. On success it
    /// stores the principal token, builds a profile, and loads the board.
    public func beginSignIn(mode: SignInMode = .signIn) {
        signInTask?.cancel()
        signInMode = mode
        signIn = .starting
        signInTask = Task { [weak self] in await self?.runSignIn() }
    }

    /// Cancels an in-flight sign-in and returns to the idle onboarding state.
    public func cancelSignIn() {
        signInTask?.cancel()
        signInTask = nil
        signIn = .idle
        cancelExternalAuth()
    }

    public func handleOpenURL(_ url: URL) {
        guard (url.scheme == "matrixos" || url.scheme == "matrix-os"), url.host == "auth" else { return }
        let status = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "status" })?
            .value
        switch status {
        case "approved":
            // Approval is now owned by the polling loop. Keep this legacy deep
            // link as a no-op so older browser callbacks do not regress state.
            break
        case "expired":
            signIn = .failed("Sign-in expired. Try again.")
        case "error":
            signIn = .failed("Sign-in failed. Check your connection and try again.")
        default:
            break
        }
    }

    public func signOut() {
        Task { await signOutNow() }
    }

    public func signOutNow() async {
        signInTask?.cancel()
        signInTask = nil
        cancelExternalAuth()
        do {
            try await principal.clear()
        } catch {
            appModelLogger.warning("Principal clear failed during sign-out: \(String(describing: error), privacy: .private)")
        }
        Self.clearPersistedProfile()
        terminal?.shutdown()
        for session in terminalSessions.values {
            session.shutdown()
        }
        profile = nil
        phase = .needsProfile
        signIn = .idle
        hasSelectedProject = false
        section = .board
        nativeSettingsSection = .account
        selectedCard = nil
        terminal = nil
        terminalSessions = [:]
        terminalSessionAccessOrder = []
        sessions = []
        projects = []
        openTabs = []
        activeTabID = nil
        activePanel = .app(slug: "editor")
        enabledPanels = [.terminal, .app(slug: "editor")]
        fileEntries = []
        fileTree = []
        filePanelPath = ""
        selectedFilePath = nil
        selectedFileData = nil
        selectedFileContent = ""
        isLoadingSelectedFile = false
        fileSaveState = nil
        gitBranches = []
        gitPullRequests = []
        gitWorktrees = []
        previews = []
        systemInfo = nil
        openError = nil
        workspaceSearchQuery = ""
        board = BoardStore(loader: UnconfiguredBoardLoader())
    }

    private func runSignIn() async {
        do {
            let start = try await deviceAuth.startDeviceAuth()
            if Task.isCancelled { return }
            let verificationUri = verificationURI(start.verificationUri, mode: signInMode)
            signIn = .awaitingApproval(userCode: start.userCode, verificationUri: verificationUri)
            if let url = URL(string: verificationUri) {
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
                    if !hasSelectedProject {
                        ensureHomeTab(select: true)
                    }
                    signInCompletionID += 1
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

    private func verificationURI(_ rawValue: String, mode: SignInMode) -> String {
        guard var components = URLComponents(string: rawValue) else { return rawValue }
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "mode" }
        items.append(URLQueryItem(name: "mode", value: mode.rawValue))
        if !items.contains(where: { $0.name == "redirect_uri" }) {
            items.append(URLQueryItem(name: "redirect_uri", value: "matrixos://auth?status=approved"))
        }
        components.queryItems = items
        return components.url?.absoluteString ?? rawValue
    }

    // MARK: - Profile selection

    /// Selects a connection profile, rebuilds the gateway client + board store,
    /// and transitions to `.connecting`. The next `refresh()` loads the board.
    public func selectProfile(_ profile: ConnectionProfile) {
        workspaceSearchQuery = ""
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
        guard await principal.token() != nil else {
            phase = .needsProfile
            terminal?.shutdown()
            terminal = nil
            openError = nil
            return
        }
        if phase == .ready {
            // Keep showing the board while refreshing; only drop to disconnected on failure.
        } else {
            phase = .connecting
        }
        await loadProjects()
        guard hasSelectedProject else {
            phase = .ready
            return
        }
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

    public func currentBearerToken() async -> String? {
        await principal.token()
    }

    public func shellURL() -> URL? {
        try? profile?.gatewayBaseURL()
    }

    public func homeTitle() -> String {
        "Home"
    }

    public func appURL(slug: String) -> URL? {
        guard let base = try? profile?.gatewayBaseURL(),
              var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        comps.path = "/files/apps/\(slug)/index.html"
        return comps.url
    }

    public func ensureHomeTab(select: Bool = false) {
        guard profile != nil else { return }
        let existingPanel = openTabs.first(where: { $0.id == "home" })?.panel
        let home = WorkspaceTab(
            id: "home",
            title: homeTitle(),
            projectSlug: projectSlug,
            projectName: activeProjectName,
            kind: .home,
            panel: existingPanel ?? .shell
        )
        if let index = openTabs.firstIndex(where: { $0.id == home.id }) {
            openTabs[index] = home
        } else {
            openTabs.insert(home, at: 0)
        }
        if select || activeTabID == nil {
            focusTab(id: home.id)
        }
    }

    public func openAppTab(slug: String, title: String) {
        guard profile != nil else { return }
        workspaceSearchQuery = ""
        let kind: WorkspaceTab.Kind
        let id: String
        switch slug {
        case "settings":
            kind = .settings
            id = "settings"
            section = .settings
        case "resources":
            kind = .resources
            id = "resources"
            section = .resources
        default:
            kind = .app
            id = "app:\(slug)"
            section = .board
        }
        let tab = WorkspaceTab(
            id: id,
            title: title,
            projectSlug: projectSlug,
            projectName: activeProjectName,
            kind: kind,
            panel: .app(slug: slug)
        )
        if let index = openTabs.firstIndex(where: { $0.id == id }) {
            openTabs[index] = tab
        } else {
            openTabs.append(tab)
            trimOpenTabsToLimit(protecting: id)
        }
        activeTabID = id
        activePanel = .app(slug: slug)
        Task { await loadPanelData(for: .app(slug: slug)) }
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
        struct SessionDTO: Decodable {
            let name: String
            let attachName: String
            let status: String
            let aliases: [String]

            private enum CodingKeys: String, CodingKey {
                case name, id, sessionId, terminalSessionId, status, state, runtime
            }

            private enum RuntimeKeys: String, CodingKey {
                case status, zellijSession
            }

            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let runtime = try? container.nestedContainer(keyedBy: RuntimeKeys.self, forKey: .runtime)
                let directName = try container.decodeIfPresent(String.self, forKey: .name)
                let zellijName = try runtime?.decodeIfPresent(String.self, forKey: .zellijSession)
                let id = try container.decodeIfPresent(String.self, forKey: .id)
                let terminalId = try container.decodeIfPresent(String.self, forKey: .terminalSessionId)
                let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
                name = directName
                    ?? zellijName
                    ?? terminalId
                    ?? sessionId
                    ?? id
                    ?? ""
                attachName = zellijName
                    ?? directName
                    ?? terminalId
                    ?? sessionId
                    ?? id
                    ?? ""
                aliases = [directName, zellijName, id, terminalId, sessionId]
                    .compactMap { $0 }
                    .filter { !$0.isEmpty }
                status = try container.decodeIfPresent(String.self, forKey: .status)
                    ?? container.decodeIfPresent(String.self, forKey: .state)
                    ?? runtime?.decodeIfPresent(String.self, forKey: .status)
                    ?? "active"
            }
        }
        struct SessionsResponse: Decodable {
            let sessions: [SessionDTO]
        }
        var byName: [String: WorkspaceSession] = [:]
        var nextAttachNames: [String: String] = [:]
        func merge(_ dtos: [SessionDTO]) {
            for dto in dtos where !dto.name.isEmpty {
                byName[dto.name] = WorkspaceSession(name: dto.name, attachName: dto.attachName, status: dto.status)
                for alias in dto.aliases {
                    nextAttachNames[alias] = dto.attachName
                }
                nextAttachNames[dto.name] = dto.attachName
            }
        }
        if let response: SessionsResponse = try? await client.get("/api/terminal/sessions") {
            merge(response.sessions)
        }
        if let response: SessionsResponse = try? await client.get("/api/sessions?limit=100") {
            merge(response.sessions)
        }
        if let response: [SessionDTO] = try? await client.get("/api/terminal/pty-sessions") {
            merge(response)
        }
        let loaded = Array(byName.values).sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive { return lhs.isActive && !rhs.isActive }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
        sessionAttachNames = nextAttachNames
        sessions = loaded
        if !loaded.isEmpty {
            if section == .terminal, terminal == nil, let first = sessions.first(where: \.isActive) ?? sessions.first {
                openSession(named: first.name)
            }
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
        guard slug != projectSlug || !hasSelectedProject, let client = gatewayClient() else { return }
        openError = nil
        workspaceSearchQuery = ""
        projectSlug = slug
        hasSelectedProject = true
        filePanelPath = "projects/\(slug)"
        selectedFilePath = nil
        selectedFileData = nil
        selectedFileContent = ""
        isLoadingSelectedFile = false
        board = BoardStore(loader: makeLoader(client))
        section = .board
        upsertProjectBoardTab(select: true)
        Task { await refresh() }
    }

    public func openBoardTab() {
        workspaceSearchQuery = ""
        if let currentBoardTab = openTabs.first(where: { $0.id == "board:\(projectSlug)" }) {
            focusTab(id: currentBoardTab.id)
            return
        }
        if let existingBoardTab = openTabs.first(where: { $0.kind == .board }) {
            focusTab(id: existingBoardTab.id)
            return
        }
        if hasSelectedProject {
            upsertProjectBoardTab(select: true)
            return
        }
        section = .board
        activeTabID = nil
        selectedCard = nil
        terminal = nil
        activePanel = .app(slug: "board")
    }

    public func openHome() {
        workspaceSearchQuery = ""
        hasSelectedProject = false
        selectedCard = nil
        terminal = nil
        section = .home
        activePanel = .shell
        ensureHomeTab(select: true)
    }

    public func openTerminalSection() {
        workspaceSearchQuery = ""
        section = .terminal
        Task { await loadSessions() }
    }

    public func focusNativeSettingsSection(_ section: NativeSettingsSection) {
        nativeSettingsSection = section
    }

    public var activeProjectName: String {
        projects.first { $0.slug == projectSlug }?.name ?? projectSlug
    }

    public var activeTabTitle: String {
        openTabs.first { $0.id == activeTabID }?.title
            ?? selectedCard?.title
            ?? homeTitle()
    }

    public var activeTerminalSessionName: String? {
        selectedCard?.linkedSessionId ?? selectedCard?.id
    }

    /// Creates a project (optionally from a git remote) and opens it.
    public func createProject(name: String, remote: String?, startMode: ProjectStartMode = .scratch) {
        guard let client = gatewayClient() else { return }
        openError = nil
        Task { [weak self] in
            let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedRemote = remote?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard startMode != .linear, !trimmedName.isEmpty else {
                await MainActor.run { self?.openError = .createProjectFailed }
                return
            }
            guard startMode != .github || !trimmedRemote.isEmpty else {
                await MainActor.run { self?.openError = .createProjectFailed }
                return
            }
            let slug = name
                .lowercased()
                .components(separatedBy: CharacterSet.alphanumerics.inverted)
                .filter { !$0.isEmpty }
                .joined(separator: "-")
            struct CreateProjectRequest: Encodable {
                let url: String?
                let slug: String?
                let name: String?
                let mode: String
            }
            struct CreateProjectResponse: Decodable { let project: Project?; struct Project: Decodable { let slug: String } }
            do {
                let response: CreateProjectResponse = try await client.post(
                    "/api/projects",
                    body: CreateProjectRequest(
                        url: trimmedRemote.isEmpty ? nil : trimmedRemote,
                        slug: slug.isEmpty ? nil : slug,
                        name: trimmedName,
                        mode: startMode.rawValue
                    )
                )
                await self?.loadProjects()
                if let slug = response.project?.slug {
                    self?.ensureProjectIsListed(ProjectSummary(slug: slug, name: trimmedName, remote: trimmedRemote.isEmpty ? nil : trimmedRemote))
                    self?.openProject(slug: slug)
                }
            } catch {
                appModelLogger.error("Create project request failed: \(String(describing: error), privacy: .private)")
                await MainActor.run { self?.openError = .createProjectFailed }
            }
        }
    }

    private func ensureProjectIsListed(_ project: ProjectSummary) {
        guard !projects.contains(where: { $0.slug == project.slug }) else { return }
        projects.insert(project, at: 0)
    }

    /// Moves a card to a new column/order (drag-to-move). Persists via PATCH and
    /// refreshes on completion to reconcile.
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
                appModelLogger.error("Task status update failed: \(String(describing: error), privacy: .private)")
                await MainActor.run { self?.openError = .taskMutationFailed }
                await self?.refresh() // reconcile on failure too
            }
        }
    }

    /// Opens a raw zellij session (Terminals section) in the side terminal view.
    public func openSession(named name: String) {
        section = .terminal
        let card = Card(
            id: name, projectSlug: projectSlug, title: name,
            status: .running, priority: .normal, order: 0,
            linkedSessionId: name, updatedAt: ""
        )
        Task {
            do {
                try await openCard(card)
            } catch let error as OperatorError {
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
            struct CreateTaskResponse: Decodable {
                let task: GatewayTaskDTO?
            }
            do {
                let response: CreateTaskResponse = try await client.post(
                    "/api/projects/\(slug)/tasks",
                    body: CreateTaskRequest(title: "New task", status: status.rawValue)
                )
                if let task = response.task {
                    let card = task.toCard()
                    await MainActor.run {
                        self.selectedCard = card
                        self.activePanel = .terminal
                        _ = self.upsertTab(for: card)
                    }
                    Task { try? await self.openCard(card) }
                }
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
    /// a GENERIC `OperatorError` (no raw text).
    @discardableResult
    public func openCard(_ card: Card) async throws -> TerminalSession {
        openError = nil
        selectedCard = card
        let tabID = upsertTab(for: card)
        activePanel = .terminal
        openCardGeneration += 1
        let generation = openCardGeneration

        if let existing = terminalSessions[tabID] {
            markTerminalSessionUsed(tabID)
            terminal = existing
            return existing
        }

        guard let profile else {
            let err = OperatorError.misconfigured
            openError = err
            throw err
        }
        guard await principal.token() != nil else {
            let err = OperatorError.unauthorized
            openError = err
            throw err
        }
        guard generation == openCardGeneration, selectedCard?.id == card.id else {
            throw OperatorError.noSession
        }

        // Existing session → attach by name. No session yet → connect to
        // `/ws/terminal?cwd=` which auto-creates one (matrix shell connect -c).
        let requestedSession = card.linkedSessionId ?? ""
        let attachSession = sessionAttachName(for: requestedSession)
        let hasSession = !attachSession.isEmpty
        let wsURL: URL
        do {
            if hasSession {
                wsURL = try profile.webSocketURL(
                    path: "/ws/terminal/session",
                    session: attachSession,
                    fromSeq: Int?.none
                )
            } else {
                wsURL = try profile.autoCreateTerminalURL(cwd: nil)
            }
        } catch {
            let err = OperatorError.misconfigured
            openError = err
            throw err
        }

        let label = hasSession ? attachSession : card.title
        let session = makeTerminal(wsURL, principal, attachSession, label)
        cacheTerminalSession(session, for: tabID)
        terminal = session
        if !hasSession {
            session.onNextAttach { [weak self] in
                Task { await self?.loadSessions() }
            }
        }
        session.start()
        return session
    }

    /// Opens a workspace tab by reattaching its card/session terminal.
    public func focusTab(id: String) {
        guard let index = openTabs.firstIndex(where: { $0.id == id }) else { return }
        workspaceSearchQuery = ""
        var tab = openTabs[index]
        activeTabID = id
        if tab.kind == .board {
            section = .board
            if !tab.projectSlug.isEmpty {
                self.projectSlug = tab.projectSlug
                hasSelectedProject = true
            }
            terminal = nil
            selectedCard = nil
            activePanel = .app(slug: "board")
            return
        }
        if tab.kind == .home {
            section = .home
            terminal = nil
            selectedCard = nil
            activePanel = .shell
            return
        }
        if tab.kind == .settings {
            section = .settings
            terminal = nil
            selectedCard = nil
            activePanel = .app(slug: "settings")
            Task { await loadSystemInfo() }
            return
        }
        if tab.kind == .resources {
            section = .resources
            terminal = nil
            selectedCard = nil
            activePanel = .app(slug: "resources")
            Task { await loadSystemInfo() }
            return
        }
        switch tab.kind {
        case .task, .app:
            section = .board
            if !tab.projectSlug.isEmpty {
                projectSlug = tab.projectSlug
                hasSelectedProject = true
            }
        case .session:
            section = .terminal
        case .home, .board, .settings, .resources:
            assertionFailure("focusTab: \(tab.kind) should have returned early above")
        }
        if enabledPanels.contains(tab.panel) {
            activePanel = tab.panel
        } else {
            activePanel = enabledPanels.first ?? .terminal
            tab.panel = activePanel
            openTabs[index] = tab
        }
        selectedCard = tab.card
        if let cachedTerminal = terminalSessions[id] {
            markTerminalSessionUsed(id)
            terminal = cachedTerminal
            return
        }
        if let card = tab.card {
            Task {
                do {
                    try await openCard(card)
                } catch let error as OperatorError {
                    await MainActor.run { self.openError = error }
                } catch {
                    await MainActor.run { self.openError = .misconfigured }
                }
            }
        } else {
            terminal = nil
        }
    }

    /// Closes a workspace tab. If the active tab closes, focus the nearest
    /// remaining tab; otherwise detach the current terminal.
    public func closeTab(id: String) {
        guard let index = openTabs.firstIndex(where: { $0.id == id }) else { return }
        let closedTab = openTabs[index]
        let wasActive = activeTabID == id
        openTabs.remove(at: index)
        removeCachedTerminalSession(for: id)
        reconcileProjectSelectionAfterClosing(closedTab)
        if !wasActive { return }
        terminal = nil
        selectedCard = nil
        openError = nil
        let nextIndex = min(index, openTabs.count - 1)
        guard nextIndex >= 0, openTabs.indices.contains(nextIndex) else {
            activeTabID = nil
            if id.hasPrefix("board:") {
                hasSelectedProject = false
            }
            if section == .settings || section == .resources {
                section = .board
            }
            return
        }
        let next = openTabs[nextIndex]
        activeTabID = next.id
        focusTab(id: next.id)
    }

    private func reconcileProjectSelectionAfterClosing(_ closedTab: WorkspaceTab) {
        guard isProjectRelatedTab(closedTab),
              !hasOpenProjectRelatedTab(for: closedTab.projectSlug),
              projectSlug == closedTab.projectSlug else { return }
        hasSelectedProject = false
    }

    private func hasOpenProjectRelatedTab(for slug: String) -> Bool {
        openTabs.contains { tab in
            tab.projectSlug == slug && isProjectRelatedTab(tab)
        }
    }

    private func isProjectRelatedTab(_ tab: WorkspaceTab) -> Bool {
        guard !tab.projectSlug.isEmpty else { return false }
        switch tab.kind {
        case .board, .task, .session:
            return true
        case .home, .settings, .resources, .app:
            return false
        }
    }

    public func closeActiveTab() {
        guard let activeTabID else { return }
        closeTab(id: activeTabID)
    }

    public func focusNextTab() {
        focusTab(offset: 1)
    }

    public func focusPreviousTab() {
        focusTab(offset: -1)
    }

    private func focusTab(offset: Int) {
        guard !openTabs.isEmpty else { return }
        let currentIndex = activeTabID.flatMap { id in openTabs.firstIndex(where: { $0.id == id }) } ?? 0
        let nextIndex = (currentIndex + offset + openTabs.count) % openTabs.count
        focusTab(id: openTabs[nextIndex].id)
    }

    /// Closes the open card's terminal and detail pane (Esc / light-dismiss).
    public func closeCard() {
        if let activeTabID {
            closeTab(id: activeTabID)
            return
        }
        terminal?.shutdown()
        terminal = nil
        selectedCard = nil
        openError = nil
    }

    public func closeSession(named name: String) {
        if let tab = openTabs.first(where: { tab in
            tab.card?.linkedSessionId == name || tab.card?.id == name
        }) {
            closeTab(id: tab.id)
            return
        }
        if selectedCard?.linkedSessionId == name || selectedCard?.id == name {
            closeCard()
        }
    }

    /// Switches the active detail panel (⌘1/2/3). US1 only renders Terminal.
    public func switchPanel(_ panel: Panel) {
        activePanel = panel
        if !enabledPanels.contains(panel) {
            enabledPanels.append(panel)
        }
        if let activeTabID,
           let index = openTabs.firstIndex(where: { $0.id == activeTabID }) {
            openTabs[index].panel = panel
        }
        Task { await loadPanelData(for: panel) }
    }

    public func togglePanel(_ panel: Panel) {
        if enabledPanels.contains(panel) {
            guard enabledPanels.count > 1 else { return }
            enabledPanels.removeAll { $0 == panel }
            if activePanel == panel {
                activePanel = enabledPanels.first ?? .terminal
                if let activeTabID,
                   let index = openTabs.firstIndex(where: { $0.id == activeTabID }) {
                    openTabs[index].panel = activePanel
                }
            }
            return
        }
        enabledPanels.append(panel)
        switchPanel(panel)
    }

    public func loadSelectedTabPanel() {
        Task { await loadPanelData(for: activePanel) }
    }

    public func loadPanelData(for panel: Panel? = nil) async {
        let panel = panel ?? activePanel
        guard let client = gatewayClient() else { return }
        isLoadingPanelData = true
        defer { isLoadingPanelData = false }
        switch panel {
        case .terminal, .shell:
            return
        case .app(let slug):
            switch slug {
            case "editor":
                await loadFiles(client: client)
            case "git":
                await loadGit(client: client)
            case "artifacts":
                await loadPreviews(client: client)
            case "processes":
                await loadSessions()
            case "settings", "resources":
                await loadSystemInfo()
            default:
                return
            }
        }
    }

    public func filteredOpenTabs(matching query: String) -> [WorkspaceTab] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return openTabs }
        return openTabs.filter { tab in
            tab.id == activeTabID
                || tab.title.localizedCaseInsensitiveContains(trimmed)
                || tab.projectName.localizedCaseInsensitiveContains(trimmed)
                || tab.kind.rawValue.localizedCaseInsensitiveContains(trimmed)
        }
    }

    public func filteredBoardColumns(matching query: String) -> [BoardColumn] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return board.columns }
        return board.columns.compactMap { column in
            let cards = column.cards.filter { card in
                card.title.localizedCaseInsensitiveContains(trimmed)
                    || card.status.rawValue.localizedCaseInsensitiveContains(trimmed)
                    || card.priority.rawValue.localizedCaseInsensitiveContains(trimmed)
                    || card.tags.contains { $0.localizedCaseInsensitiveContains(trimmed) }
            }
            guard !cards.isEmpty else { return nil }
            return BoardColumn(
                status: column.status,
                cards: cards
            )
        }
    }

    @MainActor
    public func loadSystemInfo() async {
        guard !isLoadingSystemInfo else { return }
        guard let client = gatewayClient() else { return }
        isLoadingSystemInfo = true
        defer { isLoadingSystemInfo = false }
        do {
            systemInfo = try await client.get("/api/system/info", as: NativeSystemInfoSummary.self)
        } catch {
            appModelLogger.warning("System info load failed: \(String(describing: error), privacy: .private)")
        }
    }

    private func loadFiles(client: GatewayHTTPClient) async {
        struct FilesResponse: Decodable {
            struct Entry: Decodable {
                let name: String
                let type: String
                let size: Int?
                let gitStatus: String?
                let changedCount: Int?
            }
            let entries: [Entry]
        }
        if filePanelPath.isEmpty {
            filePanelPath = "projects/\(projectSlug)"
        }
        await loadFileTree(path: filePanelPath, replaceRoot: true, client: client)
        if let response: FilesResponse = try? await client.get("/api/files/list?path=\(queryValue(filePanelPath))") {
            fileEntries = response.entries.map {
                WorkspaceFileEntry(
                    name: $0.name,
                    type: $0.type,
                    size: $0.size,
                    gitStatus: $0.gitStatus,
                    changedCount: $0.changedCount
                )
            }
        }
    }

    private struct FileTreeDTO: Decodable {
        let name: String
        let type: String
        let size: Int?
        let gitStatus: String?
        let changedCount: Int?
    }

    private func loadFileTree(path: String, replaceRoot: Bool, client: GatewayHTTPClient) async {
        let entries: [FileTreeDTO]
        do {
            entries = try await client.get("/api/files/tree?path=\(queryValue(path))")
        } catch {
            return
        }
        let nodes = entries.map { dto in
            let childPath = path.isEmpty ? dto.name : "\(path)/\(dto.name)"
            return WorkspaceFileTreeNode(
                id: childPath,
                name: dto.name,
                type: dto.type,
                path: childPath,
                size: dto.size,
                gitStatus: dto.gitStatus,
                changedCount: dto.changedCount,
                children: nil,
                expanded: false
            )
        }
        if replaceRoot {
            fileTree = nodes
        } else {
            fileTree = updateTree(fileTree, path: path) { node in
                var next = node
                next.children = nodes
                next.expanded = true
                return next
            }
        }
    }

    public func openFileEntry(_ entry: WorkspaceFileEntry) {
        guard let client = gatewayClient() else { return }
        let path = "\(filePanelPath.isEmpty ? "projects/\(projectSlug)" : filePanelPath)/\(entry.name)"
        fileSaveState = nil
        if entry.type == "directory" {
            filePanelPath = path
            selectedFilePath = nil
            selectedFileData = nil
            selectedFileContent = ""
            isLoadingSelectedFile = false
            Task { await loadFiles(client: client) }
            return
        }
        openFile(path: path, client: client)
    }

    public func toggleFileTreeNode(_ node: WorkspaceFileTreeNode) {
        guard node.isDirectory, let client = gatewayClient() else { return }
        if node.expanded {
            fileTree = updateTree(fileTree, path: node.path) { current in
                var next = current
                next.expanded = false
                return next
            }
            return
        }
        Task { await loadFileTree(path: node.path, replaceRoot: false, client: client) }
    }

    public func openFileTreeNode(_ node: WorkspaceFileTreeNode) {
        if node.isDirectory {
            toggleFileTreeNode(node)
            return
        }
        guard let client = gatewayClient() else { return }
        openFile(path: node.path, client: client)
    }

    private func openFile(path: String, client: GatewayHTTPClient) {
        selectedFilePath = path
        selectedFileData = nil
        selectedFileContent = ""
        isLoadingSelectedFile = true
        fileSaveState = nil
        let route = fileRoute(path)
        Task { [weak self] in
            do {
                let data = try await client.getData(route)
                let text = String(data: data, encoding: .utf8) ?? ""
                await MainActor.run {
                    guard self?.selectedFilePath == path else { return }
                    self?.selectedFileData = data
                    self?.selectedFileContent = text
                    self?.isLoadingSelectedFile = false
                    self?.fileSaveState = nil
                }
            } catch {
                await MainActor.run {
                    guard self?.selectedFilePath == path else { return }
                    self?.selectedFileData = nil
                    self?.selectedFileContent = ""
                    self?.isLoadingSelectedFile = false
                    self?.fileSaveState = "Couldn't open this file."
                }
            }
        }
    }

    private func updateTree(
        _ nodes: [WorkspaceFileTreeNode],
        path: String,
        transform: (WorkspaceFileTreeNode) -> WorkspaceFileTreeNode
    ) -> [WorkspaceFileTreeNode] {
        nodes.map { node in
            if node.path == path {
                return transform(node)
            }
            var next = node
            if let children = node.children {
                next.children = updateTree(children, path: path, transform: transform)
            }
            return next
        }
    }

    public func goUpInFiles() {
        guard !filePanelPath.isEmpty else { return }
        let parts = filePanelPath.split(separator: "/").map(String.init)
        guard parts.count > 2 else { return }
        filePanelPath = parts.dropLast().joined(separator: "/")
        selectedFilePath = nil
        selectedFileData = nil
        selectedFileContent = ""
        isLoadingSelectedFile = false
        Task { await loadPanelData(for: .app(slug: "editor")) }
    }

    public func saveSelectedFile() {
        guard let client = gatewayClient(), let path = selectedFilePath else { return }
        fileSaveState = "Saving..."
        let content = selectedFileContent
        let route = fileRoute(path)
        Task { [weak self] in
            do {
                try await client.putData(route, data: Data(content.utf8))
                await MainActor.run { self?.fileSaveState = "Saved" }
                await self?.loadPanelData(for: .app(slug: "editor"))
            } catch {
                await MainActor.run { self?.fileSaveState = "Couldn't save this file." }
            }
        }
    }

    private func loadGit(client: GatewayHTTPClient) async {
        struct BranchesResponse: Decodable {
            struct Branch: Decodable { let name: String }
            let branches: [Branch]
        }
        struct PRsResponse: Decodable {
            struct PR: Decodable {
                let number: Int
                let title: String
                let headRefName: String?
                let baseRefName: String?
            }
            let prs: [PR]
        }
        struct WorktreesResponse: Decodable {
            struct Worktree: Decodable {
                let id: String
                let path: String
                let currentBranch: String
                let dirtyState: String
                let dirtyCount: Int?
            }
            let worktrees: [Worktree]
        }
        async let branchesResponse: BranchesResponse? = try? client.get("/api/projects/\(projectSlug)/branches")
        async let prsResponse: PRsResponse? = try? client.get("/api/projects/\(projectSlug)/prs")
        async let worktreesResponse: WorktreesResponse? = try? client.get("/api/projects/\(projectSlug)/worktrees")
        let branches = await branchesResponse?.branches ?? []
        let prs = await prsResponse?.prs ?? []
        let worktrees = await worktreesResponse?.worktrees ?? []
        gitBranches = branches.map { GitBranchSummary(name: $0.name) }
        gitPullRequests = prs.map {
            GitPullRequestSummary(
                number: $0.number,
                title: $0.title,
                headRefName: $0.headRefName,
                baseRefName: $0.baseRefName
            )
        }
        gitWorktrees = worktrees.map {
            GitWorktreeSummary(
                id: $0.id,
                path: $0.path,
                currentBranch: $0.currentBranch,
                dirtyState: $0.dirtyState,
                dirtyCount: $0.dirtyCount
            )
        }
    }

    private func loadPreviews(client: GatewayHTTPClient) async {
        struct PreviewsResponse: Decodable {
            struct Preview: Decodable {
                let id: String
                let label: String
                let url: String
                let lastStatus: String
            }
            let previews: [Preview]
        }
        var path = "/api/projects/\(projectSlug)/previews?limit=50"
        if let taskId = selectedCard?.id, taskId.hasPrefix("task_") {
            path += "&taskId=\(queryValue(taskId))"
        } else if let sessionId = selectedCard?.linkedSessionId ?? selectedCard?.id, !sessionId.isEmpty {
            path += "&sessionId=\(queryValue(sessionId))"
        }
        if let response: PreviewsResponse = try? await client.get(path) {
            previews = response.previews.map {
                PreviewSummary(id: $0.id, label: $0.label, url: $0.url, lastStatus: $0.lastStatus)
            }
        }
    }

    public func sendCommandToActiveTerminal(_ command: String) {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if terminal == nil, let first = sessions.first(where: \.isActive) ?? sessions.first {
            openSession(named: first.name)
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000)
                await MainActor.run { self?.terminal?.send(trimmed + "\n") }
            }
            return
        }
        terminal?.send(trimmed + "\n")
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
        let existingSessionNames = Set(sessions.map(\.name))
        Task { [weak self] in
            defer { Task { @MainActor in self?.isCreatingWorkItem = false } }
            struct CreateSessionRequest: Encodable {
                let name: String
                let cwd: String?
            }
            struct CreateSessionResponse: Decodable {
                let name: String?
            }
            let createAttempts = 10
            for attempt in 0..<createAttempts {
                let name = generatedShellSessionName()
                do {
                    let response: CreateSessionResponse = try await client.post(
                        "/api/terminal/sessions",
                        body: CreateSessionRequest(name: name, cwd: nil)
                    )
                    await self?.loadSessions()
                    let requestedName = response.name ?? name
                    if self?.sessions.contains(where: { $0.name == requestedName }) == true {
                        await MainActor.run { self?.openSession(named: requestedName) }
                    } else if let created = self?.sessions.first(where: { !existingSessionNames.contains($0.name) }) {
                        await MainActor.run { self?.openSession(named: created.name) }
                    }
                    return
                } catch GatewayError.conflict(let code) where code == "session_exists" && attempt < createAttempts - 1 {
                    continue
                } catch {
                    await MainActor.run { self?.openError = .createSessionFailed }
                    return
                }
            }
            await MainActor.run { self?.openError = .createSessionFailed }
        }
    }

    private func displayName(for card: Card) -> String {
        if let session = card.linkedSessionId, !session.isEmpty {
            return sessionAttachName(for: session)
        }
        return card.title
    }

    private func sessionAttachName(for session: String) -> String {
        sessionAttachNames[session] ?? session
    }

    private func cacheTerminalSession(_ session: TerminalSession, for tabID: String) {
        terminalSessions[tabID] = session
        markTerminalSessionUsed(tabID)
        evictCachedTerminalSessionsIfNeeded()
    }

    private func markTerminalSessionUsed(_ tabID: String) {
        terminalSessionAccessOrder.removeAll { $0 == tabID }
        terminalSessionAccessOrder.append(tabID)
    }

    private func evictCachedTerminalSessionsIfNeeded() {
        while terminalSessions.count > maxCachedTerminalSessions {
            guard let evictID = terminalSessionAccessOrder.first(where: { $0 != activeTabID })
                ?? terminalSessions.keys.first(where: { $0 != activeTabID }) else {
                return
            }
            removeCachedTerminalSession(for: evictID)
        }
    }

    private func removeCachedTerminalSession(for tabID: String) {
        terminalSessionAccessOrder.removeAll { $0 == tabID }
        terminalSessions.removeValue(forKey: tabID)?.shutdown()
    }

    private func queryValue(_ value: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func fileRoute(_ path: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        let encoded = path
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { component in
                String(component).addingPercentEncoding(withAllowedCharacters: allowed) ?? String(component)
            }
            .joined(separator: "/")
        return "/files/\(encoded)"
    }

    @discardableResult
    private func upsertTab(for card: Card) -> String {
        let kind: WorkspaceTab.Kind = card.id.hasPrefix("task_") ? .task : .session
        let title = displayName(for: card)
        let tabID = "\(kind.rawValue):\(projectSlug):\(card.id)"
        let existingPanel = openTabs.first(where: { $0.id == tabID })?.panel
        let tab = WorkspaceTab(
            id: tabID,
            title: title,
            projectSlug: projectSlug,
            projectName: activeProjectName,
            kind: kind,
            card: card,
            panel: existingPanel ?? .terminal
        )
        if let index = openTabs.firstIndex(where: { $0.id == tab.id }) {
            openTabs[index] = tab
        } else {
            openTabs.append(tab)
            trimOpenTabsToLimit(protecting: tab.id)
        }
        activeTabID = tab.id
        return tab.id
    }

    private func upsertProjectBoardTab(select: Bool) {
        let tabID = "board:\(projectSlug)"
        let tab = WorkspaceTab(
            id: tabID,
            title: "\(activeProjectName) - Tasks",
            projectSlug: projectSlug,
            projectName: activeProjectName,
            kind: .board,
            panel: .app(slug: "board")
        )
        if let index = openTabs.firstIndex(where: { $0.id == tabID }) {
            openTabs[index] = tab
        } else if let firstWorkTab = openTabs.firstIndex(where: { $0.kind != .home }) {
            openTabs.insert(tab, at: firstWorkTab)
            trimOpenTabsToLimit(protecting: tabID)
        } else {
            openTabs.append(tab)
            trimOpenTabsToLimit(protecting: tabID)
        }
        if select {
            activeTabID = tabID
            selectedCard = nil
            terminal = nil
            activePanel = .app(slug: "board")
        }
    }

    private func trimOpenTabsToLimit(protecting protectedID: String) {
        let currentBoardID = "board:\(projectSlug)"
        while openTabs.count > 16 {
            guard let evictIndex = openTabs.firstIndex(where: { tab in
                tab.kind != .home && tab.id != currentBoardID && tab.id != protectedID
            }) else {
                return
            }
            let evicted = openTabs.remove(at: evictIndex)
            removeCachedTerminalSession(for: evicted.id)
            if activeTabID == evicted.id {
                terminal = nil
            }
        }
    }
}

#if canImport(AppKit) && canImport(AuthenticationServices)
@MainActor
private final class NativeAuthBrowser: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = NativeAuthBrowser()

    private var session: ASWebAuthenticationSession?

    func open(_ url: URL) {
        session?.cancel()
        let nextSession = ASWebAuthenticationSession(url: url, callbackURLScheme: "matrixos") { [weak self] callbackURL, error in
            Task { @MainActor in
                self?.session = nil
                if callbackURL != nil {
                    NSApp.activate(ignoringOtherApps: true)
                } else if let error {
                    appModelLogger.warning("Native auth browser ended without callback: \(String(describing: error), privacy: .private)")
                }
            }
        }
        nextSession.prefersEphemeralWebBrowserSession = false
        nextSession.presentationContextProvider = self
        session = nextSession
        if !nextSession.start() {
            session = nil
            NSWorkspace.shared.open(url)
        }
    }

    func cancel() {
        session?.cancel()
        session = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }
}
#endif

/// A `BoardLoading` that never fetches — used before a profile is selected or when
/// URL resolution fails. Always reports a generic misconfiguration so the UI shows
/// "no computer connected" rather than implying the board is simply empty.
private struct UnconfiguredBoardLoader: BoardLoading {
    func fetchTasks(projectSlug: String) async throws -> [Card] {
        throw GatewayError.misconfigured
    }
}
