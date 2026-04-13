import SwiftUI

@main
struct MatrixSyncApp: App {
    @StateObject private var syncStatus = SyncStatusModel()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(status: syncStatus)
        } label: {
            Image(systemName: syncStatus.iconName)
                .symbolRenderingMode(.hierarchical)
        }
    }
}

@MainActor
final class SyncStatusModel: ObservableObject {
    enum Status: String, Sendable {
        case synced
        case syncing
        case offline
        case conflict
        case paused
    }

    @Published var status: Status = .offline
    @Published var connectedPeers: [PeerInfo] = []
    @Published var recentActivity: [ActivityItem] = []
    @Published var pendingConflicts: [ConflictItem] = []
    @Published var pendingInvites: [ShareInvite] = []

    var iconName: String {
        switch status {
        case .synced:   return "checkmark.circle"
        case .syncing:  return "arrow.triangle.2.circlepath"
        case .offline:  return "wifi.slash"
        case .conflict: return "exclamationmark.triangle"
        case .paused:   return "pause.circle"
        }
    }

    var statusText: String {
        switch status {
        case .synced:   return "Synced"
        case .syncing:  return "Syncing..."
        case .offline:  return "Offline"
        case .conflict: return "Conflicts"
        case .paused:   return "Paused"
        }
    }

    private var daemonClient: DaemonClient?
    private var pollTimer: Timer?

    func start() {
        daemonClient = DaemonClient()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.refresh()
            }
        }
        Task { await refresh() }
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        daemonClient = nil
    }

    func refresh() async {
        guard let client = daemonClient else { return }
        do {
            let state = try await client.getStatus()
            status = state.status
            connectedPeers = state.peers
            recentActivity = state.activity
            pendingConflicts = state.conflicts
            pendingInvites = state.invites
        } catch {
            status = .offline
        }
    }

    func pauseSync() async {
        try? await daemonClient?.sendCommand("pause")
        status = .paused
    }

    func resumeSync() async {
        try? await daemonClient?.sendCommand("resume")
        await refresh()
    }
}

struct PeerInfo: Identifiable, Sendable {
    let id: String
    let hostname: String
    let platform: String
    let connectedAt: Date
}

struct ActivityItem: Identifiable, Sendable {
    let id: String
    let path: String
    let action: String
    let peerId: String
    let timestamp: Date
}

struct ConflictItem: Identifiable, Sendable {
    let id: String
    let path: String
    let conflictPath: String
    let remotePeerId: String
    let detectedAt: Date
}

struct ShareInvite: Identifiable, Sendable {
    let id: String
    let ownerHandle: String
    let path: String
    let role: String
}
