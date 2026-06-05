// MatrixNet — gateway endpoint + WebSocket URL resolution.
//
// Per research.md C4, the macOS client never addresses a VPS IP directly. It
// always talks to the platform app domain (e.g. app.matrix-os.com); the platform
// reverse-proxies to the user's VPS, selecting the machine by Clerk identity +
// `runtimeSlot`. Multi-VM selection is expressed as `?runtime=<slot>` on requests
// (default slot is `primary`, expressed here as `nil` -> no query param).
import Foundation

public enum VPSResolver {
    /// Builds the gateway base URL `https://<gatewayHost>[?runtime=<slot>]`.
    /// `runtimeSlot == nil` (or "primary") omits the query param.
    public static func gatewayBaseURL(gatewayHost: String, runtimeSlot: String?) throws -> URL {
        let host = gatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { throw GatewayError.misconfigured }

        var comps = URLComponents()
        comps.scheme = "https"
        comps.host = host
        if let slot = normalizedSlot(runtimeSlot) {
            comps.queryItems = [URLQueryItem(name: "runtime", value: slot)]
        }
        guard let url = comps.url else { throw GatewayError.misconfigured }
        return url
    }

    /// Builds a shell/board WebSocket URL `wss://<host><path>?session=&fromSeq=&runtime=`.
    /// `fromSeq` is omitted when nil (initial attach / live tail).
    public static func webSocketURL(
        gatewayHost: String,
        runtimeSlot: String?,
        path: String,
        session: String,
        fromSeq: Int?
    ) throws -> URL {
        let host = gatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { throw GatewayError.misconfigured }

        var comps = URLComponents()
        comps.scheme = "wss"
        comps.host = host
        comps.path = path
        var items = [URLQueryItem(name: "session", value: session)]
        if let fromSeq {
            items.append(URLQueryItem(name: "fromSeq", value: String(fromSeq)))
        }
        if let slot = normalizedSlot(runtimeSlot) {
            items.append(URLQueryItem(name: "runtime", value: slot))
        }
        comps.queryItems = items
        guard let url = comps.url else { throw GatewayError.misconfigured }
        return url
    }

    /// Auto-create terminal URL: `/ws/terminal[?cwd=...]` (no session param) so the
    /// gateway creates a new zellij session and attaches. Used when a card has no
    /// linked session yet (matrix-shell connect-or-create semantics).
    public static func autoCreateTerminalURL(
        gatewayHost: String,
        runtimeSlot: String?,
        cwd: String?
    ) throws -> URL {
        let host = gatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { throw GatewayError.misconfigured }
        var comps = URLComponents()
        comps.scheme = "wss"
        comps.host = host
        comps.path = "/ws/terminal"
        var items: [URLQueryItem] = []
        if let cwd, !cwd.isEmpty { items.append(URLQueryItem(name: "cwd", value: cwd)) }
        if let slot = normalizedSlot(runtimeSlot) { items.append(URLQueryItem(name: "runtime", value: slot)) }
        comps.queryItems = items.isEmpty ? nil : items
        guard let url = comps.url else { throw GatewayError.misconfigured }
        return url
    }

    /// "primary" and empty/whitespace are treated as the default slot (no param).
    private static func normalizedSlot(_ slot: String?) -> String? {
        guard let raw = slot?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty, raw != "primary" else {
            return nil
        }
        return raw
    }
}

/// Client-only connection profile (Keychain-backed credentials elsewhere).
/// Holds the primitives needed to resolve gateway/WS URLs for one selected VPS.
public struct ConnectionProfile: Equatable, Sendable {
    public let handle: String
    public let gatewayHost: String
    public let runtimeSlot: String?

    public init(handle: String, gatewayHost: String, runtimeSlot: String? = nil) {
        self.handle = handle
        self.gatewayHost = gatewayHost
        self.runtimeSlot = runtimeSlot
    }

    public func gatewayBaseURL() throws -> URL {
        try VPSResolver.gatewayBaseURL(gatewayHost: gatewayHost, runtimeSlot: runtimeSlot)
    }

    public func webSocketURL(path: String, session: String, fromSeq: Int?) throws -> URL {
        try VPSResolver.webSocketURL(
            gatewayHost: gatewayHost,
            runtimeSlot: runtimeSlot,
            path: path,
            session: session,
            fromSeq: fromSeq
        )
    }

    public func autoCreateTerminalURL(cwd: String?) throws -> URL {
        try VPSResolver.autoCreateTerminalURL(gatewayHost: gatewayHost, runtimeSlot: runtimeSlot, cwd: cwd)
    }
}
