import XCTest
@testable import MatrixBoard
import MatrixModel

final class GatewayTaskDTOTests: XCTestCase {
    private func decode(_ json: String) throws -> GatewayTaskDTO {
        try JSONDecoder().decode(GatewayTaskDTO.self, from: Data(json.utf8))
    }

    /// The gateway omits `tags` and `revision` until a server delta ships them.
    /// Decoding must succeed and the mapped Card must default tags == [] / revision == nil.
    func testDecodesTaskWithoutTagsOrRevision() throws {
        let json = """
        {
          "id": "task_abc",
          "projectSlug": "demo",
          "title": "Wire the board",
          "status": "todo",
          "priority": "normal",
          "order": 1.5,
          "previewIds": [],
          "createdAt": "2026-06-01T00:00:00.000Z",
          "updatedAt": "2026-06-01T00:00:00.000Z"
        }
        """
        let dto = try decode(json)
        let card = dto.toCard()
        XCTAssertEqual(card.id, "task_abc")
        XCTAssertEqual(card.projectSlug, "demo")
        XCTAssertEqual(card.title, "Wire the board")
        XCTAssertEqual(card.status, .todo)
        XCTAssertEqual(card.priority, .normal)
        XCTAssertEqual(card.order, 1.5)
        XCTAssertEqual(card.tags, [])
        XCTAssertNil(card.revision)
        XCTAssertEqual(card.updatedAt, "2026-06-01T00:00:00.000Z")
    }

    /// Optional fields present should still map through cleanly.
    func testDecodesTaskWithOptionalFields() throws {
        let json = """
        {
          "id": "task_def",
          "projectSlug": "demo",
          "title": "Run it",
          "description": "long body",
          "status": "running",
          "priority": "high",
          "order": 3,
          "parentTaskId": "task_root",
          "linkedSessionId": "sess_1",
          "linkedWorktreeId": "wt_1",
          "previewIds": ["prev_1", "prev_2"],
          "createdAt": "2026-06-01T00:00:00.000Z",
          "updatedAt": "2026-06-02T00:00:00.000Z"
        }
        """
        let card = try decode(json).toCard()
        XCTAssertEqual(card.description, "long body")
        XCTAssertEqual(card.status, .running)
        XCTAssertEqual(card.priority, .high)
        XCTAssertEqual(card.parentTaskId, "task_root")
        XCTAssertEqual(card.linkedSessionId, "sess_1")
        XCTAssertEqual(card.linkedWorktreeId, "wt_1")
        XCTAssertEqual(card.previewIds, ["prev_1", "prev_2"])
        XCTAssertTrue(card.isLive)
    }

    /// When the server delta eventually adds tags/revision, decode should honor them.
    func testDecodesTagsAndRevisionWhenPresent() throws {
        let json = """
        {
          "id": "task_ghi",
          "projectSlug": "demo",
          "title": "Future",
          "status": "todo",
          "priority": "normal",
          "order": 0,
          "previewIds": [],
          "tags": ["bug", "ui"],
          "revision": 7,
          "createdAt": "2026-06-01T00:00:00.000Z",
          "updatedAt": "2026-06-01T00:00:00.000Z"
        }
        """
        let card = try decode(json).toCard()
        XCTAssertEqual(card.tags, ["bug", "ui"])
        XCTAssertEqual(card.revision, 7)
    }

    /// previewIds omitted should default to [].
    func testDecodesTaskWithoutPreviewIds() throws {
        let json = """
        {
          "id": "task_jkl",
          "projectSlug": "demo",
          "title": "No previews",
          "status": "todo",
          "priority": "normal",
          "order": 0,
          "createdAt": "2026-06-01T00:00:00.000Z",
          "updatedAt": "2026-06-01T00:00:00.000Z"
        }
        """
        let card = try decode(json).toCard()
        XCTAssertEqual(card.previewIds, [])
    }
}
