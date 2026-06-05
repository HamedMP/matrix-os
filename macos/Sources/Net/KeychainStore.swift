// MatrixNet — Keychain-backed secure token storage.
//
// Stores/retrieves/deletes string secrets keyed by account, in the macOS
// Keychain (kSecClassGenericPassword). The principal/device-auth token is the
// only durable local credential the app keeps (Constitution P1: no other local
// durable user data). Sendable-safe: holds only an immutable service string.
import Foundation
import Security

/// Abstraction so PrincipalProvider can be unit-tested without the system Keychain.
public protocol TokenStoring: Sendable {
    func get(key: String) throws -> String?
    func set(key: String, value: String) throws
    func delete(key: String) throws
}

public enum KeychainError: Error, Equatable, Sendable {
    case unexpectedStatus(OSStatus)
    case encodingFailed
}

public struct KeychainStore: TokenStoring {
    private let service: String

    public init(service: String = "com.matrix-os.app") {
        self.service = service
    }

    private func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    public func get(key: String) throws -> String? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
                throw KeychainError.encodingFailed
            }
            return value
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    public func set(key: String, value: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }
        // Upsert: try update first, fall back to add. Avoids check-then-insert races.
        let query = baseQuery(key: key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(addStatus)
            }
        default:
            throw KeychainError.unexpectedStatus(updateStatus)
        }
    }

    public func delete(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
