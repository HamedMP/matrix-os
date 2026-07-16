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
    @State private var taskEditor: TaskEditorState?
    @State private var pendingDeleteCard: Card?
    @State private var editingDetailTitle: String?
    @FocusState private var detailTitleFocused: Bool
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
        .sheet(item: $taskEditor) { editor in
            TaskEditorSheet(
                state: editor,
                onCancel: { taskEditor = nil },
                onSave: saveTaskEditor
            )
        }
        .confirmationDialog(
            "Delete task?",
            isPresented: Binding(
                get: { pendingDeleteCard != nil },
                set: { if !$0 { pendingDeleteCard = nil } }
            ),
            presenting: pendingDeleteCard
        ) { card in
            Button("Delete \(card.title)", role: .destructive) {
                model.deleteTask(cardId: card.id)
                pendingDeleteCard = nil
            }
        } message: { card in
            Text("This removes \(card.title) from the project task board.")
        }
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
                        onAddCard: { taskEditor = TaskEditorState(createIn: $0) },
                        onEditCard: { taskEditor = TaskEditorState(editing: $0) },
                        onArchiveCard: { model.archiveTask(cardId: $0.id) },
                        onDeleteCard: { pendingDeleteCard = $0 },
                        onSetCardStatus: { card, status in
                            model.updateTask(cardId: card.id, status: status)
                        },
                        onSetCardPriority: { card, priority in
                            model.updateTask(cardId: card.id, priority: priority)
                        },
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

    private func saveTaskEditor(_ state: TaskEditorState) {
        if let cardId = state.cardId {
            model.updateTask(
                cardId: cardId,
                title: state.title,
                description: state.description,
                status: state.status,
                priority: state.priority
            )
        } else {
            model.createTask(
                title: state.title,
                description: state.description,
                status: state.status,
                priority: state.priority
            )
        }
        taskEditor = nil
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
                onToggle: model.togglePanel,
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
        HStack(spacing: Spacing.x2) {
            if let card = activeDetailCard {
                detailTitleControl(card)
            } else {
                Text("Task")
                    .font(.plexSans(13, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                    .lineLimit(1)
            }
            Spacer()
            if let card = activeDetailCard {
                detailSettingsMenu(card)
            }
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
    private func detailTitleControl(_ card: Card) -> some View {
        if editingDetailTitle != nil {
            TextField("Task title", text: Binding(
                get: { editingDetailTitle ?? card.title },
                set: { editingDetailTitle = $0 }
            ))
            .textFieldStyle(.plain)
            .font(.plexSans(13, weight: .semibold))
            .foregroundStyle(Color.inkPrimary)
            .focused($detailTitleFocused)
            .onSubmit { commitDetailTitle(card) }
            .onExitCommand { editingDetailTitle = nil }
            .frame(minWidth: 160, maxWidth: 420, alignment: .leading)
        } else {
            Button {
                editingDetailTitle = card.title
                DispatchQueue.main.async { detailTitleFocused = true }
            } label: {
                HStack(spacing: Spacing.x1) {
                    Text(card.title)
                        .font(.plexSans(13, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                        .lineLimit(1)
                    Image(systemName: "pencil")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.inkTertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Rename task")
        }
    }

    private func detailSettingsMenu(_ card: Card) -> some View {
        Menu {
            Button("Edit Task") { taskEditor = TaskEditorState(editing: card) }
            Divider()
            Menu("Status") {
                ForEach(TaskStatus.allCases, id: \.self) { status in
                    Button(status.displayTitle) {
                        model.updateTask(cardId: card.id, status: status)
                    }
                }
            }
            Menu("Priority") {
                ForEach(TaskPriority.allCases, id: \.self) { priority in
                    Button(priority.displayTitle) {
                        model.updateTask(cardId: card.id, priority: priority)
                    }
                }
            }
            Menu("Tags") {
                Button("Tags are not persisted yet") {}
                    .disabled(true)
            }
            Button("Blocked") {
                model.updateTask(cardId: card.id, status: .blocked)
            }
            Menu("Blocked by") {
                Button("Dependency links are not persisted yet") {}
                    .disabled(true)
            }
            Menu("Snooze") {
                Button("Snooze is not persisted yet") {}
                    .disabled(true)
            }
            Divider()
            Menu("Move to") {
                ForEach(TaskStatus.allCases, id: \.self) { status in
                    Button(status.displayTitle) {
                        model.updateTask(cardId: card.id, status: status)
                    }
                }
            }
            Button("Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(card.id, forType: .string)
            }
            Divider()
            Button("Archive") { model.archiveTask(cardId: card.id) }
            Button("Delete", role: .destructive) { pendingDeleteCard = card }
        } label: {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.inkTertiary)
                .iconHitTarget(30)
        }
        .menuStyle(.borderlessButton)
        .buttonStyle(.plain)
        .help("Task settings")
    }

    private func commitDetailTitle(_ card: Card) {
        let nextTitle = editingDetailTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        editingDetailTitle = nil
        guard !nextTitle.isEmpty, nextTitle != card.title else { return }
        model.updateTask(cardId: card.id, title: nextTitle)
    }

    @ViewBuilder
    private var enabledPanelBody: some View {
        let panes = taskPaneSpecs.filter { model.enabledPanels.contains($0.panel) }
        if panes.isEmpty {
            placeholderPane("Choose a task pane to continue.")
        } else if panes.count == 1, let pane = panes.first {
            panelBody(for: pane.panel)
        } else {
            HSplitView {
                ForEach(panes) { pane in
                    taskPaneContainer(pane)
                        .frame(minWidth: paneMinimumWidth(pane.panel), maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }

    private func taskPaneContainer(_ pane: TaskPaneSpec) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: Spacing.x2) {
                Label(pane.title, systemImage: pane.icon)
                    .font(.plexSans(12, weight: .semibold))
                    .foregroundStyle(pane.panel == model.activePanel ? Color.inkPrimary : Color.inkSecondary)
                Spacer()
                Text(pane.shortcut)
                    .font(.plexMono(10))
                    .foregroundStyle(Color.inkTertiary)
                Button {
                    model.togglePanel(pane.panel)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.inkTertiary)
                        .iconHitTarget(24)
                }
                .buttonStyle(.plain)
                .disabled(model.enabledPanels.count <= 1)
                .help("Close pane")
            }
            .padding(.horizontal, Spacing.x3)
            .frame(height: 34)
            .background(pane.panel == model.activePanel ? Color.surfaceCardRaised : Color.surfaceRail)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(pane.panel == model.activePanel ? Color.signalLive.opacity(0.65) : Color.hairlineDark)
                    .frame(height: 1)
            }
            .contentShape(Rectangle())
            .onTapGesture { model.switchPanel(pane.panel) }
            panelBody(for: pane.panel)
        }
    }

    private func paneMinimumWidth(_ panel: Panel) -> CGFloat {
        switch panel {
        case .terminal:
            return 360
        case .shell:
            return 420
        case .app(let slug):
            switch slug {
            case "settings", "processes":
                return 380
            case "editor", "git":
                return 460
            default:
                return 340
            }
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

private struct TaskEditorState: Identifiable {
    let id: String
    let cardId: String?
    var title: String
    var description: String
    var status: TaskStatus
    var priority: TaskPriority

    init(createIn status: TaskStatus) {
        self.id = "create:\(status.rawValue)"
        self.cardId = nil
        self.title = ""
        self.description = ""
        self.status = status
        self.priority = .normal
    }

    init(editing card: Card) {
        self.id = "edit:\(card.id)"
        self.cardId = card.id
        self.title = card.title
        self.description = card.description ?? ""
        self.status = card.status
        self.priority = card.priority
    }

    var isCreating: Bool { cardId == nil }
}

private struct TaskEditorSheet: View {
    @State var state: TaskEditorState
    let onCancel: () -> Void
    let onSave: (TaskEditorState) -> Void
    @FocusState private var titleFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.x4) {
            HStack {
                Text(state.isCreating ? "Create Task" : "Edit Task")
                    .font(.plexSans(22, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Spacer()
                Button(action: onCancel) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.inkTertiary)
                        .iconHitTarget(30)
                }
                .buttonStyle(.plain)
            }

            VStack(alignment: .leading, spacing: Spacing.x2) {
                Text("Title")
                    .font(.plexSans(12, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                TextField("Task title", text: $state.title)
                    .textFieldStyle(.roundedBorder)
                    .font(.plexSans(15))
                    .focused($titleFocused)
                    .onSubmit(commit)
            }

            VStack(alignment: .leading, spacing: Spacing.x2) {
                Text("Description")
                    .font(.plexSans(12, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                TextEditor(text: $state.description)
                    .font(.plexSans(13))
                    .frame(height: 86)
                    .scrollContentBackground(.hidden)
                    .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            .strokeBorder(Color.hairlineDark.opacity(0.65), lineWidth: 1)
                    )
            }

            HStack(spacing: Spacing.x3) {
                Picker("Status", selection: $state.status) {
                    ForEach(TaskStatus.allCases, id: \.self) { status in
                        Text(status.displayTitle).tag(status)
                    }
                }
                Picker("Priority", selection: $state.priority) {
                    ForEach(TaskPriority.allCases, id: \.self) { priority in
                        Text(priority.displayTitle).tag(priority)
                    }
                }
            }

            VStack(alignment: .leading, spacing: Spacing.x2) {
                disabledSettingRow(icon: "calendar", title: "Due date", value: "Not synced yet")
                disabledSettingRow(icon: "tag", title: "Tags", value: "Not synced yet")
                disabledSettingRow(icon: "folder", title: "Project", value: "Current project")
            }

            HStack {
                Button("Cancel", action: onCancel)
                Spacer()
                Button(state.isCreating ? "Create" : "Save", action: commit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(state.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(Spacing.x5)
        .frame(width: 520)
        .onAppear {
            DispatchQueue.main.async { titleFocused = true }
        }
    }

    private func disabledSettingRow(icon: String, title: String, value: String) -> some View {
        HStack(spacing: Spacing.x2) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.inkTertiary)
                .frame(width: 18)
            Text(title)
                .font(.plexSans(12, weight: .semibold))
                .foregroundStyle(Color.inkSecondary)
            Spacer()
            Text(value)
                .font(.plexSans(12, weight: .medium))
                .foregroundStyle(Color.inkTertiary)
        }
        .padding(.horizontal, Spacing.x3)
        .frame(height: 32)
        .background(Color.surfaceRail.opacity(0.8), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }

    private func commit() {
        guard !state.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        onSave(state)
    }
}

private extension TaskStatus {
    var displayTitle: String {
        switch self {
        case .todo: return "Backlog"
        case .running: return "Running"
        case .waiting: return "Waiting"
        case .blocked: return "Blocked"
        case .complete: return "Complete"
        case .archived: return "Archived"
        }
    }
}

private extension TaskPriority {
    var displayTitle: String {
        switch self {
        case .low: return "Low"
        case .normal: return "Medium"
        case .high: return "High"
        case .urgent: return "Urgent"
        }
    }
}

#endif
