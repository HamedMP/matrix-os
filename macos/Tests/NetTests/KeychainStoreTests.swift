import XCTest
@testable import MatrixNet

final class KeychainStoreTests: XCTestCase {
    private let service = "com.matrixos.tests.keychain"
    private var store: KeychainStore!
    private let key = "principal-token"

    override func setUp() {
        super.setUp()
        store = KeychainStore(service: service)
        try? store.delete(key: key)
    }

    override func tearDown() {
        try? store.delete(key: key)
        super.tearDown()
    }

    func testStoreAndRetrieveRoundTrips() throws {
        try store.set(key: key, value: "abc123")
        XCTAssertEqual(try store.get(key: key), "abc123")
    }

    func testOverwriteReplacesValue() throws {
        try store.set(key: key, value: "first")
        try store.set(key: key, value: "second")
        XCTAssertEqual(try store.get(key: key), "second")
    }

    func testGetMissingReturnsNil() throws {
        XCTAssertNil(try store.get(key: key))
    }

    func testDeleteRemovesValue() throws {
        try store.set(key: key, value: "to-delete")
        try store.delete(key: key)
        XCTAssertNil(try store.get(key: key))
    }

    func testDeleteMissingDoesNotThrow() throws {
        XCTAssertNoThrow(try store.delete(key: "never-stored"))
    }
}
