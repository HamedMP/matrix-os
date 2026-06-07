// MatrixNet — gateway/platform error model.
//
// Every networking failure is mapped to one of these GENERIC cases. Raw server
// bodies, provider names, Postgres/Twilio/filesystem text, and transport detail
// are NEVER surfaced (FR-023, CLAUDE.md "never expose provider names or raw
// error messages to clients"). The real cause is logged at the call site; the
// UI only ever sees `userMessage`.
import Foundation

public enum GatewayError: Error, Equatable, Sendable {
    /// 401 — principal token is missing/invalid/expired. Caller should re-auth.
    case unauthorized
    /// 404 — the requested resource does not exist.
    case notFound
    /// 5xx or any unexpected non-2xx status. Generic server-side failure.
    case server
    /// Transport-level connectivity failure (host unreachable, offline, TLS, ...).
    case network
    /// Request exceeded its bounded timeout.
    case timeout
    /// Response body could not be decoded into the expected type.
    case decoding
    /// Local misconfiguration (e.g. no VPS resolved / empty host) — distinct from
    /// not-found and from transient connectivity.
    case misconfigured

    /// Safe, generic, user-facing copy. Contains no server/provider/path detail.
    public var userMessage: String {
        switch self {
        case .unauthorized: return "Your session has expired. Please sign in again."
        case .notFound: return "That item could not be found."
        case .server: return "Something went wrong. Please try again."
        case .network: return "Can't reach Matrix OS. Check your connection."
        case .timeout: return "The request timed out. Please try again."
        case .decoding: return "Received an unexpected response. Please try again."
        case .misconfigured: return "No computer is connected. Select a runtime to continue."
        }
    }

    /// Maps an HTTP status code to a generic error. 2xx returns nil (success).
    static func from(statusCode: Int) -> GatewayError? {
        switch statusCode {
        case 200..<300: return nil
        case 401: return .unauthorized
        case 404: return .notFound
        default: return .server
        }
    }

    /// Maps a transport error (typically URLError) to a generic case.
    static func from(transport error: Error) -> GatewayError {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut: return .timeout
            default: return .network
            }
        }
        return .network
    }
}
