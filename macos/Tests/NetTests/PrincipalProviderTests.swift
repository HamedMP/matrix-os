import XCTest
@testable import MatrixNet

/// In-memory token store so PrincipalProvider can be tested without the system Keychain.
final class InMemoryTokenStore: TokenStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: String] = [:]

    func get(key: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return storage[key]
    }

    func set(key: String, value: String) throws {
        lock.lock(); defer { lock.unlock() }
        storage[key] = value
    }

    func delete(key: String) throws {
        lock.lock(); defer { lock.unlock() }
        storage.removeValue(forKey: key)
    }
}

final class PrincipalProviderTests: XCTestCase {
    func testLoadsTokenFromStoreOnInit() async throws {
        let backing = InMemoryTokenStore()
        try backing.set(key: PrincipalProvider.tokenKey, value: "stored-token")
        let provider = PrincipalProvider(store: backing)
        let token = await provider.token()
        XCTAssertEqual(token, "stored-token")
    }

    func testStartsNilWhenNothingStored() async {
        let provider = PrincipalProvider(store: InMemoryTokenStore())
        let token = await provider.token()
        XCTAssertNil(token)
    }

    func testSetPersistsAndUpdatesCurrent() async throws {
        let backing = InMemoryTokenStore()
        let provider = PrincipalProvider(store: backing)
        try await provider.setToken("new-token")
        let token = await provider.token()
        XCTAssertEqual(token, "new-token")
        XCTAssertEqual(try backing.get(key: PrincipalProvider.tokenKey), "new-token")
    }

    func testClearOnSignoutRemovesToken() async throws {
        let backing = InMemoryTokenStore()
        let provider = PrincipalProvider(store: backing)
        try await provider.setToken("token")
        try await provider.clear()
        let token = await provider.token()
        XCTAssertNil(token)
        XCTAssertNil(try backing.get(key: PrincipalProvider.tokenKey))
    }

    func testConformsToTokenProvidingForHTTPClient() async throws {
        let backing = InMemoryTokenStore()
        let provider = PrincipalProvider(store: backing)
        try await provider.setToken("bearer-x")
        // TokenProviding is async; HTTP client awaits it per request.
        let token = await (provider as TokenProviding).token()
        XCTAssertEqual(token, "bearer-x")
    }
}
