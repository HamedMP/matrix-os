import Foundation

/// Live state of a session as reported by the session orchestrator / zellij registry.
public enum SessionStatus: String, Codable, Sendable, CaseIterable {
    case active
    case exited
}

/// Client reference to a server-side session. Value type, never persisted.
public struct SessionRef: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public var status: SessionStatus
    public var cwd: String?
    public var layoutName: String?
    public var tabs: [String]

    public init(
        id: String,
        status: SessionStatus,
        cwd: String? = nil,
        layoutName: String? = nil,
        tabs: [String] = []
    ) {
        self.id = id
        self.status = status
        self.cwd = cwd
        self.layoutName = layoutName
        self.tabs = tabs
    }
}
