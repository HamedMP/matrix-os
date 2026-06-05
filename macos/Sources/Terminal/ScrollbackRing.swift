import Foundation

/// Bounded scrollback ring buffer for replay/resume bookkeeping (R1).
/// Evicts oldest entries once `capacity` is exceeded.
public struct ScrollbackRing: Sendable {
    public struct Entry: Sendable, Equatable {
        public let seq: Int
        public let data: String
    }

    public let capacity: Int
    private var entries: [Entry] = []

    public init(capacity: Int) {
        precondition(capacity > 0, "ScrollbackRing capacity must be > 0")
        self.capacity = capacity
        entries.reserveCapacity(capacity)
    }

    public var count: Int { entries.count }
    public var oldestSeq: Int? { entries.first?.seq }
    public var newestSeq: Int? { entries.last?.seq }

    public mutating func append(seq: Int, data: String) {
        entries.append(Entry(seq: seq, data: data))
        if entries.count > capacity {
            entries.removeFirst(entries.count - capacity)
        }
    }

    public mutating func clear() {
        entries.removeAll(keepingCapacity: true)
    }
}
