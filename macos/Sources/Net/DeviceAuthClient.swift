// MatrixNet — platform device-authorization flow client.
//
// Mirrors the `matrix` CLI flow against the platform:
//   POST /api/auth/device/code  -> { deviceCode, userCode, verificationUri, expiresIn, interval }
//   POST /api/auth/device/token -> 200 { accessToken, expiresAt, userId, handle }
//                                  428 authorization_pending / 429 slow_down
//                                  410 expired_token / 5xx server_error
//
// Network calls sit behind the DeviceAuthorizing protocol so callers (and tests)
// can inject a mock. Errors are mapped to generic GatewayError (no body leakage).
import Foundation

/// A started device-authorization request the user must approve in a browser.
public struct DeviceAuthStart: Codable, Equatable, Sendable {
    public let deviceCode: String
    public let userCode: String
    public let verificationUri: String
    public let expiresIn: Int
    public let interval: Int
}

/// A successfully issued principal token + identity metadata.
public struct DeviceAuthToken: Codable, Equatable, Sendable {
    public let accessToken: String
    /// Epoch milliseconds when the token expires (the platform sends a JSON number).
    public let expiresAt: Double?
    public let userId: String?
    public let handle: String?
}

/// One poll outcome of the device-token endpoint.
public enum DevicePollResult: Equatable, Sendable {
    case pending
    case slowDown
    case expired
    case approved(DeviceAuthToken)
}

public protocol DeviceAuthorizing: Sendable {
    func startDeviceAuth() async throws -> DeviceAuthStart
    func pollForToken(deviceCode: String) async throws -> DevicePollResult
}

public struct DeviceAuthClient: DeviceAuthorizing {
    private let platformURL: URL
    private let session: URLSession
    private let timeout: TimeInterval
    private let clientId: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(
        platformURL: URL,
        clientId: String = "matrix-os-macos",
        sessionConfiguration: URLSessionConfiguration = .ephemeral,
        timeout: TimeInterval = 10
    ) {
        self.platformURL = platformURL
        self.clientId = clientId
        self.session = URLSession(configuration: sessionConfiguration)
        self.timeout = timeout
    }

    private struct CodeBody: Encodable {
        let clientId: String
        let redirectUri: String?
    }

    public func startDeviceAuth() async throws -> DeviceAuthStart {
        // RFC 8628 device-code request. The app polls for approval, so do not
        // ask the browser to deep-link back and accidentally open another app.
        let (data, http) = try await post(
            path: "/api/auth/device/code",
            body: CodeBody(clientId: clientId, redirectUri: nil)
        )
        if let mapped = GatewayError.from(statusCode: http.statusCode) {
            throw mapped
        }
        do {
            return try decoder.decode(DeviceAuthStart.self, from: data)
        } catch {
            throw GatewayError.decoding
        }
    }

    private struct PollBody: Encodable { let deviceCode: String }

    public func pollForToken(deviceCode: String) async throws -> DevicePollResult {
        let (data, http) = try await post(
            path: "/api/auth/device/token",
            body: PollBody(deviceCode: deviceCode)
        )
        switch http.statusCode {
        case 200..<300:
            do {
                return .approved(try decoder.decode(DeviceAuthToken.self, from: data))
            } catch {
                throw GatewayError.decoding
            }
        case 428:
            return .pending
        case 429:
            return .slowDown
        case 410:
            return .expired
        case 401:
            throw GatewayError.unauthorized
        case 404:
            throw GatewayError.notFound
        default:
            throw GatewayError.server
        }
    }

    // MARK: - Transport

    private struct EmptyBody: Encodable {}

    private func post<Body: Encodable>(path: String, body: Body) async throws -> (Data, HTTPURLResponse) {
        guard var comps = URLComponents(url: platformURL, resolvingAgainstBaseURL: false) else {
            throw GatewayError.misconfigured
        }
        comps.path = path
        guard let url = comps.url else { throw GatewayError.misconfigured }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try encoder.encode(body)
        } catch {
            throw GatewayError.decoding
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw GatewayError.server }
            return (data, http)
        } catch let error as GatewayError {
            throw error
        } catch {
            throw GatewayError.from(transport: error)
        }
    }
}
