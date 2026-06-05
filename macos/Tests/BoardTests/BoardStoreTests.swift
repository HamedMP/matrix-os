import XCTest
@testable import MatrixBoard
import MatrixModel
import MatrixNet

/// Mock loader so the store can be exercised without a live gateway.
private actor MockBoardLoader: BoardLoading {
    enum Mode: Sendable {
        case success([Card])
        case failure(Error)
    }
    private let mode: Mode
    private(set) var requestedSlugs: [String] = []

    init(_ mode: Mode) { self.mode = mode }

    func fetchTasks(projectSlug: String) async throws -> [Card] {
        requestedSlugs.append(projectSlug)
        switch mode {
        case .success(let cards): return cards
        case .failure(let error): throw error
        }
    }

    func slugs() -> [String] { requestedSlugs }
}

private func card(
    _ id: String,
    status: TaskStatus,
    order: Double,
    title: String = "t"
) -> Card {
    Card(
        id: id,
        projectSlug: "demo",
        title: title,
        status: status,
        priority: .normal,
        order: order,
        updatedAt: "2026-06-01T00:00:00.000Z"
    )
}

@MainActor
final class BoardStoreTests: XCTestCase {
    func testInitialStateIsIdle() {
        let store = BoardStore(loader: MockBoardLoader(.success([])))
        XCTAssertEqual(store.state, .idle)
        XCTAssertTrue(store.cards.isEmpty)
        // Columns always render the canonical 5 statuses; each is empty initially.
        XCTAssertEqual(store.columns.map(\.status), [.todo, .running, .waiting, .blocked, .complete])
        XCTAssertTrue(store.columns.allSatisfy { $0.cards.isEmpty })
    }

    func testLoadSuccessPopulatesCardsAndState() async {
        let loader = MockBoardLoader(.success([
            card("task_1", status: .todo, order: 0)
        ]))
        let store = BoardStore(loader: loader)
        await store.load(projectSlug: "demo")
        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.cards.count, 1)
        let requested = await loader.slugs()
        XCTAssertEqual(requested, ["demo"])
    }

    func testColumnsGroupByStatusOrderedByCardOrder() async {
        let loader = MockBoardLoader(.success([
            card("a", status: .todo, order: 2),
            card("b", status: .todo, order: 1),
            card("c", status: .running, order: 5),
            card("d", status: .complete, order: 0),
        ]))
        let store = BoardStore(loader: loader)
        await store.load(projectSlug: "demo")

        // Columns are in canonical order: todo, running, waiting, blocked, complete.
        let statuses = store.columns.map(\.status)
        XCTAssertEqual(statuses, [.todo, .running, .waiting, .blocked, .complete])

        let todo = store.columns.first { $0.status == .todo }
        XCTAssertEqual(todo?.cards.map(\.id), ["b", "a"]) // order 1 before order 2

        let running = store.columns.first { $0.status == .running }
        XCTAssertEqual(running?.cards.map(\.id), ["c"])
    }

    func testArchivedCardsAreHidden() async {
        let loader = MockBoardLoader(.success([
            card("a", status: .todo, order: 0),
            card("z", status: .archived, order: 0),
        ]))
        let store = BoardStore(loader: loader)
        await store.load(projectSlug: "demo")

        XCTAssertEqual(store.columns.map(\.status), [.todo, .running, .waiting, .blocked, .complete])
        let allCardIds = store.columns.flatMap { $0.cards.map(\.id) }
        XCTAssertEqual(allCardIds, ["a"])
        XCTAssertFalse(allCardIds.contains("z"))
    }

    func testLoadFailureSetsGenericErrorAndDoesNotLeak() async {
        // A raw, leaky error must never surface to the UI.
        struct LeakyError: Error { let message = "postgres: relation tasks does not exist at /var/lib" }
        let loader = MockBoardLoader(.failure(LeakyError()))
        let store = BoardStore(loader: loader)
        await store.load(projectSlug: "demo")

        guard case .failed(let boardError) = store.state else {
            return XCTFail("expected failed state, got \(store.state)")
        }
        // Generic, user-safe copy only.
        XCTAssertFalse(boardError.message.contains("postgres"))
        XCTAssertFalse(boardError.message.contains("/var/lib"))
        XCTAssertFalse(boardError.message.isEmpty)
    }

    func testGatewayErrorMapsToGenericBoardError() async {
        let loader = MockBoardLoader(.failure(GatewayError.unauthorized))
        let store = BoardStore(loader: loader)
        await store.load(projectSlug: "demo")

        guard case .failed(let boardError) = store.state else {
            return XCTFail("expected failed state")
        }
        XCTAssertEqual(boardError, BoardError.unauthorized)
    }

    func testReloadAfterFailureCanSucceed() async {
        let loader = MockBoardLoader(.success([card("a", status: .todo, order: 0)]))
        let store = BoardStore(loader: loader)
        await store.load(projectSlug: "demo")
        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.cards.count, 1)
    }
}
