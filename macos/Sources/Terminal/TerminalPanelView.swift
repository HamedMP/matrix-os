#if os(macOS)
import SwiftUI
import AppKit
import SwiftTerm
import DesignSystem

// SwiftTerm also exports a `Color` type; disambiguate to SwiftUI's within this file.
private typealias Color = SwiftUI.Color

/// SwiftTerm-backed terminal panel (T034 / US1).
///
/// OPERATOR treatment (design.md §6.4):
/// - `surface.terminal` background, `radius.panel`, engraved hairline.
/// - IBM Plex Mono 12.5 / 1.45 line height, phosphor selection tint, block cursor.
/// - Top strip: session name + status badge + "● LIVE" / "↓ N new" affordance.
/// - Calm inline states: `reconnecting…` (amber), `session exited` (grey) — never raw errors.
public struct TerminalPanelView: View {
    public nonisolated static let rendererConfiguration = TerminalRendererConfiguration(kind: .swiftTerm)

    @ObservedObject private var session: TerminalSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(session: TerminalSession) {
        self.session = session
    }

    public var body: some View {
        VStack(spacing: 0) {
            topStrip
            terminalSurface
        }
        .background(Color.surfaceTerminal)
        .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                .strokeBorder(Color.hairlineDark, lineWidth: 1)
        )
    }

    // MARK: - Top strip

    private var topStrip: some View {
        HStack(spacing: Spacing.x3) {
            Text(session.displayName)
                .font(.plexMono(12, weight: .medium))
                .foregroundStyle(Color.terminalInk)
                .lineLimit(1)

            statusBadge

            Spacer(minLength: Spacing.x2)

            liveAffordance
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.vertical, Spacing.x2)
        .background(Color.surfaceTerminal)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 1)
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch session.connectionState {
        case .connecting:
            badge(text: "connecting", color: .terminalMutedInk)
        case .attached:
            badge(text: "attached", color: .signalLive)
        case .reconnecting:
            // Amber, animated ellipsis (calm, Reduce-Motion-aware).
            badge(text: "reconnecting", color: .signalWaiting, animatedEllipsis: true)
        case .exited:
            badge(text: "session exited", color: .signalIdle)
        case .error:
            // Generic copy only — the internal code is never surfaced.
            badge(text: "connection lost", color: .signalBlocked)
        }
    }

    private func badge(
        text: String,
        color: Color,
        animatedEllipsis: Bool = false
    ) -> some View {
        HStack(spacing: Spacing.x1) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(text)
                .font(.plexMono(10, weight: .medium))
                .foregroundStyle(color)
            if animatedEllipsis {
                AnimatedEllipsis(color: color, reduceMotion: reduceMotion)
            }
        }
        .padding(.horizontal, Spacing.x2)
        .padding(.vertical, Spacing.x1)
        .background(
            RoundedRectangle(cornerRadius: Radius.badge, style: .continuous)
                .fill(color.opacity(0.12))
        )
    }

    @ViewBuilder
    private var liveAffordance: some View {
        if session.isPinnedToBottom {
            HStack(spacing: Spacing.x1) {
                Circle().fill(Color.signalLive).frame(width: 6, height: 6)
                Text("LIVE")
                    .font(.plexMono(10, weight: .semibold))
                    .foregroundStyle(Color.signalLive)
            }
        } else {
            Button {
                session.setPinnedToBottom(true)
            } label: {
                Text("↓ \(session.unseenLines) new")
                    .font(.plexMono(10, weight: .medium))
                    .foregroundStyle(Color.inkSecondary)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Terminal surface

    private var terminalSurface: some View {
        SwiftTermView(session: session)
            .id(session.id)
            .background(Color.surfaceTerminal)
    }
}

// MARK: - Animated ellipsis (Reduce-Motion aware)

private struct AnimatedEllipsis: View {
    let color: Color
    let reduceMotion: Bool
    @State private var phase = 0
    @State private var ticker: Task<Void, Never>?

    var body: some View {
        Text(reduceMotion ? "…" : dots)
            .font(.plexMono(10, weight: .medium))
            .foregroundStyle(color)
            .onAppear {
                syncTickerForMotionPreference()
            }
            .onChange(of: reduceMotion) { _, _ in syncTickerForMotionPreference() }
            .onDisappear {
                stopTicker()
            }
    }

    private var dots: String {
        String(repeating: ".", count: phase)
    }

    private func syncTickerForMotionPreference() {
        stopTicker()
        guard !reduceMotion else {
            phase = 0
            return
        }
        ticker = Task { @MainActor in
            // Calm ellipsis: never a harsh blink. Stops when the view goes away.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 450_000_000)
                phase = (phase + 1) % 4
            }
        }
    }

    private func stopTicker() {
        ticker?.cancel()
        ticker = nil
    }
}

// MARK: - SwiftTerm NSViewRepresentable

/// Wraps SwiftTerm's macOS `TerminalView`, binding it to a `TerminalSession`:
/// - feeds decoded output bytes in (via the session's output sink),
/// - forwards keystrokes out (`TerminalViewDelegate.send`),
/// - reports size changes back to the session (`resize`).
private struct SwiftTermView: NSViewRepresentable {
    let session: TerminalSession

    func makeCoordinator() -> Coordinator {
        Coordinator(session: session)
    }

    func makeNSView(context: Context) -> TerminalView {
        let view = FocusableTerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        context.coordinator.terminalView = view
        let clickRecognizer = NSClickGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.focusTerminal(_:)))
        clickRecognizer.numberOfClicksRequired = 1
        clickRecognizer.delaysPrimaryMouseButtonEvents = false
        view.addGestureRecognizer(clickRecognizer)

        // OPERATOR look: deep terminal surface + phosphor ink, Plex Mono 12.5.
        view.nativeBackgroundColor = NSColor(Color.surfaceTerminal)
        view.nativeForegroundColor = NSColor(Color.terminalInk)
        view.font = Self.terminalFont(size: 12.5)

        // Install the output sink so future server `output` events feed SwiftTerm.
        session.setOutputSink { [weak view] text in
            view?.feed(text: text)
        }

        // Report the initial size once the view has a backing dimension, and start.
        let dims = view.getTerminal().getDims()
        session.resize(cols: dims.cols, rows: dims.rows)
        session.start()
        return view
    }

    func updateNSView(_ nsView: TerminalView, context: Context) {
        // Keep the coordinator's reference fresh; sizing is reported via the delegate.
        context.coordinator.terminalView = nsView
        guard !context.coordinator.didRequestInitialFocus else { return }
        DispatchQueue.main.async {
            if TerminalFocusPolicy.requestFocus(nsView) {
                context.coordinator.didRequestInitialFocus = true
            }
        }
    }

    private static func terminalFont(size: CGFloat) -> NSFont {
        let preferredFamilies = [
            "MesloLGS NF",
            "MesloLGS Nerd Font Mono",
            "MesloLGS NF Regular",
            "JetBrainsMono Nerd Font",
            "JetBrainsMono Nerd Font Mono",
            "Hack Nerd Font",
            "Hack Nerd Font Mono",
            "FiraCode Nerd Font",
            "FiraCode Nerd Font Mono",
            "Menlo",
            "IBMPlexMono",
        ]
        for family in preferredFamilies {
            if let font = NSFont(name: family, size: size) {
                return font
            }
        }
        return NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// Bridges SwiftTerm's `TerminalViewDelegate` to the `TerminalSession`.
    ///
    /// `TerminalViewDelegate` is a `nonisolated` protocol, but SwiftTerm's macOS
    /// `TerminalView` only invokes its delegate on the main thread (it is an NSView).
    /// We therefore use `MainActor.assumeIsolated` to reach the main-actor-isolated
    /// `TerminalSession` without an extra async hop.
    final class Coordinator: NSObject, TerminalViewDelegate {
        private let session: TerminalSession
        weak var terminalView: TerminalView?
        var didRequestInitialFocus = false

        init(session: TerminalSession) {
            self.session = session
        }

        @MainActor @objc func focusTerminal(_ recognizer: NSClickGestureRecognizer) {
            guard let source = recognizer.view as? TerminalView else { return }
            _ = TerminalFocusPolicy.requestFocus(source, mode: .userInitiated)
        }

        // User keystrokes → PTY.
        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            let text = String(decoding: data, as: UTF8.self)
            let session = self.session // capture the Sendable @MainActor view-model only
            MainActor.assumeIsolated { session.send(text) }
        }

        // Terminal grid resized (font/frame change) → tell the server.
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            let session = self.session
            MainActor.assumeIsolated { session.resize(cols: newCols, rows: newRows) }
        }

        // Scroll position → drive the LIVE / "↓ N new" affordance. 1.0 == bottom.
        func scrolled(source: TerminalView, position: Double) {
            let session = self.session
            MainActor.assumeIsolated { session.setPinnedToBottom(position >= 0.999) }
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
        func bell(source: TerminalView) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}

final class FocusableTerminalView: TerminalView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        TerminalFocusPolicy.scheduleInitialFocus(for: self)
    }
}

enum TerminalFocusPolicy {
    enum Mode {
        case initial
        case userInitiated
    }

    static let initialFocusRetryDelays: [TimeInterval] = [0, 0.05, 0.15, 0.35]

    static func shouldRequestInitialFocus(
        hasFirstResponder: Bool,
        firstResponderIsTerminal: Bool,
        firstResponderIsRootView: Bool,
        firstResponderIsWindow: Bool = false
    ) -> Bool {
        !hasFirstResponder || firstResponderIsTerminal || firstResponderIsRootView || firstResponderIsWindow
    }

    @MainActor
    static func scheduleInitialFocus(for view: TerminalView?) {
        for delay in initialFocusRetryDelays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak view] in
                Task { @MainActor in
                    _ = requestFocus(view)
                }
            }
        }
    }

    @MainActor
    @discardableResult
    static func requestFocus(_ view: TerminalView?, mode: Mode = .initial) -> Bool {
        guard let view, let window = view.window else { return false }
        if mode == .initial {
            let firstResponder = window.firstResponder
            let shouldFocus = shouldRequestInitialFocus(
                hasFirstResponder: firstResponder != nil,
                firstResponderIsTerminal: firstResponder === view,
                firstResponderIsRootView: firstResponder === window.contentView,
                firstResponderIsWindow: firstResponder === window
            )
            guard shouldFocus else { return false }
        }
        window.makeFirstResponder(view)
        return window.firstResponder === view
    }
}
#endif
