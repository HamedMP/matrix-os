import Foundation
import MatrixModel
import MatrixNet

private struct TerminalWorkspacesEnvelope: Decodable {
    let workspaces: [TerminalWorkspaceDTO]
}

private struct TerminalWorkspaceDTO: Decodable {
    let id: String
    let projectId: String?
    let tabs: [TerminalTabDTO]
}

private struct TerminalTabDTO: Decodable {
    let id: String
    let name: String
    let status: String
    let updatedAt: String?
}

private struct ProjectEnvelope: Decodable {
    struct Project: Decodable { let id: String }
    let project: Project
}

public struct SessionsBoardLoader: BoardLoading {
    private let client: GatewayHTTPClient

    public init(client: GatewayHTTPClient) {
        self.client = client
    }

    public func fetchTasks(projectSlug: String) async throws -> [Card] {
        let project: ProjectEnvelope = try await client.get("/api/projects/\(projectSlug)")
        let envelope: TerminalWorkspacesEnvelope = try await client.get("/api/terminal/workspaces")
        let tabs = envelope.workspaces
            .filter { $0.projectId == project.project.id }
            .flatMap { workspace in workspace.tabs.map { (workspace.id, $0) } }
        return tabs.enumerated().map { index, entry in
            let (workspaceId, tab) = entry
            let active = ["active", "running", "starting", "idle", "waiting"].contains(tab.status.lowercased())
            return Card(
                id: "terminal:\(workspaceId):\(tab.id)",
                projectSlug: projectSlug,
                title: tab.name,
                status: active ? .running : .complete,
                priority: .normal,
                order: Double(index),
                linkedSessionId: "\(workspaceId):\(tab.id)",
                updatedAt: tab.updatedAt ?? "",
                revision: nil
            )
        }
    }
}
