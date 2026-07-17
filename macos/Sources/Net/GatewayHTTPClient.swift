// MatrixNet — gateway/platform HTTP client.
//
// Wraps URLSession with:
//   * bounded per-request timeouts (default 10s, injectable),
//   * an `Authorization: Bearer <token>` header pulled from an injected
//     TokenProviding on every request,
//   * generic GET/POST/PATCH/DELETE returning decoded Codable or throwing a
//     GENERIC GatewayError that never leaks the server body / provider text.
//
// All calls go through the platform proxy at the app domain (research.md C4);
// this client never addresses a VPS IP directly.
import Foundation

public struct GatewayHTTPClient: Sendable {
    private let baseURL: URL
    private let tokenProvider: any TokenProviding
    private let session: URLSession
    private let defaultTimeout: TimeInterval
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(
        baseURL: URL,
        tokenProvider: any TokenProviding,
        sessionConfiguration: URLSessionConfiguration = .ephemeral,
        defaultTimeout: TimeInterval = 10
    ) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.session = URLSession(configuration: sessionConfiguration)
        self.defaultTimeout = defaultTimeout
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    // MARK: - Public verbs

    public func get<Response: Decodable>(
        _ path: String,
        as type: Response.Type = Response.self,
        timeout: TimeInterval? = nil
    ) async throws -> Response {
        try await send(method: "GET", path: path, body: Optional<EmptyBody>.none, timeout: timeout)
    }

    public func getData(_ path: String, timeout: TimeInterval? = nil) async throws -> Data {
        try await sendRaw(method: "GET", path: path, body: Optional<EmptyBody>.none, timeout: timeout)
    }

    public func post<Body: Encodable, Response: Decodable>(
        _ path: String,
        body: Body,
        as type: Response.Type = Response.self,
        timeout: TimeInterval? = nil
    ) async throws -> Response {
        try await send(method: "POST", path: path, body: body, timeout: timeout)
    }

    public func patch<Body: Encodable, Response: Decodable>(
        _ path: String,
        body: Body,
        as type: Response.Type = Response.self,
        timeout: TimeInterval? = nil
    ) async throws -> Response {
        try await send(method: "PATCH", path: path, body: body, timeout: timeout)
    }

    public func putData(
        _ path: String,
        data: Data,
        contentType: String = "text/plain; charset=utf-8",
        timeout: TimeInterval? = nil
    ) async throws {
        let request = try await makeRawRequest(
            method: "PUT",
            path: path,
            data: data,
            contentType: contentType,
            timeout: timeout
        )
        _ = try await perform(request)
    }

    /// DELETE with no decoded response body.
    public func delete(_ path: String, timeout: TimeInterval? = nil) async throws {
        _ = try await sendRaw(method: "DELETE", path: path, body: Optional<EmptyBody>.none, timeout: timeout)
    }

    // MARK: - Core

    private struct EmptyBody: Encodable {}

    private func send<Body: Encodable, Response: Decodable>(
        method: String,
        path: String,
        body: Body?,
        timeout: TimeInterval?
    ) async throws -> Response {
        let data = try await sendRaw(method: method, path: path, body: body, timeout: timeout)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            // Do not surface the decoding error detail; it can echo response text.
            throw GatewayError.decoding
        }
    }

    private func sendRaw<Body: Encodable>(
        method: String,
        path: String,
        body: Body?,
        timeout: TimeInterval?
    ) async throws -> Data {
        let request = try await makeRequest(method: method, path: path, body: body, timeout: timeout)
        return try await perform(request)
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            // Map transport failures; never rethrow the raw URLError to callers.
            throw GatewayError.from(transport: error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw GatewayError.server
        }
        if let mapped = GatewayError.from(statusCode: http.statusCode, data: data) {
            throw mapped
        }
        return data
    }

    private func makeRequest<Body: Encodable>(
        method: String,
        path: String,
        body: Body?,
        timeout: TimeInterval?
    ) async throws -> URLRequest {
        guard let url = resolve(path: path) else {
            throw GatewayError.misconfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout ?? defaultTimeout

        if let token = await tokenProvider.token() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do {
                request.httpBody = try encoder.encode(body)
            } catch {
                // Encoding our own request body should never leak server text.
                throw GatewayError.decoding
            }
        }
        return request
    }

    private func makeRawRequest(
        method: String,
        path: String,
        data: Data,
        contentType: String,
        timeout: TimeInterval?
    ) async throws -> URLRequest {
        guard let url = resolve(path: path) else {
            throw GatewayError.misconfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout ?? defaultTimeout
        if let token = await tokenProvider.token() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        return request
    }

    private func resolve(path: String) -> URL? {
        // Preserve any base query (e.g. ?runtime=staging) while appending the path.
        guard var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let relativePath = String(parts.first ?? "")
        comps.path = appendPath(base: comps.path, relative: relativePath)
        if parts.count == 2,
           let relative = URLComponents(string: path),
           let queryItems = relative.queryItems,
           !queryItems.isEmpty {
            let overriddenNames = Set(queryItems.map(\.name))
            let baseItems = (comps.queryItems ?? []).filter { !overriddenNames.contains($0.name) }
            comps.queryItems = baseItems + queryItems
        }
        return comps.url
    }

    private func appendPath(base: String, relative: String) -> String {
        let cleanBase = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let cleanRelative = relative.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        switch (cleanBase.isEmpty, cleanRelative.isEmpty) {
        case (true, true):
            return ""
        case (true, false):
            return "/\(cleanRelative)"
        case (false, true):
            return "/\(cleanBase)"
        case (false, false):
            return "/\(cleanBase)/\(cleanRelative)"
        }
    }
}
