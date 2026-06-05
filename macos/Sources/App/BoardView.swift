// Matrix OS — board surface + detail pane (US1 / T033).
//
// Renders the BoardStore's 5 OPERATOR lifecycle columns in a horizontal scroll.
// Selecting a card opens a detail pane that shows the attached TerminalPanelView
// (T035 wiring). Disconnected → an amber reconnecting bar over a read-only board.
// All errors are generic (FR-023). Tokens only — no inline hex/sizes.
#if os(macOS)
import SwiftUI
import DesignSystem
import MatrixBoard
import MatrixModel
import MatrixTerminal

struct BoardView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack {
            Color.canvasVoid.ignoresSafeArea()
            content
        }
        .toolbar { toolbarContent }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .needsProfile:
            NoProfileView(
                onCreate: openCreateFlow,
                onSignIn: { model.beginSignIn() },
                onCancelSignIn: { model.cancelSignIn() },
                signIn: model.signIn
            )
        case .connecting:
            BoardSkeletonView()
        case .ready, .disconnected:
            boardWithDetail
        }
    }

    // MARK: - Board + detail split

    private var boardWithDetail: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                if model.phase == .disconnected {
                    ReconnectingBar(handle: model.profile?.handle ?? "your computer")
                }
                if let error = model.openError {
                    GenericErrorBanner(message: error.message, onRetry: nil)
                }
                columns
                    .opacity(model.phase == .disconnected ? 0.7 : 1)
                    .saturation(model.phase == .disconnected ? 0.6 : 1)
                    .allowsHitTesting(model.phase != .disconnected)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            if model.selectedCard != nil {
                detailPane
                    .frame(width: 520)
                    .transition(.move(edge: .trailing))
            }
        }
        .animation(Motion.panelSwitch, value: model.selectedCard?.id)
    }

    private var columns: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(model.board.columns) { column in
                    ColumnView(
                        column: column,
                        selectedCardID: model.selectedCard?.id,
                        onOpenCard: openCard
                    )
                    .frame(maxHeight: .infinity, alignment: .top)
                }
            }
        }
    }

    // MARK: - Detail pane (panel switcher + terminal)

    private var detailPane: some View {
        VStack(spacing: 0) {
            detailHeader
            Divider().overlay(Color.hairlineDark)
            panelBody
        }
        .background(Color.surfaceRail)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.hairlineDark).frame(width: 1)
        }
    }

    private var detailHeader: some View {
        HStack(spacing: Spacing.x3) {
            Text(model.selectedCard?.title ?? "")
                .font(.plexSans(14, weight: .medium))
                .foregroundStyle(Color.inkPrimary)
                .lineLimit(1)
            Spacer()
            PanelSwitcher(active: model.activePanel) { model.switchPanel($0) }
            Button(action: model.closeCard) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.inkTertiary)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.vertical, Spacing.x3)
    }

    @ViewBuilder
    private var panelBody: some View {
        switch model.activePanel {
        case .terminal:
            if let terminal = model.terminal {
                TerminalPanelView(session: terminal)
                    .padding(Spacing.x3)
            } else {
                placeholderPane("No live session for this card.")
            }
        case .shell:
            placeholderPane("Shell view — coming soon.")
        case .app:
            placeholderPane("App view — coming soon.")
        }
    }

    private func placeholderPane(_ text: String) -> some View {
        VStack {
            Spacer()
            Text(text)
                .font(.plexSans(13))
                .foregroundStyle(Color.inkTertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.surfaceTerminal)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            HStack(spacing: Spacing.x2) {
                Circle().fill(Color.signalLive).frame(width: 7, height: 7)
                Text("OPERATOR")
                    .font(.plexMono(11, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(Color.inkSecondary)
            }
        }
    }

    // MARK: - Actions

    private func openCard(_ card: Card) {
        Task { try? await model.openCard(card) }
    }

    private func openCreateFlow() {
        // Hand off to the platform onboarding flow. In US1 this opens the web flow.
        if let url = URL(string: "https://app.matrix-os.com/runtime") {
            NSWorkspace.shared.open(url)
        }
    }
}

/// Segmented Terminal · Shell · App switcher (design.md §6.5). Active segment
/// carries a thin signal underline + ink.primary; inactive is ink.tertiary.
struct PanelSwitcher: View {
    let active: Panel
    let onSelect: (Panel) -> Void

    var body: some View {
        HStack(spacing: 0) {
            segment("Terminal", panel: .terminal, isActive: active == .terminal)
            segment("Shell", panel: .shell, isActive: active == .shell)
            segment("App", panel: .app(slug: ""), isActive: isApp)
        }
        .padding(2)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
        )
    }

    private var isApp: Bool {
        if case .app = active { return true }
        return false
    }

    private func segment(_ label: String, panel: Panel, isActive: Bool) -> some View {
        Button {
            onSelect(panel)
        } label: {
            VStack(spacing: 2) {
                Text(label)
                    .font(.plexMono(10, weight: isActive ? .semibold : .regular))
                    .foregroundStyle(isActive ? Color.inkPrimary : Color.inkTertiary)
                Rectangle()
                    .fill(isActive ? Color.signalLive : Color.clear)
                    .frame(height: 1.5)
            }
            .padding(.horizontal, Spacing.x2)
            .padding(.vertical, 3)
        }
        .buttonStyle(.plain)
    }
}
#endif
