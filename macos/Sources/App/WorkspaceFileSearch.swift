#if os(macOS)
import Foundation

public struct WorkspaceFileSearchItem: Identifiable, Equatable, Sendable {
    public let path: String
    public let name: String
    public let directory: String
    public let score: Int

    public var id: String { path }

    public init(path: String, query: String = "") {
        self.path = path
        self.name = URL(fileURLWithPath: path).lastPathComponent
        let parts = path.split(separator: "/").map(String.init)
        self.directory = parts.dropLast().joined(separator: "/")
        self.score = Self.score(path: path, name: name, query: query)
    }

    public static func filtered(paths: [String], query: String, limit: Int = 80) -> [WorkspaceFileSearchItem] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let items = paths
            .filter { path in
                guard !normalizedQuery.isEmpty else { return true }
                return path.lowercased().contains(normalizedQuery)
                    || URL(fileURLWithPath: path).lastPathComponent.lowercased().contains(normalizedQuery)
            }
            .map { WorkspaceFileSearchItem(path: $0, query: normalizedQuery) }
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                if lhs.name != rhs.name { return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending }
                return lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
            }
        return Array(items.prefix(limit))
    }

    private static func score(path: String, name: String, query: String) -> Int {
        guard !query.isEmpty else { return 0 }
        let lowerPath = path.lowercased()
        let lowerName = name.lowercased()
        if lowerName == query { return 1000 }
        if lowerName.hasPrefix(query) { return 800 }
        if lowerName.contains(query) { return 600 }
        if lowerPath.hasSuffix(query) { return 500 }
        if lowerPath.contains(query) { return 300 }
        return 0
    }
}
#endif
