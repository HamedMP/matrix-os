// MatrixBoard — board data source abstraction.
//
// `BoardLoading` decouples `BoardStore` from the concrete HTTP client so tests
// can inject a mock. The production adapter `GatewayBoardLoader` GETs
// `/api/projects/:slug/tasks` (contracts/gateway-endpoints.md), decodes the
// `{ tasks, nextCursor }` envelope into `[GatewayTaskDTO]`, and maps to `[Card]`.
import Foundation
import MatrixModel
import MatrixNet

/// Loads the read-only board snapshot for a project. US1 is REST-only
/// (research.md C2: poll `GET /api/projects/:slug/tasks`; no events WS yet).
public protocol BoardLoading: Sendable {
    func fetchTasks(projectSlug: String) async throws -> [Card]
}

/// Gateway list-tasks response envelope: `{ tasks, nextCursor }`. We only need
/// the first page for the read-only board; pagination lands with mutations (US2).
private struct TaskListEnvelope: Decodable {
    let tasks: [GatewayTaskDTO]
}

/// Production `BoardLoading` backed by the shared `GatewayHTTPClient`.
public struct GatewayBoardLoader: BoardLoading {
    private let client: GatewayHTTPClient

    public init(client: GatewayHTTPClient) {
        self.client = client
    }

    public func fetchTasks(projectSlug: String) async throws -> [Card] {
        // `projectSlug` is owner-controlled and constrained server-side; it is
        // only ever a path segment of a fixed route here.
        let envelope: TaskListEnvelope = try await client.get(
            "/api/projects/\(projectSlug)/tasks"
        )
        return envelope.tasks.map { $0.toCard() }
    }
}
