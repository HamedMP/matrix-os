import Foundation

/// Test double that intercepts URLSession traffic so networking code can be
/// asserted without a live server. Handlers are stored per-thread-safe box and
/// produce a (response, body) or an error.
final class MockURLProtocol: URLProtocol {
    struct Stub: @unchecked Sendable {
        let handler: (URLRequest) throws -> (HTTPURLResponse, Data)
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var _stub: Stub?
    nonisolated(unsafe) private static var _capturedRequests: [URLRequest] = []

    static func setHandler(_ handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) {
        lock.lock(); defer { lock.unlock() }
        _stub = Stub(handler: handler)
        _capturedRequests = []
    }

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        _stub = nil
        _capturedRequests = []
    }

    static var capturedRequests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return _capturedRequests
    }

    static var lastRequest: URLRequest? {
        capturedRequests.last
    }

    private static func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        _capturedRequests.append(request)
    }

    private static func currentStub() -> Stub? {
        lock.lock(); defer { lock.unlock() }
        return _stub
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        MockURLProtocol.record(request)
        guard let stub = MockURLProtocol.currentStub() else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        do {
            let (response, data) = try stub.handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

extension URLSessionConfiguration {
    /// An ephemeral configuration wired to the mock protocol for tests.
    static func mocked() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return config
    }
}

/// Convenience to build an HTTPURLResponse for a given URL + status.
func httpResponse(_ url: URL, _ status: Int) -> HTTPURLResponse {
    HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
}
