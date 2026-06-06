#if os(macOS)
import XCTest
@testable import MatrixOS
import MatrixBoard
import MatrixModel
import MatrixNet

@MainActor
final class AppModelAuthTests: XCTestCase {
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

private struct MockDeviceAuthorizer: DeviceAuthorizing {
    func startDeviceAuth() async throws -> DeviceAuthStart {
        throw GatewayError.server
    }

    func pollForToken(deviceCode: String) async throws -> DevicePollResult {
        .pending
    }
}
#endif
