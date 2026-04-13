import SwiftUI

struct MenuBarView: View {
    @ObservedObject var status: SyncStatusModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusHeader
            Divider()
            peersSection
            Divider()
            activitySection
            if !status.pendingConflicts.isEmpty {
                Divider()
                conflictsSection
            }
            if !status.pendingInvites.isEmpty {
                Divider()
                invitesSection
            }
            Divider()
            quickActions
        }
        .frame(width: 300)
        .onAppear { status.start() }
        .onDisappear { status.stop() }
    }

    private var statusHeader: some View {
        HStack {
            Image(systemName: status.iconName)
                .foregroundStyle(statusColor)
                .font(.title3)
            VStack(alignment: .leading) {
                Text("Matrix Sync")
                    .font(.headline)
                Text(status.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var statusColor: Color {
        switch status.status {
        case .synced:   return .green
        case .syncing:  return .blue
        case .offline:  return .gray
        case .conflict: return .orange
        case .paused:   return .yellow
        }
    }

    private var peersSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Connected Peers", systemImage: "desktopcomputer")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 6)

            if status.connectedPeers.isEmpty {
                Text("No peers connected")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            } else {
                ForEach(status.connectedPeers) { peer in
                    HStack {
                        Image(systemName: platformIcon(peer.platform))
                        Text(peer.hostname)
                            .font(.caption)
                        Spacer()
                        Text(peer.connectedAt, style: .relative)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12)
                }
                .padding(.bottom, 6)
            }
        }
    }

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Recent Activity", systemImage: "clock")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 6)

            if status.recentActivity.isEmpty {
                Text("No recent activity")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            } else {
                ForEach(status.recentActivity.prefix(5)) { item in
                    HStack {
                        Image(systemName: actionIcon(item.action))
                            .foregroundStyle(actionColor(item.action))
                        Text(item.path)
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Text(item.timestamp, style: .relative)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12)
                }
                .padding(.bottom, 6)
            }
        }
    }

    private var conflictsSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Conflicts (\(status.pendingConflicts.count))", systemImage: "exclamationmark.triangle")
                .font(.caption.bold())
                .foregroundStyle(.orange)
                .padding(.horizontal, 12)
                .padding(.top, 6)

            ForEach(status.pendingConflicts.prefix(3)) { conflict in
                HStack {
                    Text(conflict.path)
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Text(conflict.remotePeerId)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12)
            }
            .padding(.bottom, 6)
        }
    }

    private var invitesSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Share Invitations", systemImage: "person.badge.plus")
                .font(.caption.bold())
                .foregroundStyle(.blue)
                .padding(.horizontal, 12)
                .padding(.top, 6)

            ForEach(status.pendingInvites) { invite in
                HStack {
                    VStack(alignment: .leading) {
                        Text(invite.ownerHandle)
                            .font(.caption)
                        Text(invite.path)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(invite.role)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.blue.opacity(0.1))
                        .clipShape(Capsule())
                }
                .padding(.horizontal, 12)
            }
            .padding(.bottom, 6)
        }
    }

    private var quickActions: some View {
        VStack(spacing: 0) {
            if status.status == .paused {
                Button {
                    Task { await status.resumeSync() }
                } label: {
                    Label("Resume Sync", systemImage: "play.circle")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            } else {
                Button {
                    Task { await status.pauseSync() }
                } label: {
                    Label("Pause Sync", systemImage: "pause.circle")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }

            Button {
                openSyncFolder()
            } label: {
                Label("Open Sync Folder", systemImage: "folder")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Button {
                openWebShell()
            } label: {
                Label("Open Web Shell", systemImage: "terminal")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()

            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Label("Quit Matrix Sync", systemImage: "xmark.circle")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    private func platformIcon(_ platform: String) -> String {
        switch platform {
        case "darwin":  return "laptopcomputer"
        case "linux":   return "server.rack"
        case "win32":   return "desktopcomputer"
        default:        return "questionmark.circle"
        }
    }

    private func actionIcon(_ action: String) -> String {
        switch action {
        case "add":     return "plus.circle"
        case "update":  return "arrow.clockwise.circle"
        case "delete":  return "trash.circle"
        default:        return "circle"
        }
    }

    private func actionColor(_ action: String) -> Color {
        switch action {
        case "add":     return .green
        case "update":  return .blue
        case "delete":  return .red
        default:        return .gray
        }
    }

    private func openSyncFolder() {
        let syncPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("matrixos")
        NSWorkspace.shared.open(syncPath)
    }

    private func openWebShell() {
        if let url = URL(string: "https://matrix-os.com") {
            NSWorkspace.shared.open(url)
        }
    }
}
