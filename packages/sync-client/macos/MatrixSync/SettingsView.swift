import SwiftUI
import AppKit

struct SettingsView: View {
    @ObservedObject var status: SyncStatusModel
    // Local edit state so typing doesn't thrash the daemon on every keystroke.
    @State private var syncPathDraft: String = ""
    @State private var gatewayFolderDraft: String = ""
    @State private var saving = false
    @State private var message: String?
    @State private var isError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sync Settings")
                .font(.title2)
                .fontWeight(.semibold)

            GroupBox(label: Label("Identity", systemImage: "person.circle")) {
                VStack(alignment: .leading, spacing: 6) {
                    if let peer = status.peerId {
                        LabeledRow("Peer", peer)
                    }
                    if let gw = status.gatewayUrl {
                        LabeledRow("Gateway", gw)
                    }
                    Button(role: .destructive) {
                        status.logout()
                        message = "Logged out. Daemon stopped."
                        isError = false
                    } label: {
                        Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    .padding(.top, 4)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            GroupBox(label: Label("Sync Folder", systemImage: "folder")) {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Local path", text: $syncPathDraft)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Button("Browse…") { pickFolder() }
                        Spacer()
                        if let path = status.syncPath {
                            Button("Add to Finder Sidebar") {
                                revealAndPromptSidebar(path: path)
                            }
                            Button("Reveal in Finder") {
                                NSWorkspace.shared.open(URL(fileURLWithPath: path))
                            }
                        }
                    }
                    Text("macOS 14+ no longer exposes a public API for adding items to the Finder sidebar. Click \"Add to Finder Sidebar\" and drag the highlighted folder into the Favorites section.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            GroupBox(label: Label("Gateway Scope", systemImage: "externaldrive.connected.to.line.below")) {
                VStack(alignment: .leading, spacing: 8) {
                    // Empty = full mirror (the daemon replicates the user's
                    // entire gateway sync root). Non-empty scopes to a subtree.
                    TextField("Folder (empty = full mirror)", text: $gatewayFolderDraft)
                        .textFieldStyle(.roundedBorder)
                    Text(gatewayFolderDraft.isEmpty
                         ? "Full mirror of your gateway sync root."
                         : "Scoped to: \(gatewayFolderDraft)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack {
                if let msg = message {
                    Text(msg)
                        .font(.caption)
                        .foregroundColor(isError ? .red : .green)
                }
                Spacer()
                Button("Save & Restart") {
                    Task { await save() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(saving || !isDirty)
            }
        }
        .padding(20)
        .frame(minWidth: 480, minHeight: 360)
        .onAppear { loadDraft() }
        .onChange(of: status.syncPath) { _, _ in loadDraft() }
        .onChange(of: status.gatewayFolder) { _, _ in loadDraft() }
    }

    private var isDirty: Bool {
        syncPathDraft != (status.syncPath ?? "") ||
        gatewayFolderDraft != (status.gatewayFolder ?? "")
    }

    private func loadDraft() {
        syncPathDraft = status.syncPath ?? ""
        gatewayFolderDraft = status.gatewayFolder ?? ""
    }

    // LSSharedFileList* was deprecated in macOS 10.11 but is still the only
    // public-adjacent way to add a Finder sidebar favorite. It still ships
    // and works on macOS 14/15; Apple just doesn't add new features to it.
    // If a future release breaks this, fall back to a "drag this to your
    // sidebar" NSAlert.
    // Previously called LSSharedFileListInsertItemURL. That API is
    // deprecated AND broken on macOS 14+ (the kLSSharedFileListItemLast
    // constant points at freed memory, dereferencing crashes with
    // EXC_BAD_ACCESS at address 0x2). There is no supported public
    // replacement short of a File Provider Extension, so we fall back to
    // opening Finder with the folder selected + an NSAlert that walks the
    // user through dragging it in once.
    private func revealAndPromptSidebar(path: String) {
        let url = URL(fileURLWithPath: path)
        NSWorkspace.shared.activateFileViewerSelecting([url])
        let alert = NSAlert()
        alert.messageText = "Add MatrixSync to Finder Sidebar"
        alert.informativeText = """
            Finder should now be focused on the MatrixSync folder. To keep \
            it pinned:

            1. Drag the folder into the Favorites section of Finder's sidebar.
            2. Once pinned, you'll see badges (green / blue / red) on files \
            as they sync.

            You only need to do this once per machine.
            """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
        message = "Drag the highlighted folder into Finder's sidebar."
        isError = false
    }

    private func showError(_ text: String) {
        message = text
        isError = true
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.title = "Pick sync folder"
        if panel.runModal() == .OK, let url = panel.url {
            syncPathDraft = url.path
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            if syncPathDraft != (status.syncPath ?? "") {
                try await status.setSyncPath(syncPathDraft)
            }
            if gatewayFolderDraft != (status.gatewayFolder ?? "") {
                try await status.setGatewayFolder(gatewayFolderDraft)
            }
            // Restart brings the new paths into effect. The daemon re-reads
            // config on startup, runs initial-pull against the new scope,
            // and the menu bar refreshes once the socket comes back.
            try await status.restart()
            message = "Saved. Restarting daemon…"
            isError = false
        } catch {
            message = "Save failed: \(error.localizedDescription)"
            isError = true
        }
    }
}

private struct LabeledRow: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(width: 70, alignment: .leading)
            Text(value)
                .font(.caption.monospaced())
                .textSelection(.enabled)
        }
    }
}
