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
/// - IBM Plex Mono 13 / natural line height, phosphor amber block cursor + selection tint.
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
        let showOverlay = TerminalConnectionOverlayPolicy.shouldShowOverlay(
            for: session.connectionState,
            isStartupSettling: session.isStartupSettling
        )
        return ZStack {
            SwiftTermView(session: session)
                .id(session.id)
                .background(Color.surfaceTerminal)
                .allowsHitTesting(!showOverlay)

            if showOverlay {
                TerminalConnectionOverlay(
                    state: session.connectionState,
                    isStartupSettling: session.isStartupSettling,
                    reduceMotion: reduceMotion
                )
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: showOverlay)
    }
}

enum TerminalConnectionOverlayPolicy {
    static func shouldShowOverlay(for state: TerminalConnectionState) -> Bool {
        shouldShowOverlay(for: state, isStartupSettling: false)
    }

    static func shouldShowOverlay(
        for state: TerminalConnectionState,
        isStartupSettling: Bool
    ) -> Bool {
        switch state {
        case .connecting, .reconnecting:
            return true
        case .attached:
            return isStartupSettling
        case .exited, .error:
            return false
        }
    }
}

private struct TerminalConnectionOverlay: View {
    let state: TerminalConnectionState
    let isStartupSettling: Bool
    let reduceMotion: Bool

    private var title: String {
        switch state {
        case .attached where isStartupSettling:
            return "Settling terminal"
        case .reconnecting:
            return "Reconnecting"
        default:
            return "Connecting"
        }
    }

    var body: some View {
        ZStack {
            Color.surfaceTerminal.opacity(0.92)
            HStack(spacing: Spacing.x2) {
                ProgressView()
                    .controlSize(.small)
                    .progressViewStyle(.circular)
                Text(title)
                    .font(.plexMono(12, weight: .medium))
                    .foregroundStyle(Color.terminalInk)
                AnimatedEllipsis(color: .terminalMutedInk, reduceMotion: reduceMotion)
            }
            .padding(.horizontal, Spacing.x4)
            .padding(.vertical, Spacing.x3)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(Color.black.opacity(0.28))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
            )
        }
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

        // OPERATOR look: deep terminal surface + phosphor ink.
        // Background/foreground are applied before font so resetFont() sees the right colors.
        view.nativeBackgroundColor = NSColor(Color.surfaceTerminal)
        view.nativeForegroundColor = NSColor(Color.terminalInk)

        // Phosphor amber block cursor — matches the OPERATOR ember accent (#D06F25).
        view.caretColor = NSColor(red: 0.816, green: 0.435, blue: 0.145, alpha: 0.9)

        // Dim phosphor selection tint so highlighted text stays readable on the dark surface.
        view.selectedTextBackgroundColor = NSColor(
            red: 0.816, green: 0.435, blue: 0.145, alpha: 0.28
        )

        // Set font after colors so the initial display uses the right palette.
        view.font = Self.terminalFont(size: Self.terminalFontSize)

        // Install the output sink so future server `output` events feed SwiftTerm.
        // We feed raw PTY bytes; SwiftTerm's VT100/xterm parser handles all ANSI/OSC
        // sequences (including zellij's box-drawing borders) correctly.
        session.setOutputSink { [weak view] text in
            view?.feed(text: text)
        }
        session.onNextAttach { [weak view] in
            TerminalFocusPolicy.scheduleAttachedFocus(for: view)
        }

        // Do NOT report size on a zero-frame view; the real resize fires via
        // sizeChanged(source:newCols:newRows:) once the view is laid out.
        // Calling session.start() here triggers the WS connect; the first
        // attached + resize handshake then uses the real frame dimensions.
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

    /// Target font size for the terminal surface (OPERATOR spec: Plex Mono 13).
    /// Slightly larger than the previous 12.5 for better legibility on Retina.
    static let terminalFontSize: CGFloat = 13.0

    /// Resolves the best available monospaced font for terminal rendering.
    ///
    /// Priority:
    ///  1. IBM Plex Mono — the OPERATOR design font (bundled or user-installed).
    ///  2. Menlo — always present on macOS; excellent monospace legibility.
    ///  3. Courier New — universal fallback.
    ///  4. System monospaced — last resort.
    ///
    /// Nerd Font variants are intentionally excluded: they are almost never
    /// installed on a standard macOS machine, and falling through the entire list
    /// on every view creation adds measurable startup latency. If the user wants
    /// Nerd Font glyphs they can set the font via a future preferences surface.
    private static func terminalFont(size: CGFloat) -> NSFont {
        let preferredFamilies: [String] = [
            // Nerd Fonts first so zellij powerline/glyph icons render when installed.
            "MesloLGS NF",
            "MesloLGS Nerd Font Mono",
            "JetBrainsMono Nerd Font",
            "Hack Nerd Font",
            "IBMPlexMono",
            "IBM Plex Mono",
            "Menlo",
            "Courier New",
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
        // Clamp to [1, 500] on both axes (mirrors the SlayZone/xterm safety clamp).
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            let clampedCols = max(1, min(500, newCols))
            let clampedRows = max(1, min(500, newRows))
            let session = self.session
            MainActor.assumeIsolated { session.resize(cols: clampedCols, rows: clampedRows) }
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
    static let attachedFocusRetryDelays: [TimeInterval] = [0, 0.05, 0.15]

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
    static func scheduleAttachedFocus(for view: TerminalView?) {
        for delay in attachedFocusRetryDelays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak view] in
                Task { @MainActor in
                    _ = requestFocus(view, mode: .userInitiated)
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
