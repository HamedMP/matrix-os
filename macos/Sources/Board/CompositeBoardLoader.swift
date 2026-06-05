// MatrixBoard — project tasks + live sessions, merged into one board.
//
// Linear/SlayZone-style: the board is task-first (addable cards in lifecycle
// columns). Live zellij sessions that are not already linked to a task are also
// surfaced so in-flight work is visible. Tasks come from the resolved project;
// sessions from `/api/sessions`. Auth/transport failures propagate (via the
// sessions fetch); a missing/empty project (404) is tolerated as "no tasks yet".
import Foundation
import MatrixModel
import MatrixNet

public struct CompositeBoardLoader: BoardLoading {
    private let tasks: GatewayBoardLoader
    private let sessions: SessionsBoardLoader

    public init(client: GatewayHTTPClient) {
        self.tasks = GatewayBoardLoader(client: client)
        self.sessions = SessionsBoardLoader(client: client)
    }

    public func fetchTasks(projectSlug: String) async throws -> [Card] {
        // Sessions fetch is authoritative for connectivity (it always exists);
        // let its errors surface so the app can show reconnecting/auth states.
        let sessionCards = try await sessions.fetchTasks(projectSlug: projectSlug)
        // Tasks are tolerant: a project with no tasks (or a 404 slug) yields none.
        let taskCards = (try? await tasks.fetchTasks(projectSlug: projectSlug)) ?? []

        let linkedSessionIds = Set(taskCards.compactMap { $0.linkedSessionId })
        let unlinkedSessions = sessionCards.filter { !linkedSessionIds.contains($0.id) }
        return taskCards + unlinkedSessions
    }
}
