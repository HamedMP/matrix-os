import XCTest
@testable import MatrixBoard
import MatrixModel
import MatrixNet

private actor StubLoader: BoardLoading {
    private let result: Result<[Card], Error>

    init(_ result: Result<[Card], Error>) {
        self.result = result
    }

    func fetchTasks(projectSlug: String) async throws -> [Card] {
        try result.get()
    }
}

private func taskCard(
    id: String,
    linkedSessionId: String? = nil,
    order: Double = 0
) -> Card {
    Card(
        id: id,
        projectSlug: "demo",
        title: id,
        status: .todo,
        priority: .normal,
        order: order,
        linkedSessionId: linkedSessionId,
        updatedAt: "2026-06-01T00:00:00.000Z"
    )
}

private func sessionCard(id: String, order: Double = 0) -> Card {
    Card(
        id: id,
        projectSlug: "",
        title: id,
        status: .running,
        priority: .normal,
        order: order,
        linkedSessionId: id,
        updatedAt: "2026-06-01T00:00:00.000Z"
    )
}

final class CompositeBoardLoaderTests: XCTestCase {
    func testMergesTasksWithUnlinkedSessions() async throws {
        let loader = CompositeBoardLoader(
            tasks: StubLoader(.success([
                taskCard(id: "task_1", linkedSessionId: "sess_linked"),
                taskCard(id: "task_2", linkedSessionId: nil),
            ])),
            sessions: StubLoader(.success([
                sessionCard(id: "sess_linked"),
                sessionCard(id: "sess_unlinked"),
            ]))
        )

        let cards = try await loader.fetchTasks(projectSlug: "demo")

        XCTAssertEqual(cards.map(\.id), ["task_1", "task_2", "sess_unlinked"])
    }

    func testSessionFailurePropagatesForConnectivityState() async {
        let loader = CompositeBoardLoader(
            tasks: StubLoader(.success([taskCard(id: "task_1")])),
            sessions: StubLoader(.failure(GatewayError.timeout))
        )

        do {
            _ = try await loader.fetchTasks(projectSlug: "demo")
            XCTFail("Expected session connectivity failure")
        } catch let error as GatewayError {
            XCTAssertEqual(error, .timeout)
        } catch {
            XCTFail("Expected GatewayError, got \(error)")
        }
    }
}
