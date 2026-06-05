import Foundation

/// Kanban column / lifecycle state of a task. Mirrors the gateway
/// `task-manager` `CreateTaskSchema.status` enum exactly.
public enum TaskStatus: String, Codable, Sendable, CaseIterable {
    case todo
    case running
    case waiting
    case blocked
    case complete
    case archived
}

/// Task priority. Mirrors the gateway `task-manager` `priority` enum.
public enum TaskPriority: String, Codable, Sendable, CaseIterable {
    case low
    case normal
    case high
    case urgent
}

/// Client view model mapping a gateway task 1:1. Value type, never persisted —
/// diff-updated in memory from workspace events. `column` is the kanban column
/// (== `status`); `isLive` derives the live badge from a running session.
public struct Card: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let projectSlug: String
    public var title: String
    public var description: String?
    public var status: TaskStatus
    public var priority: TaskPriority
    public var order: Double
    public var parentTaskId: String?
    public var linkedSessionId: String?
    public var linkedWorktreeId: String?
    public var previewIds: [String]
    public var tags: [String]
    public var updatedAt: String
    /// Optimistic-concurrency revision from the server, when present.
    public var revision: Int?

    public init(
        id: String,
        projectSlug: String,
        title: String,
        description: String? = nil,
        status: TaskStatus,
        priority: TaskPriority,
        order: Double,
        parentTaskId: String? = nil,
        linkedSessionId: String? = nil,
        linkedWorktreeId: String? = nil,
        previewIds: [String] = [],
        tags: [String] = [],
        updatedAt: String,
        revision: Int? = nil
    ) {
        self.id = id
        self.projectSlug = projectSlug
        self.title = title
        self.description = description
        self.status = status
        self.priority = priority
        self.order = order
        self.parentTaskId = parentTaskId
        self.linkedSessionId = linkedSessionId
        self.linkedWorktreeId = linkedWorktreeId
        self.previewIds = previewIds
        self.tags = tags
        self.updatedAt = updatedAt
        self.revision = revision
    }

    /// Kanban column this card belongs to. Column == `status`.
    public var column: TaskStatus { status }

    /// Live badge: true only while the linked session is actively running.
    /// Never stored as truth — derived from status (and session state upstream).
    public var isLive: Bool { status == .running }
}
