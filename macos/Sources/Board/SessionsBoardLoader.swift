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

    func toCard(id: String, order: Double) -> Card {
        let active = status == "active"
        return Card(
            id: id,
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
        var seenIDs: [String: Int] = [:]
        return envelope.sessions.enumerated().map { index, session in
            let baseID = "session:\(session.name)"
            let count = seenIDs[baseID, default: 0]
            seenIDs[baseID] = count + 1
            let cardID = count == 0 ? baseID : "\(baseID):\(count + 1)"
            return session.toCard(id: cardID, order: Double(index))
        }
    }
}
