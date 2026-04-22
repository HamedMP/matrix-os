import SwiftUI

@main
struct MatrixSyncApp: App {
    @StateObject private var syncStatus = SyncStatusModel()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(status: syncStatus)
        } label: {
            Image(systemName: syncStatus.icon)
        }

        // Settings scene is SwiftUI's dedicated preferences window --
        // reachable via ⌘, and from the MenuBarView "Settings…" button.
        Settings {
            SettingsView(status: syncStatus)
        }
    }
}
