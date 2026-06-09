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
    /// Board zoom (Conductor-style). ⌘+/⌘-/⌘0 and pinch.
    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    private static let minZoom: CGFloat = 0.5
    private static let maxZoom: CGFloat = 1.6
    private func clampZoom(_ z: CGFloat) -> CGFloat { min(max(z, Self.minZoom), Self.maxZoom) }

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
                onSignIn: { model.beginSignIn(mode: .signIn) },
                onCancelSignIn: { model.cancelSignIn() },
                signIn: model.signIn
            )
        case .connecting:
            BoardSkeletonView()
        case .ready, .disconnected:
            if model.hasSelectedProject {
                boardWithDetail
            } else {
                ProjectSelectionRequiredView(model: model)
            }
        }
    }

    // MARK: - Board + detail split

    private var boardWithDetail: some View {
        VStack(spacing: 0) {
            if model.phase == .disconnected {
                ReconnectingBar(handle: model.profile?.handle ?? "your computer")
            }
            if let error = model.openError {
                GenericErrorBanner(message: error.message, onRetry: {
                    Task { await model.refresh() }
                })
            }
            if activeDetailCard != nil {
                detailPane
            } else {
                columns
                    .opacity(model.phase == .disconnected ? 0.7 : 1)
                    .saturation(model.phase == .disconnected ? 0.6 : 1)
                    .allowsHitTesting(model.phase != .disconnected)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var hasTaskDetail: Bool {
        guard let activeID = model.activeTabID,
              let tab = model.openTabs.first(where: { $0.id == activeID }) else {
            return model.selectedCard != nil
        }
        return tab.kind == .task || tab.kind == .session || model.selectedCard != nil
    }

    private var columns: some View {
        // Five lifecycle lanes live in a real horizontal scroll surface so the
        // board remains usable beside the detail terminal on laptop widths.
        // Pinch / ⌘+/⌘-/⌘0 scale the lanes (Conductor-style zoom).
        let effectiveZoom = clampZoom(zoom * pinch)
        let laneWidth: CGFloat = 280
        let columnsToRender = model.filteredBoardColumns(matching: model.workspaceSearchQuery)
        let unscaledWidth = laneWidth * CGFloat(columnsToRender.count)
        return ScrollView(.horizontal, showsIndicators: true) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(columnsToRender) { column in
                    ColumnView(
                        column: column,
                        selectedCardID: selectedBoardCard?.id,
                        onOpenCard: openCard,
                        onAddCard: { model.createTask(status: $0) },
                        onMoveCard: { id, status in
                            model.updateTaskStatus(cardId: id, to: status, order: nil)
                        }
                    )
                    .frame(width: laneWidth)
                }
            }
            .frame(width: unscaledWidth, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .scaleEffect(effectiveZoom, anchor: .topLeading)
            .frame(width: unscaledWidth * effectiveZoom, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .gesture(
            MagnificationGesture()
                .updating($pinch) { value, state, _ in state = value }
                .onEnded { value in zoom = clampZoom(zoom * value) }
        )
        .background(zoomShortcuts)
        .animation(Motion.columnReflow, value: effectiveZoom)
    }

    /// Hidden buttons providing ⌘+/⌘-/⌘0 zoom shortcuts.
    private var zoomShortcuts: some View {
        ZStack {
            Button("") { zoom = clampZoom(zoom + 0.1) }
                .keyboardShortcut("=", modifiers: .command)
            Button("") { zoom = clampZoom(zoom - 0.1) }
                .keyboardShortcut("-", modifiers: .command)
            Button("") { zoom = 1 }
                .keyboardShortcut("0", modifiers: .command)
        }
        .opacity(0)
        .allowsHitTesting(false)
    }

    // MARK: - Detail pane (workspace tabs + terminal)

    private var selectedBoardCard: Card? {
        guard let selected = model.selectedCard else { return nil }
        return model.board.columns
            .flatMap(\.cards)
            .first { $0.id == selected.id }
    }

    private var activeDetailCard: Card? {
        selectedBoardCard ?? model.selectedCard
    }

    private var detailPane: some View {
        VStack(spacing: 0) {
            detailHeader
            Divider().overlay(Color.hairlineDark)
            TaskPaneStrip(
                activePanel: model.activePanel,
                enabledPanels: model.enabledPanels,
                onFocus: model.switchPanel
            )
            Divider().overlay(Color.hairlineDark)
            enabledPanelBody
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.surfaceRail)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.hairlineDark).frame(width: 1)
        }
    }

    private var detailHeader: some View {
        HStack {
            Text(activeDetailCard?.title ?? "Task")
                .font(.plexSans(13, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
                .lineLimit(1)
            Spacer()
            Button(action: model.closeCard) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.inkTertiary)
                    .iconHitTarget(30)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.vertical, Spacing.x2)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var enabledPanelBody: some View {
        let panes = taskPaneSpecs.filter { model.enabledPanels.contains($0.panel) }
        let active = model.enabledPanels.contains(model.activePanel) ? model.activePanel : panes.first?.panel
        if let active {
            panelBody(for: active)
        } else {
            placeholderPane("Choose a task pane to continue.")
        }
    }

    @ViewBuilder
    private func panelBody(for panel: Panel) -> some View {
        switch panel {
        case .terminal:
            boardTerminalSurface
        case .shell:
            MatrixWebShellPanel(model: model, url: model.shellURL(), title: "Matrix OS Shell")
        case .app(let slug):
            switch slug {
            case "editor":
                EditorPanel(model: model)
            case "artifacts":
                ArtifactsPanel(model: model)
            case "git":
                GitPanel(model: model)
            case "settings":
                NativeSettingsPanel(model: model)
            case "processes":
                ProcessesPanel(model: model)
            case "whiteboard":
                MatrixWebShellPanel(model: model, url: model.appURL(slug: "whiteboard"), title: "Excalidraw")
            default:
                placeholderPane("This task pane is not available yet.")
            }
        }
    }

    @ViewBuilder
    private var boardTerminalSurface: some View {
        if let terminal = model.terminal {
            TerminalPanelView(session: terminal)
                .id(terminal.id)
                .background(Color.surfaceTerminal)
        } else {
            placeholderPane("Open a task to attach its agent terminal.")
        }
    }

    private func placeholderPane(_ text: String) -> some View {
        VStack {
            Spacer()
            VStack(spacing: Spacing.x2) {
                Image(systemName: "macwindow")
                    .font(.system(size: 26, weight: .light))
                    .foregroundStyle(Color.terminalMutedInk)
                Text(text)
                    .font(.plexSans(13))
                    .foregroundStyle(Color.terminalMutedInk)
            }
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
                if model.hasSelectedProject {
                    ProjectAvatarIcon(
                        name: model.activeProjectName,
                        slug: model.projectSlug,
                        isActive: true,
                        size: 24
                    )
                    VStack(alignment: .leading, spacing: 1) {
                        Text(model.activeProjectName)
                            .font(.plexSans(12, weight: .semibold))
                            .foregroundStyle(Color.inkPrimary)
                        Text("Kanban")
                            .font(.plexSans(10, weight: .medium))
                            .foregroundStyle(Color.inkTertiary)
                    }
                } else {
                    Circle().fill(Color.signalLive).frame(width: 7, height: 7)
                    Text("Matrix OS")
                        .font(.plexSans(12, weight: .semibold))
                        .foregroundStyle(Color.inkSecondary)
                }
            }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                Task { await model.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help(model.hasSelectedProject ? "Refresh board" : "Refresh Matrix")

            if model.hasSelectedProject {
                Divider()

                Button {
                    zoom = clampZoom(zoom - 0.1)
                } label: {
                    Image(systemName: "minus.magnifyingglass")
                }
                .help("Zoom out (⌘-)")

                Button {
                    zoom = 1
                } label: {
                    Text("\(Int(zoom * 100))%")
                        .font(.plexMono(11, weight: .medium))
                }
                .help("Reset board scale (⌘0)")

                Button {
                    zoom = clampZoom(zoom + 0.1)
                } label: {
                    Image(systemName: "plus.magnifyingglass")
                }
                .help("Zoom in (⌘=)")
            }
        }
    }

    // MARK: - Actions

    private func openCard(_ card: Card) {
        Task { try? await model.openCard(card) }
    }

    private func openCreateFlow() {
        model.beginSignIn(mode: .signUp)
    }
}

#endif
