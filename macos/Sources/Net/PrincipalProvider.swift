// MatrixNet — current principal token holder.
//
// Loads the principal/device-auth token from a TokenStoring backend (Keychain in
// production), caches it in memory, and exposes it to the GatewayHTTPClient via
// TokenProviding. Supports clear-on-signout. Implemented as an actor so the
// cached token is mutated under strict Swift 6 concurrency safely.
import Foundation

public actor PrincipalProvider: TokenProviding {
    /// Keychain account key for the principal token.
    public static let tokenKey = "principal-token"

    private let store: any TokenStoring
    private var cached: String?

    /// Creates the provider and eagerly loads any persisted token.
    public init(store: any TokenStoring) {
        self.store = store
        // Best-effort warm load; a Keychain failure leaves us signed-out rather
        // than crashing. The error is intentionally swallowed here because a
        // missing/locked Keychain is a valid "no token" state at startup.
        self.cached = try? store.get(key: Self.tokenKey)
    }

    public func token() -> String? { cached }

    /// Persists and caches a freshly issued token (after device auth).
    public func setToken(_ token: String) throws {
        try store.set(key: Self.tokenKey, value: token)
        cached = token
    }

    /// Clears the token on sign-out, from both cache and durable store.
    public func clear() throws {
        try store.delete(key: Self.tokenKey)
        cached = nil
    }
}
