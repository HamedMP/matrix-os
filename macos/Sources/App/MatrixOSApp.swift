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
import SwiftUI
import DesignSystem
import MatrixNet

@main
struct MatrixOSApp: App {
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

/// Root view: binds the OPERATOR look to the window and renders the board.
private struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        RootShellView(model: model)
            .background(WindowVibrancy())
            .preferredColorScheme(.light)
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
            Divider()
            Button("New Task") { model.newCardPlaceholder() }
                .keyboardShortcut("n", modifiers: .command)
            Button("New Session") { model.createSession() }
                .keyboardShortcut("n", modifiers: [.command, .shift])
            Divider()
            Button("Home") { model.section = .home }
                .keyboardShortcut("1", modifiers: .control)
            Button("Board") { model.section = .board }
                .keyboardShortcut("2", modifiers: .control)
            Button("Shell") { model.section = .shell }
                .keyboardShortcut("3", modifiers: .control)
            Divider()
            Button("Terminal Panel") { model.switchPanel(.terminal) }
                .keyboardShortcut("1", modifiers: .command)
            Button("Editor Panel") { model.switchPanel(.app(slug: "editor")) }
                .keyboardShortcut("2", modifiers: .command)
            Button("Git Panel") { model.switchPanel(.app(slug: "git")) }
                .keyboardShortcut("3", modifiers: .command)
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
