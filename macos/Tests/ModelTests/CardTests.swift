import XCTest
@testable import MatrixModel

final class CardTests: XCTestCase {
    // A representative task payload as emitted by the gateway task-manager.
    private let sampleTaskJSON = """
    {
        "id": "task_abc123",
        "projectSlug": "matrix-os",
        "title": "Wire the board",
        "description": "Hook up kanban columns",
        "status": "running",
        "priority": "high",
        "order": 12.5,
        "parentTaskId": "task_parent1",
        "linkedSessionId": "sess_live1",
        "linkedWorktreeId": "wt_branch1",
        "previewIds": ["prev_one", "prev_two"],
        "tags": ["backend", "urgent-fix"],
        "updatedAt": "2026-06-05T10:00:00.000Z",
        "revision": 7
    }
    """

    func testCardDecodesGatewayTaskJSON() throws {
        let data = Data(sampleTaskJSON.utf8)
        let card = try JSONDecoder().decode(Card.self, from: data)

        XCTAssertEqual(card.id, "task_abc123")
        XCTAssertEqual(card.projectSlug, "matrix-os")
        XCTAssertEqual(card.title, "Wire the board")
        XCTAssertEqual(card.description, "Hook up kanban columns")
        XCTAssertEqual(card.status, .running)
        XCTAssertEqual(card.priority, .high)
        XCTAssertEqual(card.order, 12.5, accuracy: 0.0001)
        XCTAssertEqual(card.parentTaskId, "task_parent1")
        XCTAssertEqual(card.linkedSessionId, "sess_live1")
        XCTAssertEqual(card.linkedWorktreeId, "wt_branch1")
        XCTAssertEqual(card.previewIds, ["prev_one", "prev_two"])
        XCTAssertEqual(card.tags, ["backend", "urgent-fix"])
        XCTAssertEqual(card.updatedAt, "2026-06-05T10:00:00.000Z")
        XCTAssertEqual(card.revision, 7)
    }

    func testCardRoundTripsThroughCodable() throws {
        let data = Data(sampleTaskJSON.utf8)
        let decoded = try JSONDecoder().decode(Card.self, from: data)
        let reencoded = try JSONEncoder().encode(decoded)
        let roundTripped = try JSONDecoder().decode(Card.self, from: reencoded)
        XCTAssertEqual(decoded, roundTripped)
    }

    func testCardDecodesWithMinimalFields() throws {
        let json = """
        {
            "id": "task_min",
            "projectSlug": "p",
            "title": "Bare",
            "status": "todo",
            "priority": "normal",
            "order": 0,
            "previewIds": [],
            "tags": [],
            "updatedAt": "2026-06-05T10:00:00.000Z"
        }
        """
        let card = try JSONDecoder().decode(Card.self, from: Data(json.utf8))
        XCTAssertNil(card.description)
        XCTAssertNil(card.parentTaskId)
        XCTAssertNil(card.linkedSessionId)
        XCTAssertNil(card.linkedWorktreeId)
        XCTAssertNil(card.revision)
        XCTAssertTrue(card.previewIds.isEmpty)
        XCTAssertTrue(card.tags.isEmpty)
    }

    func testIsLiveReflectsRunningStatus() {
        XCTAssertTrue(makeCard(status: .running).isLive)
        for status: TaskStatus in [.todo, .waiting, .blocked, .complete, .archived] {
            XCTAssertFalse(makeCard(status: status).isLive)
        }
    }

    func testColumnEqualsStatus() {
        for status: TaskStatus in TaskStatus.allCases {
            XCTAssertEqual(makeCard(status: status).column, status)
        }
    }

    private func makeCard(status: TaskStatus) -> Card {
        Card(
            id: "task_x",
            projectSlug: "p",
            title: "t",
            status: status,
            priority: .normal,
            order: 0,
            previewIds: [],
            tags: [],
            updatedAt: "2026-06-05T10:00:00.000Z"
        )
    }
}

final class TaskStatusTests: XCTestCase {
    func testStatusDecodesAllKanbanColumns() throws {
        let mapping: [(String, TaskStatus)] = [
            ("todo", .todo),
            ("running", .running),
            ("waiting", .waiting),
            ("blocked", .blocked),
            ("complete", .complete),
            ("archived", .archived),
        ]
        for (raw, expected) in mapping {
            let decoded = try JSONDecoder().decode(TaskStatus.self, from: Data("\"\(raw)\"".utf8))
            XCTAssertEqual(decoded, expected)
            let encoded = try JSONEncoder().encode(expected)
            XCTAssertEqual(String(decoding: encoded, as: UTF8.self), "\"\(raw)\"")
        }
    }

    func testAllCasesCoversSixColumns() {
        XCTAssertEqual(TaskStatus.allCases.count, 6)
    }
}

final class TaskPriorityTests: XCTestCase {
    func testPriorityDecodesAllLevels() throws {
        let mapping: [(String, TaskPriority)] = [
            ("low", .low),
            ("normal", .normal),
            ("high", .high),
            ("urgent", .urgent),
        ]
        for (raw, expected) in mapping {
            let decoded = try JSONDecoder().decode(TaskPriority.self, from: Data("\"\(raw)\"".utf8))
            XCTAssertEqual(decoded, expected)
        }
    }
}
