// Matrix OS — native macOS app entrypoint (Phase 1 scaffold).
//
// Minimal SwiftUI `App` hosting a placeholder board-shell view. Real board/terminal/panel
// implementation lands in later phases (see specs/086-macos-native-shell/tasks.md). This
// file exists so the package builds headlessly via `swift build` and the OPERATOR design
// tokens render in a window.

import SwiftUI
import DesignSystem

@main
struct MatrixOSApp: App {
    var body: some Scene {
        WindowGroup("Matrix OS") {
            BoardShellScaffold()
                .frame(minWidth: 960, minHeight: 600)
        }
        .windowStyle(.titleBar)
    }
}

/// Placeholder board-shell: a row of lifecycle columns rendered with OPERATOR tokens so the
/// design system is exercised end-to-end. Replaced by the real `BoardView` in Phase 3 (US1).
struct BoardShellScaffold: View {
    private let columns = ["TODO", "RUNNING", "WAITING", "BLOCKED", "COMPLETE"]

    var body: some View {
        ZStack {
            Color.canvasVoid.ignoresSafeArea()

            VStack(alignment: .leading, spacing: Spacing.x5) {
                header
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: Spacing.x4) {
                        ForEach(columns, id: \.self) { column in
                            ColumnScaffold(title: column)
                        }
                    }
                    .padding(.horizontal, Spacing.x5)
                }
            }
            .padding(.vertical, Spacing.x5)
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.x3) {
            Circle()
                .fill(Color.signalLive)
                .frame(width: 8, height: 8)
            Text("MATRIX OS — OPERATOR")
                .font(.plexMono(11, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(Color.inkSecondary)
            Spacer()
        }
        .padding(.horizontal, Spacing.x5)
    }
}

/// A single empty lifecycle column rendered with OPERATOR surfaces, hairlines, and spacing.
private struct ColumnScaffold: View {
    let title: String

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.x3) {
            Text(title)
                .font(.plexMono(11, weight: .semibold))
                .tracking(1.4)
                .foregroundStyle(Color.inkTertiary)
                .padding(.bottom, Spacing.x1)

            EmptyColumnPlaceholder()
        }
        .padding(Spacing.x3)
        .frame(width: 240, alignment: .leading)
        .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card)
                .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
        )
    }
}

private struct EmptyColumnPlaceholder: View {
    var body: some View {
        RoundedRectangle(cornerRadius: Radius.control)
            .strokeBorder(
                Color.inkDisabled,
                style: StrokeStyle(lineWidth: 1, dash: [4, 4])
            )
            .frame(height: 64)
            .overlay(
                Text("Drop a task here or ⌘N")
                    .font(.plexSans(13))
                    .foregroundStyle(Color.inkTertiary)
            )
    }
}
