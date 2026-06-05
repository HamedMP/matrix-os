import XCTest
@testable import MatrixModel

final class SessionRefTests: XCTestCase {
    func testSessionRefDecodes() throws {
        let json = """
        {
            "id": "sess_live1",
            "status": "active",
            "cwd": "/home/matrix/projects/x",
            "layoutName": "dev",
            "tabs": ["editor", "logs"]
        }
        """
        let ref = try JSONDecoder().decode(SessionRef.self, from: Data(json.utf8))
        XCTAssertEqual(ref.id, "sess_live1")
        XCTAssertEqual(ref.status, .active)
        XCTAssertEqual(ref.cwd, "/home/matrix/projects/x")
        XCTAssertEqual(ref.layoutName, "dev")
        XCTAssertEqual(ref.tabs, ["editor", "logs"])
    }

    func testSessionStatusDecodesActiveAndExited() throws {
        XCTAssertEqual(
            try JSONDecoder().decode(SessionStatus.self, from: Data("\"active\"".utf8)),
            .active
        )
        XCTAssertEqual(
            try JSONDecoder().decode(SessionStatus.self, from: Data("\"exited\"".utf8)),
            .exited
        )
    }

    func testSessionRefRoundTrips() throws {
        let ref = SessionRef(id: "sess_a", status: .exited, cwd: nil, layoutName: nil, tabs: [])
        let data = try JSONEncoder().encode(ref)
        XCTAssertEqual(try JSONDecoder().decode(SessionRef.self, from: data), ref)
    }
}

final class PanelTests: XCTestCase {
    func testPanelEquality() {
        XCTAssertEqual(Panel.terminal, Panel.terminal)
        XCTAssertEqual(Panel.shell, Panel.shell)
        XCTAssertEqual(Panel.app(slug: "notes"), Panel.app(slug: "notes"))
        XCTAssertNotEqual(Panel.app(slug: "notes"), Panel.app(slug: "mail"))
        XCTAssertNotEqual(Panel.terminal, Panel.shell)
    }
}
