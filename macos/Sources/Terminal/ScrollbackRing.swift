import Foundation

/// Bounded scrollback ring buffer for replay/resume bookkeeping (R1).
/// Evicts oldest entries once `capacity` is exceeded.
public struct ScrollbackRing: Sendable {
    public struct Entry: Sendable, Equatable {
        public let seq: Int
        public let data: String
    }

    public let capacity: Int
    private var entries: [Entry?]
    private var startIndex = 0
    private var entryCount = 0

    public init(capacity: Int) {
        precondition(capacity > 0, "ScrollbackRing capacity must be > 0")
        self.capacity = capacity
        self.entries = Array(repeating: nil, count: capacity)
    }

    public var count: Int { entryCount }
    public var oldestSeq: Int? {
        guard entryCount > 0 else { return nil }
        return entries[startIndex]?.seq
    }
    public var newestSeq: Int? {
        guard entryCount > 0 else { return nil }
        let index = (startIndex + entryCount - 1) % capacity
        return entries[index]?.seq
    }

    public mutating func append(seq: Int, data: String) {
        let entry = Entry(seq: seq, data: data)
        if entryCount < capacity {
            let index = (startIndex + entryCount) % capacity
            entries[index] = entry
            entryCount += 1
        } else {
            entries[startIndex] = entry
            startIndex = (startIndex + 1) % capacity
        }
    }

    public mutating func clear() {
        entries = Array(repeating: nil, count: capacity)
        startIndex = 0
        entryCount = 0
    }
}
