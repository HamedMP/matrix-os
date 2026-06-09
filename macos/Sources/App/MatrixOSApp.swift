// Matrix OS — native macOS app entrypoint (US1 / T033).
//
// SwiftUI `App` hosting the real OPERATOR board. `AppModel` coordinates the
// connection profile, principal token, gateway client, board store, and the
// open-card → terminal wiring. The root view renders onboarding, the loading
// skeleton, the live board, or the read-only disconnected board depending on
// `AppModel.phase`. Window chrome is titlebar-transparent with a unified toolbar
// so the machined void/grain shows through floating chrome (design.md §7).
//
// US1 boots into the onboarding empty state (no profile selected). Selecting a
// runtime and signing in lands with US2/auth wiring; the device-auth client and
// VPS resolver already exist in MatrixNet and are composed here when a profile
// is supplied. Set MATRIX_DEV_GATEWAY_HOST + MATRIX_DEV_HANDLE in the environment
// to auto-select a dev profile for local source dev.
import AppKit
import SwiftUI
import DesignSystem
import MatrixNet

@main
struct MatrixOSApp: App {
    @NSApplicationDelegateAdaptor(MatrixOSAppDelegate.self) private var appDelegate
    @StateObject private var model: AppModel

    init() {
        let model = AppModel.live(
            projectSlug: ProcessInfo.processInfo.environment["MATRIX_PROJECT_SLUG"] ?? "default",
            profile: Self.devProfile()
        )
        _model = StateObject(wrappedValue: model)
    }

    var body: some Scene {
        WindowGroup("Matrix OS") {
            RootView(model: model)
                .frame(minWidth: 1024, minHeight: 640)
                .task { await model.refresh() }
                .onOpenURL { url in
                    model.handleOpenURL(url)
                }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { OperatorCommands(model: model) }
    }

    /// Optional dev profile from environment for local source dev only. Production
    /// boots into onboarding until the user selects a runtime + signs in.
    private static func devProfile() -> ConnectionProfile? {
        let env = ProcessInfo.processInfo.environment
        let host = env["MATRIX_DEV_GATEWAY_HOST"] ?? "app.matrix-os.com"
        guard let handle = env["MATRIX_DEV_HANDLE"], !handle.isEmpty else { return nil }
        let slot = env["MATRIX_DEV_RUNTIME_SLOT"]
        return ConnectionProfile(handle: handle, gatewayHost: host, runtimeSlot: slot)
    }
}

private final class MatrixOSAppDelegate: NSObject, NSApplicationDelegate {
    nonisolated func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            MatrixOSAppDelegate.bringAppForward()
            try? await Task.sleep(nanoseconds: 250_000_000)
            MatrixOSAppDelegate.bringAppForward()
        }
    }

    nonisolated func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        Task { @MainActor in
            MatrixOSAppDelegate.bringAppForward()
            try? await Task.sleep(nanoseconds: 150_000_000)
            MatrixOSAppDelegate.bringAppForward()
        }
        return true
    }

    @MainActor
    private static func bringAppForward() {
        NSApp.setActivationPolicy(.regular)
        NSApp.windows.forEach(configureNativeChrome)

        if let window = NSApp.mainWindow ?? NSApp.keyWindow ?? NSApp.windows.first {
            configureNativeChrome(window)
            recoverIfOffscreen(window)
            window.makeKeyAndOrderFront(nil)
        }
        NSApp.activate()
    }

    @MainActor
    private static func configureNativeChrome(_ window: NSWindow) {
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unifiedCompact
        window.isMovableByWindowBackground = true
        window.backgroundColor = .windowBackgroundColor
    }

    @MainActor
    private static func recoverIfOffscreen(_ window: NSWindow) {
        let frame = window.frame
        let isReachable = NSScreen.screens.contains { screen in
            screen.visibleFrame.intersects(frame)
        }
        guard !isReachable else { return }

        if let screen = NSScreen.main ?? NSScreen.screens.first {
            let visibleFrame = screen.visibleFrame
            let origin = NSPoint(
                x: visibleFrame.midX - frame.width / 2,
                y: visibleFrame.midY - frame.height / 2
            )
            window.setFrameOrigin(origin)
        }
    }
}

/// Root view: binds the OPERATOR look to the window and renders the board.
private struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        RootShellView(model: model)
            .background(WindowVibrancy())
    }
}

/// Matrix keyboard model (design.md §7). US1 wires panel switching and
/// dismiss; ⌘N is a placeholder until US2 mutations land.
private struct OperatorCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandMenu("Matrix") {
            Button("Command Palette…") { model.showCommandPalette.toggle() }
                .keyboardShortcut("k", modifiers: .command)
            Button("Open File…") { model.showFileOpenSearch() }
                .keyboardShortcut("o", modifiers: .command)
            Divider()
            Button("New Task") { model.newCardPlaceholder() }
                .keyboardShortcut("n", modifiers: .command)
            Button("New Session") { model.beginTerminalSessionCreation() }
                .keyboardShortcut("t", modifiers: .command)
            Divider()
            Button("Home") { model.openHome() }
                .keyboardShortcut("1", modifiers: .control)
            Button("Project Board") { model.openBoardTab() }
                .keyboardShortcut("b", modifiers: .command)
            Button("Board") { model.openBoardTab() }
                .keyboardShortcut("2", modifiers: .control)
            Button("Terminal") { model.openTerminalSection() }
                .keyboardShortcut("3", modifiers: .control)
            Button("Settings") { model.openAppTab(slug: "settings", title: "Settings") }
                .keyboardShortcut(",", modifiers: .command)
            Button("Browser") { model.section = .browser }
                .keyboardShortcut("4", modifiers: .control)
            Divider()
            Button("Refresh") { Task { await model.refresh() } }
                .keyboardShortcut("r", modifiers: .command)
            Button("Close Tab") { model.closeActiveTab() }
                .keyboardShortcut("w", modifiers: .command)
            Button("Next Tab") { model.focusNextTab() }
                .keyboardShortcut("]", modifiers: .command)
            Button("Previous Tab") { model.focusPreviousTab() }
                .keyboardShortcut("[", modifiers: .command)
            Divider()
            Button("Tab 1") { model.focusTab(at: 0) }
                .keyboardShortcut("1", modifiers: .command)
            Button("Tab 2") { model.focusTab(at: 1) }
                .keyboardShortcut("2", modifiers: .command)
            Button("Tab 3") { model.focusTab(at: 2) }
                .keyboardShortcut("3", modifiers: .command)
            Button("Tab 4") { model.focusTab(at: 3) }
                .keyboardShortcut("4", modifiers: .command)
            Button("Tab 5") { model.focusTab(at: 4) }
                .keyboardShortcut("5", modifiers: .command)
            Button("Tab 6") { model.focusTab(at: 5) }
                .keyboardShortcut("6", modifiers: .command)
            Button("Tab 7") { model.focusTab(at: 6) }
                .keyboardShortcut("7", modifiers: .command)
            Button("Tab 8") { model.focusTab(at: 7) }
                .keyboardShortcut("8", modifiers: .command)
            Button("Tab 9") { model.focusTab(at: 8) }
                .keyboardShortcut("9", modifiers: .command)
            Divider()
            Button("Terminal Panel") { model.switchPanel(.terminal) }
                .keyboardShortcut("1", modifiers: [.command, .option])
            Button("Editor Panel") { model.switchPanel(.app(slug: "editor")) }
                .keyboardShortcut("2", modifiers: [.command, .option])
            Button("Git Panel") { model.switchPanel(.app(slug: "git")) }
                .keyboardShortcut("4", modifiers: [.command, .option])
            Divider()
            Button("Close Card") { model.closeCard() }
                .keyboardShortcut(.escape, modifiers: [])
        }
    }
}

/// True window vibrancy: the machined void/grain shows faintly through floating
/// chrome (design.md §7). Honors Reduce Transparency automatically (NSVisualEffectView).
private struct WindowVibrancy: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .underWindowBackground
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}
