// MatrixNet — token provider abstraction for the HTTP client.
//
// The GatewayHTTPClient stays decoupled from where the principal token lives.
// In production this is the Keychain-backed PrincipalProvider; in tests it is a
// static provider. `token()` is async so a Keychain read / refresh can be awaited.
import Foundation

public protocol TokenProviding: Sendable {
    /// The current principal bearer token, or nil if signed out.
    func token() async -> String?
}

/// A fixed-token provider, primarily for tests and previews.
public struct StaticTokenProvider: TokenProviding {
    private let value: String?
    public init(token: String?) { self.value = token }
    public func token() async -> String? { value }
}
