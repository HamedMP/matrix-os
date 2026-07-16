// Wire protocol for the shell terminal WebSocket.
// Source of truth: packages/gateway/src/shell/ws.ts (+ @finnaai/matrix/shell-protocol).
import Foundation

/// Sentinel `fromSeq` requesting the live tail (recent replay + live output).
/// Mirrors `SHELL_ATTACH_LIVE_TAIL_FROM_SEQ = Number.MAX_SAFE_INTEGER`.
public let SHELL_ATTACH_LIVE_TAIL_FROM_SEQ: Int = 9_007_199_254_740_991

/// Roughly how many recent events the server replays on a live-tail attach.
public let SHELL_ATTACH_RECENT_REPLAY_EVENTS: Int = 50

/// Client → server messages.
public enum ClientMessage: Sendable, Equatable {
    case input(data: String)
    case resize(cols: Int, rows: Int)
    case detach
    case ping
}

extension ClientMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, data, cols, rows
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .input(data):
            try container.encode("input", forKey: .type)
            try container.encode(data, forKey: .data)
        case let .resize(cols, rows):
            try container.encode("resize", forKey: .type)
            try container.encode(cols, forKey: .cols)
            try container.encode(rows, forKey: .rows)
        case .detach:
            try container.encode("detach", forKey: .type)
        case .ping:
            try container.encode("ping", forKey: .type)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "input":
            self = .input(data: try container.decode(String.self, forKey: .data))
        case "resize":
            self = .resize(
                cols: try container.decode(Int.self, forKey: .cols),
                rows: try container.decode(Int.self, forKey: .rows)
            )
        case "detach":
            self = .detach
        case "ping":
            self = .ping
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown client message type: \(type)"
            )
        }
    }
}

/// Server → client messages.
public enum ServerMessage: Sendable, Equatable {
    case attached(session: String, state: String, fromSeq: Int)
    case output(seq: Int, data: String)
    case exit(code: Int)
    case error(code: String, message: String)
    case pong
    /// Requested seq was older than the buffer; client must clear and re-attach at live tail.
    case replayEvicted(fromSeq: Int, nextSeq: Int)
}

extension ServerMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, session, sessionId, state, fromSeq, nextSeq, seq, data, code, message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "attached":
            let session = try container.decodeIfPresent(String.self, forKey: .session)
                ?? container.decode(String.self, forKey: .sessionId)
            self = .attached(
                session: session,
                state: try container.decodeIfPresent(String.self, forKey: .state) ?? "running",
                fromSeq: try container.decodeIfPresent(Int.self, forKey: .fromSeq) ?? 0
            )
        case "output":
            self = .output(
                seq: try container.decodeIfPresent(Int.self, forKey: .seq) ?? 0,
                data: try container.decode(String.self, forKey: .data)
            )
        case "exit":
            self = .exit(code: try container.decode(Int.self, forKey: .code))
        case "error":
            self = .error(
                code: try container.decodeIfPresent(String.self, forKey: .code) ?? "terminal_error",
                message: try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            )
        case "pong":
            self = .pong
        case "replay-evicted":
            self = .replayEvicted(
                fromSeq: try container.decode(Int.self, forKey: .fromSeq),
                nextSeq: try container.decode(Int.self, forKey: .nextSeq)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown server message type: \(type)"
            )
        }
    }
}

/// Decoded events surfaced to consumers of the client.
public enum ServerEvent: Sendable, Equatable {
    case attached(state: String, fromSeq: Int)
    case output(seq: Int, data: String)
    case exit(code: Int)
    case error(code: String, message: String)
    case reconnecting
    /// Emitted after the client has reset its buffer and re-attached at live tail.
    case replayEvicted
}
