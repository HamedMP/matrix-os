import XCTest
@testable import MatrixModel

final class ConnectionProfileTests: XCTestCase {
    func testRuntimeSlotDefaultsToPrimary() {
        let profile = ConnectionProfile(
            handle: "hamed",
            gatewayHost: "app.matrix-os.com",
            credentialRef: "matrixos.token.hamed"
        )
        XCTAssertEqual(profile.runtimeSlot, "primary")
    }

    func testProfileStoresOnlyCredentialReference() {
        // The struct must never carry a raw token — only a Keychain key reference.
        let profile = ConnectionProfile(
            handle: "hamed",
            gatewayHost: "app.matrix-os.com",
            runtimeSlot: "secondary",
            credentialRef: "matrixos.token.hamed"
        )
        XCTAssertEqual(profile.handle, "hamed")
        XCTAssertEqual(profile.gatewayHost, "app.matrix-os.com")
        XCTAssertEqual(profile.runtimeSlot, "secondary")
        XCTAssertEqual(profile.credentialRef, "matrixos.token.hamed")
    }

    func testProfileRoundTrips() throws {
        let profile = ConnectionProfile(
            handle: "hamed",
            gatewayHost: "app.matrix-os.com",
            credentialRef: "matrixos.token.hamed"
        )
        let data = try JSONEncoder().encode(profile)
        XCTAssertEqual(try JSONDecoder().decode(ConnectionProfile.self, from: data), profile)
    }
}
