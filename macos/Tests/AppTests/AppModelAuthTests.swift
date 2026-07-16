#if os(macOS)
import Combine
import XCTest
@testable import MatrixOS
import MatrixBoard
import MatrixModel
import MatrixNet
import MatrixTerminal

@MainActor
final class AppModelAuthTests: XCTestCase {
    func testWebShellAuthStateClearsPromptOnAutomaticValidTokenReload() {
        var state = WebShellAuthState()

        state.resolveToken("native-token")
        _ = state.markHostedAuthRequired()
        state.resolveToken("native-token")

        XCTAssertFalse(state.shouldShowSignInPrompt)
        XCTAssertEqual(state.token, "native-token")
    }

    func testWebShellAuthStateClearsPromptAfterExplicitSignInReload() {
        var state = WebShellAuthState()

        state.resolveToken("old-token")
        _ = state.markHostedAuthRequired()
        state.resolveToken("new-token")

        XCTAssertFalse(state.shouldShowSignInPrompt)
        XCTAssertEqual(state.token, "new-token")
    }

    func testWebShellAuthStateRetriesHostedAuthOnceWithNativeToken() {
        var state = WebShellAuthState()

        state.resolveToken("native-token")

        XCTAssertTrue(state.markHostedAuthRequired())

        state.resolveToken("native-token")

        XCTAssertFalse(state.shouldShowSignInPrompt)
        XCTAssertEqual(state.token, "native-token")
        XCTAssertTrue(state.markHostedAuthRequired())
    }

    func testWebShellAuthStateClearsHostedPromptForFreshAutomaticReload() {
        var state = WebShellAuthState()

        state.resolveToken("native-token")
        _ = state.markHostedAuthRequired()
        state.resolveToken("native-token")

        XCTAssertFalse(state.shouldShowSignInPrompt)
        XCTAssertEqual(state.token, "native-token")
    }

    func testHandleOpenURLAcceptsCanonicalAndLegacyAuthCallbacks() {
        let model = AppModel(
            principal: PrincipalProvider(store: MemoryTokenStore()),
            projectSlug: "default",
            profile: nil,
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        model.handleOpenURL(URL(string: "matrixos://auth?status=approved")!)
        XCTAssertEqual(model.signIn, .idle)

        model.handleOpenURL(URL(string: "matrix-os://auth?status=approved")!)
        XCTAssertEqual(model.signIn, .idle)
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

    func testProjectBoardTabUsesTasksTitleAndTaskTabsUseTaskTitle() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        let model = AppModel(
            principal: principal,
            projectSlug: "matrix-os",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        model.openProject(slug: "matrix-os")
        let card = Card(
            id: "task_auth",
            projectSlug: "matrix-os",
            title: "Fix native auth",
            status: .todo,
            priority: .normal,
            order: 1,
            linkedSessionId: nil,
            updatedAt: "now"
        )
        _ = try? await model.openCard(card)

        XCTAssertEqual(model.openTabs.first(where: { $0.kind == .board })?.title, "matrix-os - Tasks")
        XCTAssertEqual(model.openTabs.first(where: { $0.kind == .task })?.title, "Fix native auth")
    }

    func testGlobalSettingsAndResourcesOpenDistinctTabs() async throws {
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

        model.openHome()
        model.openAppTab(slug: "settings", title: "Settings")
        model.openAppTab(slug: "resources", title: "Resources")

        XCTAssertEqual(model.openTabs.map(\.kind), [.home, .settings, .resources])
        XCTAssertEqual(model.activeTabID, "resources")
        XCTAssertEqual(model.openTabs.first(where: { $0.id == "settings" })?.panel, .app(slug: "settings"))
        XCTAssertEqual(model.openTabs.first(where: { $0.id == "resources" })?.panel, .app(slug: "resources"))
    }

    func testGenericAppTabClearsStaleSettingsSection() async throws {
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

        model.openAppTab(slug: "settings", title: "Settings")
        model.openAppTab(slug: "editor", title: "Editor")

        XCTAssertEqual(model.activeTabID, "app:editor")
        XCTAssertEqual(model.activePanel, .app(slug: "editor"))
        XCTAssertEqual(model.section, .board)
    }

    func testTabAndTaskFilteringIsCaseInsensitive() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        let cards = [
            Card(id: "task_auth", projectSlug: "main", title: "Fix native auth", status: .todo, priority: .normal, order: 1, updatedAt: "now"),
            Card(id: "task_terminal", projectSlug: "main", title: "Terminal focus", status: .running, priority: .normal, order: 2, updatedAt: "now"),
        ]
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in StaticBoardLoader(cards: cards) },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        model.openProject(slug: "main")
        await model.refresh()
        _ = try? await model.openCard(cards[0])
        model.openAppTab(slug: "settings", title: "Settings")

        XCTAssertEqual(model.filteredOpenTabs(matching: "sett").map(\.id), ["settings"])
        XCTAssertEqual(model.filteredOpenTabs(matching: "terminal").map(\.id), ["settings"])
        XCTAssertEqual(model.filteredBoardColumns(matching: "TERMINAL").map(\.status), [.running])
        XCTAssertEqual(model.filteredBoardColumns(matching: "TERMINAL").flatMap(\.cards).map(\.id), ["task_terminal"])
        XCTAssertEqual(model.filteredBoardColumns(matching: "missing").count, 0)
    }

    func testWorkspaceSearchClearsOnNavigationAndSignOut() async throws {
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

        model.workspaceSearchQuery = "auth"
        model.openProject(slug: "main")
        XCTAssertEqual(model.workspaceSearchQuery, "")

        model.workspaceSearchQuery = "settings"
        model.openAppTab(slug: "settings", title: "Settings")
        XCTAssertEqual(model.workspaceSearchQuery, "")

        model.workspaceSearchQuery = "terminal"
        model.focusTab(id: "board:main")
        XCTAssertEqual(model.workspaceSearchQuery, "")

        model.workspaceSearchQuery = "logout"
        await model.signOutNow()
        XCTAssertEqual(model.workspaceSearchQuery, "")
    }

    func testSystemInfoSummaryLoadsRuntimeAndResourcesWithoutInternalProviderNames() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        AppTestURLProtocol.setHandler { req in
            XCTAssertEqual(req.url?.path, "/api/system/info")
            let json = """
            {
              "version":"1.2.3",
              "image":"matrix-host",
              "runtime":{"handle":"alice","machineId":"machine-secret","runtimeSlot":"primary"},
              "build":{"sha":"abcdef123456","ref":"main","date":"2026-06-08"},
              "uptime":3661,
              "modules":5,
              "channels":{"telegram":true},
              "skills":9,
              "templateVersion":"1",
              "installedVersion":"1",
              "startedAt":"2026-06-08T10:00:00.000Z",
              "resources":{
                "cpuCount":4,
                "loadAverage":[0.5,0.4,0.3],
                "memoryTotalBytes":8589934592,
                "memoryFreeBytes":2147483648,
                "diskTotalBytes":107374182400,
                "diskFreeBytes":53687091200,
                "homeDiskTotalBytes":107374182400,
                "homeDiskFreeBytes":53687091200
              },
              "release":{"version":"1.2.3","channel":"dev"}
            }
            """
            return (appTestHTTPResponse(req.url!, 200), Data(json.utf8))
        }
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in
                GatewayHTTPClient(baseURL: url, tokenProvider: provider, sessionConfiguration: .appTestMocked())
            },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        await model.loadSystemInfo()

        XCTAssertEqual(model.systemInfo?.displayRuntimeName, "Alice")
        XCTAssertEqual(model.systemInfo?.uptimeText, "1h 1m 1s")
        XCTAssertEqual(model.systemInfo?.resourceRows.map(\.label), ["CPU", "Memory", "Disk"])
        XCTAssertFalse(model.systemInfo?.summaryText.lowercased().contains("clerk") ?? true)
        XCTAssertFalse(model.systemInfo?.summaryText.lowercased().contains("machine-secret") ?? true)
    }

    func testSystemInfoLoadDeduplicatesConcurrentRequests() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        let requestCounter = LockedCounter()
        AppTestURLProtocol.setHandler { req in
            XCTAssertEqual(req.url?.path, "/api/system/info")
            requestCounter.increment()
            Thread.sleep(forTimeInterval: 0.05)
            let json = """
            {
              "version":"1.2.3",
              "runtime":{"handle":"alice","machineId":"machine-secret","runtimeSlot":"primary"},
              "build":{"sha":"abcdef123456","ref":"main","date":"2026-06-08"},
              "uptime":42,
              "resources":{
                "cpuCount":4,
                "loadAverage":[0.5,0.4,0.3],
                "memoryTotalBytes":8589934592,
                "memoryFreeBytes":2147483648,
                "diskTotalBytes":107374182400,
                "diskFreeBytes":53687091200,
                "homeDiskTotalBytes":107374182400,
                "homeDiskFreeBytes":53687091200
              },
              "release":{"version":"1.2.3","channel":"dev"}
            }
            """
            return (appTestHTTPResponse(req.url!, 200), Data(json.utf8))
        }
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in
                GatewayHTTPClient(baseURL: url, tokenProvider: provider, sessionConfiguration: .appTestMocked())
            },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        async let first: Void = model.loadSystemInfo()
        async let second: Void = model.loadSystemInfo()
        _ = await (first, second)

        XCTAssertEqual(requestCounter.value, 1)
        XCTAssertEqual(model.systemInfo?.displayRuntimeName, "Alice")
    }

    func testSystemInfoPairsHomeDiskFieldsBeforeFallingBackToRootDisk() throws {
        let json = """
        {
          "version":"1.2.3",
          "runtime":{"handle":"alice","machineId":"machine-secret","runtimeSlot":"primary"},
          "build":{"sha":"abcdef123456","ref":"main","date":"2026-06-08"},
          "uptime":42,
          "resources":{
            "cpuCount":4,
            "loadAverage":[0.5,0.4,0.3],
            "memoryTotalBytes":8589934592,
            "memoryFreeBytes":2147483648,
            "diskTotalBytes":107374182400,
            "diskFreeBytes":32212254720,
            "homeDiskTotalBytes":53687091200,
            "homeDiskFreeBytes":null
          },
          "release":{"version":"1.2.3","channel":"dev"}
        }
        """
        let info = try JSONDecoder().decode(NativeSystemInfoSummary.self, from: Data(json.utf8))
        let diskRow = try XCTUnwrap(info.resourceRows.first { $0.label == "Disk" })

        XCTAssertEqual(diskRow.value, "70.0 GB")
        XCTAssertEqual(diskRow.detail, "30.0 GB available")
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

    func testFocusingBoardAndHomeTabsKeepsCanonicalPanel() async throws {
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
        model.openHome()
        model.openProject(slug: "main")

        model.focusTab(id: "home")
        model.focusTab(id: "board:main")

        XCTAssertEqual(model.openTabs.first(where: { $0.id == "home" })?.panel, .shell)
        XCTAssertEqual(model.openTabs.first(where: { $0.id == "board:main" })?.panel, .app(slug: "board"))
    }

    func testFocusingHomeTabAfterSettingsRestoresHomeSection() async throws {
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

        model.openHome()
        model.openAppTab(slug: "settings", title: "Settings")
        model.focusTab(id: "home")

        XCTAssertEqual(model.activeTabID, "home")
        XCTAssertEqual(model.section, .home)
        XCTAssertEqual(model.activePanel, .shell)
        XCTAssertNil(model.selectedCard)
        XCTAssertNil(model.terminal)
    }

    func testNativeSettingsSectionSelectionUpdatesActiveSidebarSection() async throws {
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

        XCTAssertEqual(model.nativeSettingsSection, .account)
        model.focusNativeSettingsSection(.editor)

        XCTAssertEqual(model.nativeSettingsSection, .editor)
    }

    func testFocusingBoardTabRestoresSelectedProject() async throws {
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
        model.openHome()
        model.focusTab(id: "board:main")

        XCTAssertEqual(model.section, .board)
        XCTAssertTrue(model.hasSelectedProject)
        XCTAssertEqual(model.projectSlug, "main")
    }

    func testOpenBoardTabKeepsActiveTabAndSectionInSync() async throws {
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
        model.openAppTab(slug: "settings", title: "Settings")
        model.openBoardTab()

        XCTAssertEqual(model.activeTabID, "board:main")
        XCTAssertEqual(model.section, .board)
        XCTAssertEqual(model.activePanel, .app(slug: "board"))
    }

    func testHomeAndBoardTabsCanClose() async throws {
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

        model.openHome()
        model.openProject(slug: "main")
        model.closeTab(id: "home")
        model.closeTab(id: "board:main")

        XCTAssertTrue(model.openTabs.isEmpty)
        XCTAssertNil(model.activeTabID)
        XCTAssertFalse(model.hasSelectedProject)
        XCTAssertNil(model.terminal)
        XCTAssertNil(model.selectedCard)
    }

    func testClosingLastProjectTabClearsProjectSelectionWhenHomeRemains() async throws {
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

        model.openHome()
        model.openProject(slug: "main")
        XCTAssertTrue(model.hasSelectedProject)

        model.closeTab(id: "board:main")

        XCTAssertEqual(model.openTabs.map(\.id), ["home"])
        XCTAssertEqual(model.activeTabID, "home")
        XCTAssertEqual(model.section, .home)
        XCTAssertFalse(model.hasSelectedProject)
        XCTAssertNil(model.selectedCard)
        XCTAssertNil(model.terminal)
    }

    func testFocusingTaskTabAfterSettingsRestoresBoardSection() async throws {
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
        let card = Card(id: "task_login", projectSlug: "main", title: "Fix login", status: .todo, priority: .normal, order: 1, updatedAt: "now")

        model.openProject(slug: "main")
        _ = try? await model.openCard(card)
        model.openAppTab(slug: "settings", title: "Settings")
        model.focusTab(id: "task:main:task_login")

        XCTAssertEqual(model.section, .board)
        XCTAssertEqual(model.activePanel, .terminal)
        XCTAssertEqual(model.selectedCard?.id, "task_login")
        XCTAssertTrue(model.hasSelectedProject)
    }

    func testFocusingSessionTabAfterResourcesRestoresTerminalSection() async throws {
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
        let sessionCard = Card(id: "matrix_session_alpha", projectSlug: "main", title: "matrix_session_alpha", status: .running, priority: .normal, order: 1, linkedSessionId: "matrix_session_alpha", updatedAt: "now")

        _ = try? await model.openCard(sessionCard)
        model.openAppTab(slug: "resources", title: "Resources")
        model.focusTab(id: "session:main:matrix_session_alpha")

        XCTAssertEqual(model.section, .terminal)
        XCTAssertEqual(model.activePanel, .terminal)
        XCTAssertEqual(model.selectedCard?.id, "matrix_session_alpha")
    }

    func testCreateSessionRetriesTwoWordCollisionsBeforeSuffixedFallback() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        let postedNames = LockedStringArray()
        AppTestURLProtocol.setHandler { req in
            if req.url?.path == "/api/terminal/sessions", req.httpMethod == "POST" {
                let name = appTestRequestName(req) ?? ""
                postedNames.append(name)
                if postedNames.values.count <= 3 {
                    return (
                        appTestHTTPResponse(req.url!, 409),
                        Data(#"{"error":{"code":"session_exists","message":"Request failed"}}"#.utf8)
                    )
                }
                return (
                    appTestHTTPResponse(req.url!, 201),
                    Data(#"{"name":"\#(name)"}"#.utf8)
                )
            }
            if req.url?.path == "/api/terminal/sessions" {
                let name = postedNames.last ?? "swift-falcon"
                return (
                    appTestHTTPResponse(req.url!, 200),
                    Data(#"{"sessions":[{"name":"\#(name)","status":"active"}]}"#.utf8)
                )
            }
            return (appTestHTTPResponse(req.url!, 200), Data("{}".utf8))
        }
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in
                GatewayHTTPClient(baseURL: url, tokenProvider: provider, sessionConfiguration: .appTestMocked())
            },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in }
        )

        let loaded = expectation(description: "created session loads")
        var cancellables = Set<AnyCancellable>()
        model.$sessions
            .filter { !$0.isEmpty }
            .sink { _ in loaded.fulfill() }
            .store(in: &cancellables)

        model.createSession()
        await fulfillment(of: [loaded], timeout: 5)

        let names = postedNames.values
        XCTAssertEqual(names.count, 4)
        XCTAssertTrue(names.prefix(3).allSatisfy(isTwoWordShellSessionName))
        XCTAssertTrue(isFallbackShellSessionName(names[3]))
        XCTAssertTrue(model.sessions.map(\.name).contains(names[3]))
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

        let completion = expectation(description: "sign-in completes")
        var cancellables = Set<AnyCancellable>()
        model.$signInCompletionID
            .dropFirst()
            .filter { $0 > 0 }
            .sink { _ in completion.fulfill() }
            .store(in: &cancellables)

        model.beginSignIn(mode: SignInMode.signIn)
        await fulfillment(of: [completion], timeout: 5)

        let token = await principal.token()
        XCTAssertEqual(token, "native-token")
        XCTAssertEqual(model.profile?.handle, "hamed")
        XCTAssertEqual(model.signInCompletionID, 1)
        XCTAssertEqual(model.section, AppSection.home)
        XCTAssertEqual(model.activeTabID, "home")
        XCTAssertEqual(model.openTabs.first?.kind, .home)
        XCTAssertEqual(model.openTabs.first?.panel, .shell)
        XCTAssertFalse(model.hasSelectedProject)
        XCTAssertEqual(openedURL.urls.first?.path, "/auth/device")
        XCTAssertEqual(openedURL.urls.first?.queryValue("mode"), "sign-in")
        XCTAssertEqual(openedURL.urls.first?.queryValue("redirect_uri"), "matrixos://auth?status=approved")
        withExtendedLifetime(cancellables) {}
    }

    func testDesktopSignInPreservesSignedNativeRedirectFromPlatform() async throws {
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
                    verificationUri: "https://app.matrix-os.com/auth/device?user_code=ABCD-EFGH&redirect_uri=matrixos%3A%2F%2Fauth%3Fstatus%3Dapproved&redirect_sig=signed",
                    expiresIn: 2,
                    interval: 1
                ),
                polls: [.pending]
            ),
            openExternalURL: { openedURL.open($0) }
        )

        model.beginSignIn(mode: .signIn)
        try await Task.sleep(nanoseconds: 150_000_000)
        model.cancelSignIn()

        XCTAssertEqual(openedURL.urls.first?.path, "/auth/device")
        XCTAssertEqual(openedURL.urls.first?.queryValue("redirect_uri"), "matrixos://auth?status=approved")
        XCTAssertEqual(openedURL.urls.first?.queryValue("redirect_sig"), "signed")
        XCTAssertEqual(openedURL.urls.first?.queryValue("mode"), "sign-in")
    }

    func testSignOutClearsAccountAndReturnsToOnboarding() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        try await principal.setToken("token")
        var cancelCount = 0
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: ConnectionProfile(handle: "alice", gatewayHost: "app.matrix-os.com"),
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(),
            openExternalURL: { _ in },
            cancelExternalAuth: { cancelCount += 1 }
        )
        model.openHome()
        model.openProject(slug: "main")

        await model.signOutNow()

        let token = await principal.token()
        XCTAssertNil(token)
        XCTAssertNil(model.profile)
        XCTAssertEqual(model.phase, .needsProfile)
        XCTAssertTrue(model.openTabs.isEmpty)
        XCTAssertFalse(model.hasSelectedProject)
        XCTAssertNil(model.selectedCard)
        XCTAssertNil(model.terminal)
        XCTAssertEqual(model.workspaceSearchQuery, "")
        XCTAssertEqual(cancelCount, 1)
    }

    func testTabKeyboardNavigationAndCloseActiveTab() async throws {
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
        model.openHome()
        model.openProject(slug: "main")
        model.openAppTab(slug: "settings", title: "Settings")

        model.focusPreviousTab()
        XCTAssertEqual(model.activeTabID, "board:main")

        model.focusNextTab()
        XCTAssertEqual(model.activeTabID, "settings")

        model.closeActiveTab()
        XCTAssertFalse(model.openTabs.contains(where: { $0.id == "settings" }))
        XCTAssertNotEqual(model.activeTabID, "settings")
    }

    func testClosingLastSettingsTabResetsStaleSection() async throws {
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

        model.openAppTab(slug: "settings", title: "Settings")
        model.closeTab(id: "settings")

        XCTAssertNil(model.activeTabID)
        XCTAssertEqual(model.section, .board)
    }

    func testCancellingSignInDoesNotMarkCompletion() async throws {
        let principal = PrincipalProvider(store: MemoryTokenStore())
        var cancelCount = 0
        let model = AppModel(
            principal: principal,
            projectSlug: "main",
            profile: nil,
            makeClient: { url, provider in GatewayHTTPClient(baseURL: url, tokenProvider: provider) },
            makeLoader: { _ in EmptyBoardLoader() },
            deviceAuth: MockDeviceAuthorizer(
                start: try makeDeviceAuthStart(
                    deviceCode: "device-1",
                    userCode: "ABD-EFGH",
                    verificationUri: "https://app.matrix-os.com/auth/device",
                    expiresIn: 600,
                    interval: 1
                ),
                polls: [.pending]
            ),
            cancelExternalAuth: { cancelCount += 1 }
        )

        model.beginSignIn(mode: .signIn)
        model.cancelSignIn()

        let token = await principal.token()
        XCTAssertEqual(model.signIn, .idle)
        XCTAssertEqual(model.signInCompletionID, 0)
        XCTAssertNil(token)
        XCTAssertEqual(cancelCount, 1)
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

private struct StaticBoardLoader: BoardLoading {
    let cards: [Card]

    func fetchTasks(projectSlug: String) async throws -> [Card] {
        cards.filter { $0.projectSlug == projectSlug }
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

private extension URL {
    func queryValue(_ name: String) -> String? {
        URLComponents(url: self, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == name })?
            .value
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

private final class AppTestURLProtocol: URLProtocol {
    struct Stub: @unchecked Sendable {
        let handler: (URLRequest) throws -> (HTTPURLResponse, Data)
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var stub: Stub?

    static func setHandler(_ handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) {
        lock.lock(); defer { lock.unlock() }
        stub = Stub(handler: handler)
    }

    private static func currentStub() -> Stub? {
        lock.lock(); defer { lock.unlock() }
        return stub
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let stub = Self.currentStub() else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        do {
            let (response, data) = try stub.handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }
}

private final class LockedStringArray: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var values: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    var last: String? {
        lock.lock()
        defer { lock.unlock() }
        return storage.last
    }

    func append(_ value: String) {
        lock.lock()
        storage.append(value)
        lock.unlock()
    }
}

private extension URLSessionConfiguration {
    static func appTestMocked() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppTestURLProtocol.self]
        return config
    }
}

private func appTestHTTPResponse(_ url: URL, _ status: Int) -> HTTPURLResponse {
    HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
}

private func appTestRequestName(_ request: URLRequest) -> String? {
    guard let data = appTestRequestBodyData(request),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    return json["name"] as? String
}

private func appTestRequestBodyData(_ request: URLRequest) -> Data? {
    if let body = request.httpBody {
        return body
    }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count > 0 {
            data.append(buffer, count: count)
        } else {
            break
        }
    }
    return data
}

private func isTwoWordShellSessionName(_ name: String) -> Bool {
    let parts = name.split(separator: "-")
    return parts.count == 2 && parts.allSatisfy(isLowercaseWord)
}

private func isFallbackShellSessionName(_ name: String) -> Bool {
    let parts = name.split(separator: "-")
    guard parts.count == 3 else { return false }
    return isLowercaseWord(parts[0]) &&
        isLowercaseWord(parts[1]) &&
        parts[2].count == 5 &&
        parts[2].unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
        }
}

private func isLowercaseWord(_ value: Substring) -> Bool {
    !value.isEmpty && value.unicodeScalars.allSatisfy { scalar in
        scalar.value >= 97 && scalar.value <= 122
    }
}
#endif
