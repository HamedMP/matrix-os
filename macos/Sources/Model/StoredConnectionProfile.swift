import Foundation

/// Describes how the app connects to a user's gateway runtime.
///
/// SECURITY: this struct holds only a Keychain *reference* (`credentialRef`),
/// never the raw token. The token itself lives in the macOS Keychain and is
/// resolved at request time. Only this reference is ever persisted.
public struct StoredConnectionProfile: Codable, Sendable, Equatable {
    public let handle: String
    public let gatewayHost: String
    public let runtimeSlot: String
    /// Keychain key under which the auth token is stored — NOT the token itself.
    public let credentialRef: String

    public init(
        handle: String,
        gatewayHost: String,
        runtimeSlot: String = "primary",
        credentialRef: String
    ) {
        self.handle = handle
        self.gatewayHost = gatewayHost
        self.runtimeSlot = runtimeSlot
        self.credentialRef = credentialRef
    }
}
