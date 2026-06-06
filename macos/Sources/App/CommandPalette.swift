// Matrix OS — ⌘K command palette.
//
// A centered overlay (toggled by `model.showCommandPalette`) with a search field
// and a filtered list of actions. Type to filter, ↑/↓ to move, Enter to run,
// Esc to close. Linear/SlayZone-grade: keyboard-first, no mouse required.
//
// Presented as an overlay in `RootShellView` (Workspace.swift). All styling
// references DesignSystem tokens only.
#if os(macOS)
import SwiftUI
import DesignSystem
import MatrixModel

/// A single runnable action in the palette.
struct PaletteAction: Identifiable {
    let id: String
    let title: String
    let symbol: String
    let run: () -> Void
}

/// The ⌘K command palette overlay. Owns its own query/selection state; closing
/// is driven through `model.showCommandPalette` so the menu shortcut can toggle it.
struct CommandPalette: View {
    @ObservedObject var model: AppModel
    @State private var query = ""
    @State private var selection = 0
    @FocusState private var fieldFocused: Bool

    /// Static action catalog. Closures capture `model`; project actions open the
    /// picker by routing through the rail menu via `showCommandPalette` dismissal
    /// plus a direct create call.
    private var allActions: [PaletteAction] {
        [
            PaletteAction(id: "new-task", title: "New task", symbol: "plus.rectangle") {
                model.createTask(status: .todo)
            },
            PaletteAction(id: "new-session", title: "New session", symbol: "terminal") {
                model.createSession()
            },
            PaletteAction(id: "go-board", title: "Switch to Board", symbol: "rectangle.split.3x1") {
                model.section = .board
            },
            PaletteAction(id: "go-shell", title: "Switch to Shell", symbol: "terminal.fill") {
                model.section = .shell
            },
        ] + projectActions
    }

    /// One "Open <project>" action per known project, so projects are switchable
    /// straight from the palette without leaving the keyboard.
    private var projectActions: [PaletteAction] {
        model.projects.map { project in
            PaletteAction(id: "open-\(project.slug)", title: "Open project: \(project.name)", symbol: "folder") {
                model.openProject(slug: project.slug)
            }
        }
    }

    private var filtered: [PaletteAction] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return allActions }
        return allActions.filter { $0.title.lowercased().contains(q) }
    }

    var body: some View {
        ZStack(alignment: .top) {
            // Scrim — click to dismiss.
            Color.black.opacity(0.35)
                .ignoresSafeArea()
                .onTapGesture { close() }

            palette
                .padding(.top, 120)
        }
        .onAppear { fieldFocused = true; selection = 0 }
        .onChange(of: query) { _, _ in selection = 0 }
        .onKeyPress(.downArrow) { moveSelection(1); return .handled }
        .onKeyPress(.upArrow) { moveSelection(-1); return .handled }
        .onKeyPress(.escape) { close(); return .handled }
    }

    private func moveSelection(_ delta: Int) {
        let count = filtered.count
        guard count > 0 else { return }
        selection = (selection + delta + count) % count
    }

    private var palette: some View {
        VStack(spacing: 0) {
            searchField
            Rectangle().fill(Color.hairlineDark).frame(height: 1)
            resultList
        }
        .frame(width: 560)
        .background(
            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                .fill(Color.surfaceCard)
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                        .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .shadow(color: .black.opacity(0.5), radius: 30, y: 12)
    }

    private var searchField: some View {
        HStack(spacing: Spacing.x3) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.inkTertiary)
            TextField("Type a command…", text: $query)
                .textFieldStyle(.plain)
                .font(.plexSans(15))
                .foregroundStyle(Color.inkPrimary)
                .focused($fieldFocused)
                .onSubmit(runSelected)
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.vertical, Spacing.x4)
    }

    @ViewBuilder
    private var resultList: some View {
        if filtered.isEmpty {
            Text("No matching commands")
                .font(.plexSans(13))
                .foregroundStyle(Color.inkTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Spacing.x4)
        } else {
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(Array(filtered.enumerated()), id: \.element.id) { index, action in
                        row(action, active: index == selection)
                            .onTapGesture { run(action) }
                            .onHover { if $0 { selection = index } }
                    }
                }
                .padding(Spacing.x2)
            }
            .frame(maxHeight: 320)
        }
    }

    private func row(_ action: PaletteAction, active: Bool) -> some View {
        HStack(spacing: Spacing.x3) {
            Image(systemName: action.symbol)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(active ? Color.signalLive : Color.inkTertiary)
                .frame(width: 18)
            Text(action.title)
                .font(.plexSans(14))
                .foregroundStyle(Color.inkPrimary)
            Spacer()
        }
        .padding(.horizontal, Spacing.x3)
        .padding(.vertical, Spacing.x2)
        .background(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .fill(active ? Color.surfaceCardRaised : Color.clear)
        )
        .contentShape(Rectangle())
    }

    // MARK: - Actions

    private func runSelected() {
        guard filtered.indices.contains(selection) else { return }
        run(filtered[selection])
    }

    private func run(_ action: PaletteAction) {
        action.run()
        close()
    }

    private func close() {
        query = ""
        model.showCommandPalette = false
    }
}
#endif
