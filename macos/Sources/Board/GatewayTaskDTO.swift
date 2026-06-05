// MatrixBoard — gateway task wire shape → Card mapping.
//
// The gateway `TaskRecord` (packages/gateway/src/task-manager.ts) does NOT carry
// `tags` or `revision` until a server delta ships them (data-model.md "Server
// delta"). `Card` requires `tags`, so decoding the raw gateway JSON directly
// would fail. This DTO models the wire shape with `tags`/`revision` OPTIONAL and
// maps to `Card` with `tags` defaulting to [] and `revision` to nil. When the
// server delta lands, present values pass straight through.
import Foundation
import MatrixModel

/// Decodable mirror of the gateway task JSON. Tolerates absent `tags`,
/// `revision`, and `previewIds` (gateway omits the first two today).
public struct GatewayTaskDTO: Decodable, Sendable {
    public let id: String
    public let projectSlug: String
    public let title: String
    public let description: String?
    public let status: TaskStatus
    public let priority: TaskPriority
    public let order: Double
    public let parentTaskId: String?
    public let linkedSessionId: String?
    public let linkedWorktreeId: String?
    public let previewIds: [String]?
    public let tags: [String]?
    public let updatedAt: String
    public let revision: Int?

    /// Map the wire shape to the in-memory `Card`, supplying defaults for fields
    /// the gateway omits today (`tags` → [], `revision` → nil).
    public func toCard() -> Card {
        Card(
            id: id,
            projectSlug: projectSlug,
            title: title,
            description: description,
            status: status,
            priority: priority,
            order: order,
            parentTaskId: parentTaskId,
            linkedSessionId: linkedSessionId,
            linkedWorktreeId: linkedWorktreeId,
            previewIds: previewIds ?? [],
            tags: tags ?? [],
            updatedAt: updatedAt,
            revision: revision
        )
    }
}
