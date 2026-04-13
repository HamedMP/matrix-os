import Foundation

struct DaemonState: Sendable {
    let status: SyncStatusModel.Status
    let peers: [PeerInfo]
    let activity: [ActivityItem]
    let conflicts: [ConflictItem]
    let invites: [ShareInvite]
}

actor DaemonClient {
    private let socketPath: String

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.socketPath = "\(home)/.matrixos/daemon.sock"
    }

    func getStatus() async throws -> DaemonState {
        let response = try await sendRequest(["command": "status"])

        let status = parseStatus(response["status"] as? String)
        let peers = parsePeers(response["peers"] as? [[String: Any]])
        let activity = parseActivity(response["activity"] as? [[String: Any]])
        let conflicts = parseConflicts(response["conflicts"] as? [[String: Any]])
        let invites = parseInvites(response["invites"] as? [[String: Any]])

        return DaemonState(
            status: status,
            peers: peers,
            activity: activity,
            conflicts: conflicts,
            invites: invites
        )
    }

    func sendCommand(_ command: String) async throws {
        _ = try await sendRequest(["command": command])
    }

    private func sendRequest(_ payload: [String: Any]) async throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: payload)
        let message = data + Data([0x0A]) // newline-delimited JSON

        let socket = try createUnixSocket(path: socketPath)
        defer { close(socket) }

        let nsData = message as NSData
        let written = write(socket, nsData.bytes, nsData.length)
        guard written == nsData.length else {
            throw DaemonError.writeFailed
        }

        var responseData = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }

        while true {
            let bytesRead = read(socket, buffer, bufferSize)
            if bytesRead <= 0 { break }
            responseData.append(buffer, count: bytesRead)
            if responseData.contains(0x0A) { break }
        }

        guard let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any] else {
            throw DaemonError.invalidResponse
        }

        return json
    }

    private func createUnixSocket(path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw DaemonError.socketCreateFailed
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = path.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            throw DaemonError.pathTooLong
        }

        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dest in
                for (i, byte) in pathBytes.enumerated() {
                    dest[i] = byte
                }
            }
        }

        let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, addrLen)
            }
        }

        guard result == 0 else {
            close(fd)
            throw DaemonError.connectFailed
        }

        return fd
    }

    private func parseStatus(_ raw: String?) -> SyncStatusModel.Status {
        guard let raw else { return .offline }
        return SyncStatusModel.Status(rawValue: raw) ?? .offline
    }

    private func parsePeers(_ raw: [[String: Any]]?) -> [PeerInfo] {
        guard let raw else { return [] }
        return raw.compactMap { dict in
            guard let peerId = dict["peerId"] as? String,
                  let hostname = dict["hostname"] as? String,
                  let platform = dict["platform"] as? String,
                  let connectedAt = dict["connectedAt"] as? Double
            else { return nil }
            return PeerInfo(
                id: peerId,
                hostname: hostname,
                platform: platform,
                connectedAt: Date(timeIntervalSince1970: connectedAt / 1000)
            )
        }
    }

    private func parseActivity(_ raw: [[String: Any]]?) -> [ActivityItem] {
        guard let raw else { return [] }
        return raw.compactMap { dict in
            guard let path = dict["path"] as? String,
                  let action = dict["action"] as? String,
                  let peerId = dict["peerId"] as? String,
                  let timestamp = dict["timestamp"] as? Double
            else { return nil }
            return ActivityItem(
                id: "\(path)-\(timestamp)",
                path: path,
                action: action,
                peerId: peerId,
                timestamp: Date(timeIntervalSince1970: timestamp / 1000)
            )
        }
    }

    private func parseConflicts(_ raw: [[String: Any]]?) -> [ConflictItem] {
        guard let raw else { return [] }
        return raw.compactMap { dict in
            guard let path = dict["path"] as? String,
                  let conflictPath = dict["conflictPath"] as? String,
                  let remotePeerId = dict["remotePeerId"] as? String,
                  let detectedAt = dict["detectedAt"] as? Double
            else { return nil }
            return ConflictItem(
                id: path,
                path: path,
                conflictPath: conflictPath,
                remotePeerId: remotePeerId,
                detectedAt: Date(timeIntervalSince1970: detectedAt / 1000)
            )
        }
    }

    private func parseInvites(_ raw: [[String: Any]]?) -> [ShareInvite] {
        guard let raw else { return [] }
        return raw.compactMap { dict in
            guard let id = dict["shareId"] as? String,
                  let ownerHandle = dict["ownerHandle"] as? String,
                  let path = dict["path"] as? String,
                  let role = dict["role"] as? String
            else { return nil }
            return ShareInvite(id: id, ownerHandle: ownerHandle, path: path, role: role)
        }
    }
}

enum DaemonError: Error {
    case socketCreateFailed
    case connectFailed
    case writeFailed
    case invalidResponse
    case pathTooLong
}
