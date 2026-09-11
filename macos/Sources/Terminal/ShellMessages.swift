import Foundation

public let SHELL_ATTACH_LIVE_TAIL_FROM_SEQ: Int = 9_007_199_254_740_991
public let SHELL_ATTACH_RECENT_REPLAY_EVENTS: Int = 50

public struct TerminalRef: Codable, Sendable, Equatable {
    public let workspaceId: String
    public let tabId: String

    private enum CodingKeys: String, CodingKey { case workspaceId, tabId }

    private static func isValid(_ value: String, prefix: String) -> Bool {
        value.range(of: "^\(prefix)_[0-9a-f]{32}$", options: .regularExpression) != nil
    }

    public init?(key: String) {
        let pieces = key.split(separator: ":", omittingEmptySubsequences: false)
        guard pieces.count == 2,
              Self.isValid(String(pieces[0]), prefix: "tws"),
              Self.isValid(String(pieces[1]), prefix: "tt") else { return nil }
        workspaceId = String(pieces[0])
        tabId = String(pieces[1])
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let workspaceId = try container.decode(String.self, forKey: .workspaceId)
        let tabId = try container.decode(String.self, forKey: .tabId)
        guard Self.isValid(workspaceId, prefix: "tws"), Self.isValid(tabId, prefix: "tt") else {
            throw DecodingError.dataCorruptedError(
                forKey: .workspaceId,
                in: container,
                debugDescription: "Invalid terminal reference"
            )
        }
        self.workspaceId = workspaceId
        self.tabId = tabId
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(workspaceId, forKey: .workspaceId)
        try container.encode(tabId, forKey: .tabId)
    }
}

public struct TerminalGridSize: Codable, Sendable, Equatable {
    public let cols: Int
    public let rows: Int
}

public struct TerminalViewport: Codable, Sendable, Equatable {
    public let top: Int
    public let rows: Int
}

public enum ClientMessage: Sendable, Equatable {
    case input(ref: TerminalRef, data: String)
    case resize(ref: TerminalRef, cols: Int, rows: Int)
    case detach(ref: TerminalRef)
    case ping(ref: TerminalRef)
}

extension ClientMessage: Encodable {
    private enum CodingKeys: String, CodingKey { case type, terminalRef, data, mode, size }
    private struct Size: Encodable { let cols: Int; let rows: Int }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .input(ref, data):
            try container.encode("input", forKey: .type)
            try container.encode(ref, forKey: .terminalRef)
            try container.encode(data, forKey: .data)
        case let .resize(ref, cols, rows):
            try container.encode("resize", forKey: .type)
            try container.encode(ref, forKey: .terminalRef)
            try container.encode("soft", forKey: .mode)
            try container.encode(Size(cols: cols, rows: rows), forKey: .size)
        case let .detach(ref):
            try container.encode("detach", forKey: .type)
            try container.encode(ref, forKey: .terminalRef)
        case let .ping(ref):
            try container.encode("ping", forKey: .type)
            try container.encode(ref, forKey: .terminalRef)
        }
    }
}

public enum ServerMessage: Sendable, Equatable {
    case attached(ref: TerminalRef, canonicalSize: TerminalGridSize, revision: Int, nextSeq: Int)
    case snapshot(ref: TerminalRef, canonicalSize: TerminalGridSize, revision: Int, seq: Int, ansi: String, viewport: TerminalViewport)
    case output(ref: TerminalRef, revision: Int, seq: Int, data: String)
    case exit(ref: TerminalRef, revision: Int, code: Int?)
    case error(ref: TerminalRef?, code: String, message: String)
    case pong(ref: TerminalRef, revision: Int)
    case replayStart(ref: TerminalRef, revision: Int, fromSeq: Int)
    case replayEvicted(ref: TerminalRef, revision: Int, fromSeq: Int, nextSeq: Int)
    case replayGap(ref: TerminalRef, revision: Int, fromSeq: Int, nextSeq: Int)
    case replayEnd(ref: TerminalRef, revision: Int, nextSeq: Int, toSeq: Int?)
    case canonicalSize(ref: TerminalRef, revision: Int, size: TerminalGridSize)
}

extension ServerMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, terminalRef, canonicalSize, revision, nextSeq, fromSeq, toSeq, seq, data, ansi, viewport, exitCode, code, message, error
    }

    private struct SafeError: Decodable { let code: String; let safeMessage: String }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "attached":
            self = .attached(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                canonicalSize: try container.decode(TerminalGridSize.self, forKey: .canonicalSize),
                revision: try container.decode(Int.self, forKey: .revision),
                nextSeq: try container.decodeIfPresent(Int.self, forKey: .nextSeq) ?? 0
            )
        case "snapshot":
            self = .snapshot(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                canonicalSize: try container.decode(TerminalGridSize.self, forKey: .canonicalSize),
                revision: try container.decode(Int.self, forKey: .revision),
                seq: try container.decode(Int.self, forKey: .seq),
                ansi: try container.decode(String.self, forKey: .ansi),
                viewport: try container.decode(TerminalViewport.self, forKey: .viewport)
            )
        case "output":
            self = .output(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                revision: try container.decode(Int.self, forKey: .revision),
                seq: try container.decode(Int.self, forKey: .seq),
                data: try container.decode(String.self, forKey: .data)
            )
        case "exit":
            self = .exit(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                revision: try container.decode(Int.self, forKey: .revision),
                code: try container.decodeIfPresent(Int.self, forKey: .exitCode)
            )
        case "error":
            self = .error(
                ref: try container.decodeIfPresent(TerminalRef.self, forKey: .terminalRef),
                code: try container.decodeIfPresent(String.self, forKey: .code) ?? "terminal_error",
                message: try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            )
        case "safe-error":
            let error = try container.decode(SafeError.self, forKey: .error)
            self = .error(
                ref: try container.decodeIfPresent(TerminalRef.self, forKey: .terminalRef),
                code: error.code,
                message: error.safeMessage
            )
        case "pong":
            self = .pong(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                revision: try container.decode(Int.self, forKey: .revision)
            )
        case "replay-start":
            self = .replayStart(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                revision: try container.decode(Int.self, forKey: .revision),
                fromSeq: try container.decode(Int.self, forKey: .fromSeq)
            )
        case "replay-evicted":
            self = .replayEvicted(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                revision: try container.decode(Int.self, forKey: .revision),
                fromSeq: try container.decode(Int.self, forKey: .fromSeq),
                nextSeq: try container.decode(Int.self, forKey: .nextSeq)
            )
        case "replay-gap":
            self = .replayGap(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                revision: try container.decode(Int.self, forKey: .revision),
                fromSeq: try container.decode(Int.self, forKey: .fromSeq),
                nextSeq: try container.decode(Int.self, forKey: .nextSeq)
            )
        case "replay-end":
            self = .replayEnd(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                revision: try container.decode(Int.self, forKey: .revision),
                nextSeq: try container.decode(Int.self, forKey: .nextSeq),
                toSeq: try container.decodeIfPresent(Int.self, forKey: .toSeq)
            )
        case "canonical-size":
            self = .canonicalSize(
                ref: try container.decode(TerminalRef.self, forKey: .terminalRef),
                revision: try container.decode(Int.self, forKey: .revision),
                size: try container.decode(TerminalGridSize.self, forKey: .canonicalSize)
            )
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown server message type")
        }
    }
}

public enum ServerEvent: Sendable, Equatable {
    case attached(state: String, fromSeq: Int)
    case output(seq: Int, data: String)
    case exit(code: Int)
    case error(code: String, message: String)
    case reconnecting
    case replayEvicted
}
