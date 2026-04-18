import Foundation
import Combine

struct PeerInfo: Codable, Identifiable {
    let peerId: String
    let hostname: String
    let platform: String

    var id: String { peerId }
}

struct DaemonStatus: Codable {
    let syncing: Bool
    let manifestVersion: Int
    let lastSyncAt: Int?
    let fileCount: Int
    // Optional so older daemons (pre-F1) still decode cleanly; the UI
    // renders "<full mirror>" when gatewayFolder is nil or "".
    let syncPath: String?
    let gatewayFolder: String?
    let gatewayUrl: String?
    let peerId: String?
}

// IPC server wraps every response as `{id?, result | error}`. Decoding the
// inner DaemonStatus directly fails with "data couldn't be read because it
// is missing" -- the result lives one level deeper.
struct IPCResponse<T: Codable>: Codable {
    let id: String?
    let result: T?
    let error: String?
}

@MainActor
class SyncStatusModel: ObservableObject {
    @Published var isRunning = false
    @Published var isSyncing = false
    @Published var manifestVersion = 0
    @Published var fileCount = 0
    @Published var lastSyncAt: Date?
    @Published var error: String?
    @Published var syncPath: String?
    @Published var gatewayFolder: String?
    @Published var gatewayUrl: String?
    @Published var peerId: String?

    private var timer: Timer?
    private let socketPath: String

    var icon: String {
        if !isRunning { return "arrow.triangle.2.circlepath.circle" }
        if isSyncing { return "arrow.triangle.2.circlepath.circle.fill" }
        return "checkmark.circle.fill"
    }

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.socketPath = "\(home)/.matrixos/daemon.sock"
        startPolling()
    }

    func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
        refresh()
    }

    func refresh() {
        Task {
            do {
                let response = try await sendIPC(command: "status")
                guard let data = response.data(using: .utf8) else {
                    throw IPCError.noResponse
                }
                let envelope = try JSONDecoder().decode(IPCResponse<DaemonStatus>.self, from: data)
                if let err = envelope.error {
                    throw IPCError.daemonError(err)
                }
                guard let status = envelope.result else {
                    throw IPCError.noResponse
                }
                self.isRunning = true
                self.isSyncing = status.syncing
                self.manifestVersion = status.manifestVersion
                self.fileCount = status.fileCount
                if let ts = status.lastSyncAt, ts > 0 {
                    self.lastSyncAt = Date(timeIntervalSince1970: Double(ts) / 1000.0)
                }
                self.syncPath = status.syncPath
                self.gatewayFolder = status.gatewayFolder
                self.gatewayUrl = status.gatewayUrl
                self.peerId = status.peerId
                self.error = nil
            } catch {
                self.isRunning = false
                self.isSyncing = false
                self.error = error.localizedDescription
            }
        }
    }

    func pause() {
        Task {
            _ = try? await sendIPC(command: "pause")
            refresh()
        }
    }

    func resume() {
        Task {
            _ = try? await sendIPC(command: "resume")
            refresh()
        }
    }

    private func sendIPC(command: String) async throws -> String {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw IPCError.socketCreation }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            throw IPCError.pathTooLong
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dest in
                pathBytes.withUnsafeBufferPointer { src in
                    _ = memcpy(dest, src.baseAddress!, src.count)
                }
            }
        }

        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectResult == 0 else { throw IPCError.connectionFailed }

        let message = "{\"command\":\"\(command)\"}\n"
        message.withCString { cstr in
            _ = send(fd, cstr, strlen(cstr), 0)
        }

        var buffer = [UInt8](repeating: 0, count: 8192)
        let bytesRead = recv(fd, &buffer, buffer.count - 1, 0)
        guard bytesRead > 0 else { throw IPCError.noResponse }

        return String(bytes: buffer[0..<bytesRead], encoding: .utf8) ?? ""
    }
}

enum IPCError: LocalizedError {
    case socketCreation, pathTooLong, connectionFailed, noResponse
    case daemonError(String)

    var errorDescription: String? {
        switch self {
        case .socketCreation: return "Failed to create socket"
        case .pathTooLong: return "Socket path too long"
        case .connectionFailed: return "Cannot connect to daemon"
        case .noResponse: return "No response from daemon"
        case .daemonError(let msg): return "Daemon error: \(msg)"
        }
    }
}
