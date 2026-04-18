import SwiftUI
import AppKit

struct MenuBarView: View {
    @ObservedObject var status: SyncStatusModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if status.isRunning {
                Label(
                    status.isSyncing ? "Syncing" : "Paused",
                    systemImage: status.isSyncing ? "arrow.triangle.2.circlepath" : "pause.circle"
                )
                .font(.headline)

                Divider()

                if let path = status.syncPath {
                    Label(path, systemImage: "folder")
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                // Surface the scope: empty gatewayFolder == full mirror of
                // the user's gateway sync root; a non-empty value means the
                // daemon is scoped to that subtree.
                let folder = status.gatewayFolder ?? ""
                Label(
                    folder.isEmpty ? "Full mirror" : "Folder: \(folder)",
                    systemImage: folder.isEmpty ? "externaldrive.connected.to.line.below" : "folder.badge.gearshape"
                )

                Label("\(status.fileCount) files tracked", systemImage: "doc.on.doc")

                if let lastSync = status.lastSyncAt {
                    Label("Last sync: \(lastSync, style: .relative) ago", systemImage: "clock")
                }

                if let peer = status.peerId {
                    Label(peer, systemImage: "laptopcomputer")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Divider()

                if status.isSyncing {
                    Button("Pause Sync") { status.pause() }
                } else {
                    Button("Resume Sync") { status.resume() }
                }

                if let path = status.syncPath {
                    Button("Open in Finder") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: path))
                    }
                }
            } else {
                Label("Daemon not running", systemImage: "exclamationmark.triangle")
                    .font(.headline)
                    .foregroundColor(.secondary)

                if let error = status.error {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.red)
                }

                Divider()

                Text("Run: matrix sync")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Divider()

            SettingsLink {
                Label("Settings…", systemImage: "gearshape")
            }
            .keyboardShortcut(",")

            Button("Refresh") { status.refresh() }
                .keyboardShortcut("r")

            Button("Quit") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
        .padding(8)
    }
}
