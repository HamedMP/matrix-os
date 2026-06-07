#if os(macOS)
import XCTest
@testable import MatrixOS
import MatrixBoard
import MatrixModel
import MatrixNet
import MatrixTerminal

@MainActor
final class AppModelAuthTests: XCTestCase {
    func testWebShellAuthStateKeepsPromptWhenHostedShellRequiresAuth() {
        var state = WebShellAuthState()

        state.resolveToken("native-token")
        state.markHostedAuthRequired()
        state.resolveToken("native-token")

        XCTAssertTrue(state.shouldShowSignInPrompt)
        XCTAssertEqual(state.token, "native-token")
    }

    func testWebShellAuthStateClearsPromptAfterExplicitSignInReload() {
        var state = WebShellAuthState()

        state.resolveToken("old-token")
        state.markHostedAuthRequired()
        state.resolveToken("new-token", source: .explicitSignIn)

        XCTAssertFalse(state.shouldShowSignInPrompt)
        XCTAssertEqual(state.token, "new-token")
    }

    func testRefreshRequiresTokenEvenWhenProfileIsPersisted() async {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        let profile = ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com")
        let model = AppModel(
            principal: principal,
            projectSlug: "default",
            profile: profile,
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        await model.refresh()

        XCTAssertEqual(model.phase, .needsProfile)
    }

    func testOpenProjectSelectsCurrentSlugWhenNoProjectIsSelected() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        let profile = ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com")
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: profile,
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        XCTAssertFalse(model.hasSelectedProject)

        model.openProject(slug: "main")

        XCTAssertTrue(model.hasSelectedProject)
        XCTAssertEqual(model.projectSlug, "main")
        XCTAssertEqual(model.section, .board)
    }

    func testSelectingProfileKeepsNativeProjectSurface() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: nil,
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        model.selectProfile(ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"))

        XCTAssertEqual(model.section, .board)
        XCTAssertNil(model.activeTabID)
        XCTAssertTrue(model.openTabs.isEmpty)
    }

    func testOpeningProjectCreatesBoardTabAndSelectingTaskKeepsBoardTab() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            makeTerminal: { _, _, _, name in TerminalSession(displayName: name, client: IdleShellEventSource()) },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        model.openProject(slug: "main")

        XCTAssertEqual(model.openTabs.map(\.kind), [.board])
        XCTAssertEqual(model.activeTabID, "board:main")

        let card = Card(
            id: "task_1",
            projectSlug: "main",
            title: "Fix login",
            status: .todo,
            priority: .normal,
            order: 1,
            linkedSessionId: nil,
            updatedAt: "now"
        )
        _ = try? await model.openCard(card)

        XCTAssertTrue(model.openTabs.contains(where: { $0.id == "board:main" && $0.kind == .board }))
        XCTAssertTrue(model.openTabs.contains(where: { $0.kind == .task && $0.title == "Fix login" }))
    }

    func testTaskPaneTogglesKeepAtLeastOnePaneAndEnableMultiple() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: nil,
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        model.togglePanel(.app(slug: "git"))
        XCTAssertTrue(model.enabledPanels.contains(.terminal))
        XCTAssertTrue(model.enabledPanels.contains(.app(slug: "editor")))
        XCTAssertTrue(model.enabledPanels.contains(.app(slug: "git")))

        model.togglePanel(.terminal)
        model.togglePanel(.app(slug: "editor"))
        model.togglePanel(.app(slug: "git"))

        XCTAssertEqual(model.enabledPanels, [.app(slug: "git")])
    }

    func testRemovingFocusedPanePersistsFallbackPanelOnActiveTab() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )
        let card = Card(
            id: "task_login",
            projectSlug: "main",
            title: "Fix login",
            status: .todo,
            priority: .normal,
            order: 1,
            linkedSessionId: nil,
            updatedAt: "now"
        )
        _ = try? await model.openCard(card)

        model.switchPanel(.app(slug: "git"))
        model.togglePanel(.app(slug: "git"))

        XCTAssertFalse(model.enabledPanels.contains(.app(slug: "git")))
        XCTAssertEqual(model.activePanel, .terminal)
        XCTAssertEqual(model.openTabs.first(where: { $0.id == "task:main:task_login" })?.panel, .terminal)
    }

    func testFocusingTabFallsBackWhenStoredPaneWasDisabledElsewhere() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )
        let firstCard = Card(
            id: "task_login",
            projectSlug: "main",
            title: "Fix login",
            status: .todo,
            priority: .normal,
            order: 1,
            linkedSessionId: nil,
            updatedAt: "now"
        )
        let secondCard = Card(
            id: "task_editor",
            projectSlug: "main",
            title: "Fix editor",
            status: .todo,
            priority: .normal,
            order: 2,
            linkedSessionId: nil,
            updatedAt: "now"
        )
        _ = try? await model.openCard(firstCard)
        model.switchPanel(.app(slug: "git"))
        _ = try? await model.openCard(secondCard)
        model.togglePanel(.app(slug: "git"))

        model.focusTab(id: "task:main:task_login")

        XCTAssertFalse(model.enabledPanels.contains(.app(slug: "git")))
        XCTAssertTrue(model.enabledPanels.contains(model.activePanel))
        XCTAssertEqual(model.activePanel, .terminal)
        XCTAssertEqual(model.openTabs.first(where: { $0.id == "task:main:task_login" })?.panel, .terminal)
    }

    func testBoardTabIsProtectedWhenTaskTabsExceedLimit() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )
        model.openProject(slug: "main")

        for index in 0..<20 {
            let card = Card(
                id: "task_\(index)",
                projectSlug: "main",
                title: "Task \(index)",
                status: .todo,
                priority: .normal,
                order: Double(index),
                linkedSessionId: nil,
                updatedAt: "now"
            )
            _ = try? await model.openCard(card)
        }

        XCTAssertLessThanOrEqual(model.openTabs.count, 16)
        XCTAssertTrue(model.openTabs.contains(where: { $0.id == "board:main" && $0.kind == .board }))
    }

    func testStaleBoardTabsCanEvictSoTabLimitStillHolds() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        for index in 0..<20 {
            model.openProject(slug: "project-\(index)")
        }

        XCTAssertLessThanOrEqual(model.openTabs.count, 16)
        XCTAssertTrue(model.openTabs.contains(where: { $0.id == "board:project-19" && $0.kind == .board }))
        XCTAssertLessThan(model.openTabs.filter { $0.kind == .board }.count, 20)
    }

    func testApprovedSignInOpensHomeWhenNoProjectIsSelected() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        let openedURL = OpenedURLRecorder()
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: nil,
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(
                start: try makeDeviceAuthStart(
                    deviceCode: "DC",
                    userCode: "ABCD-EFGH",
                    verificationUri: "https://app.matrix-os.com/auth/device?user_code=ABD-EFGH",
                    expiresIn: 20,
                    interval: 1
                ),
                polls: [
                    .approved(try makeDeviceAuthToken(
                        accessToken: "native-token",
                        expiresAt: nil,
                        userId: "user_1",
                        handle: "hamed"
                    )),
                ]
            ),
            openExternalURL: { openedURL.open($0) }
        )

        model.beginSignIn(mode: SignInMode.signIn)
        try await Task.sleep(nanoseconds: 1_200_000_000)

        let token = await principal.token()
        XCTAssertEqual(token, "native-token")
        XCTAssertEqual(model.profile?.handle, "hamed")
        XCTAssertEqual(model.section, AppSection.home)
        XCTAssertFalse(model.hasSelectedProject)
        XCTAssertEqual(openedURL.urls.first?.absoluteString, "https://app.matrix-os.com/auth/device?user_code=ABD-EFGH&mode=sign-in")
    }
}

private final class MemoryTokenStore: TokenStoring, @unchecked Sendable {
    private var values: [String: String] = [:]

    func get(key: String) throws -> String? {
        values[key]
    }

    func set(key: String, value: String) throws {
        values[key] = value
    }

    func delete(key: String) throws {
        values.removeValue(forKey: key)
    }
}

private struct EmptyBoardLoader: BoardLoading {
    func fetchTasks(projectSlug: String) async throws -> [Card] {
        []
    }
}

private func makeDeviceAuthStart(
    deviceCode: String,
    userCode: String,
    verificationUri: String,
    expiresIn: Int,
    interval: Int
) throws -> DeviceAuthStart {
    let json = """
    {"deviceCode":"\(deviceCode)","userCode":"\(userCode)","verificationUri":"\(verificationUri)","expiresIn":\(expiresIn),"interval":\(interval)}
    """
    return try JSONDecoder().decode(DeviceAuthStart.self, from: Data(json.utf8))
}

private func makeDeviceAuthToken(
    accessToken: String,
    expiresAt: Double?,
    userId: String,
    handle: String
) throws -> DeviceAuthToken {
    let expires = expiresAt.map { String($0) } ?? "null"
    let json = """
    {"accessToken":"\(accessToken)","expiresAt":\(expires),"userId":"\(userId)","handle":"\(handle)"}
    """
    return try JSONDecoder().decode(DeviceAuthToken.self, from: Data(json.utf8))
}

private final class OpenedURLRecorder: @unchecked Sendable {
    private(set) var urls: [URL] = []

    func open(_ url: URL) {
        urls.append(url)
    }
}

private struct IdleShellEventSource: ShellEventSource {
    var events: AsyncStream<ServerEvent> {
        get async { AsyncStream { _ in } }
    }

    func connect() async {}
    func sendInput(_ data: String) async {}
    func resize(cols: Int, rows: Int) async {}
    func detach() async {}
    func shutdown() async {}
}

private final class MockDeviceAuthorizer: DeviceAuthorizing, @unchecked Sendable {
    var start: DeviceAuthStart?
    var polls: [DevicePollResult]

    init(start: DeviceAuthStart? = nil, polls: [DevicePollResult] = [.pending]) {
        self.start = start
        self.polls = polls
    }

    func startDeviceAuth() async throws -> DeviceAuthStart {
        if let start { return start }
        throw GatewayError.server
    }

    func pollForToken(deviceCode: String) async throws -> DevicePollResult {
        polls.isEmpty ? .pending : polls.removeFirst()
    }
}
#endif
