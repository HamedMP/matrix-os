// MatrixBoard — zellij sessions as board cards.
//
// The user's original intent ("use the zellij sessions we have for the kanban
// tasks") + the common reality that a fresh VPS has live sessions but no tasks.
// This loader GETs `/api/sessions` (contracts/gateway-endpoints.md) and renders
// each live zellij session as a card whose `linkedSessionId` opens its terminal.
// `projectSlug` is ignored — sessions are not project-scoped.
import Foundation
import MatrixModel
import MatrixNet

/// Gateway sessions list response: `{ sessions: [...] }`.
private struct SessionListEnvelope: Decodable {
    let sessions: [SessionDTO]
}

/// One zellij session as returned by `GET /api/sessions`.
private struct SessionDTO: Decodable {
    let name: String
    let status: String
    let updatedAt: String?

    private enum CodingKeys: String, CodingKey {
        case name, id, sessionId, terminalSessionId, status, state, runtime, updatedAt, lastActivityAt
    }

    private enum RuntimeKeys: String, CodingKey {
        case status, zellijSession
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let runtime = try? container.nestedContainer(keyedBy: RuntimeKeys.self, forKey: .runtime)
        name = try container.decodeIfPresent(String.self, forKey: .name)
            ?? runtime?.decodeIfPresent(String.self, forKey: .zellijSession)
            ?? container.decodeIfPresent(String.self, forKey: .sessionId)
            ?? container.decodeIfPresent(String.self, forKey: .terminalSessionId)
            ?? container.decode(String.self, forKey: .id)
        status = try container.decodeIfPresent(String.self, forKey: .status)
            ?? container.decodeIfPresent(String.self, forKey: .state)
            ?? runtime?.decodeIfPresent(String.self, forKey: .status)
            ?? "active"
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
            ?? container.decodeIfPresent(String.self, forKey: .lastActivityAt)
    }

    func toCard(order: Double) -> Card {
        let active = ["active", "running", "attached", "ready", "idle", "waiting"].contains(status.lowercased())
        return Card(
            id: name,
            projectSlug: "",
            title: name,
            status: active ? .running : .complete,
            priority: .normal,
            order: order,
            linkedSessionId: name,
            updatedAt: updatedAt ?? "",
            revision: nil
        )
    }
}

/// A `BoardLoading` that renders live zellij sessions as cards. Active sessions
/// land in RUNNING; exited ones in COMPLETE. Opening a card attaches its terminal.
public struct SessionsBoardLoader: BoardLoading {
    private let client: GatewayHTTPClient

    public init(client: GatewayHTTPClient) {
        self.client = client
    }

    public func fetchTasks(projectSlug: String) async throws -> [Card] {
        let envelope: SessionListEnvelope = try await client.get("/api/sessions")
        return envelope.sessions.enumerated().map { index, session in
            session.toCard(order: Double(index))
        }
    }
}
