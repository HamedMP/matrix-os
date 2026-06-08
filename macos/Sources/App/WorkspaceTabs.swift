#if os(macOS)
import SwiftUI
import DesignSystem
import MatrixModel

struct WorkspaceTabStrip: View {
    let tabs: [WorkspaceTab]
    let activeID: String?
    let isCreating: Bool
    let onSelect: (String) -> Void
    let onClose: (String) -> Void
    let onCreate: () -> Void

    var body: some View {
        HStack(spacing: Spacing.x1) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.x1) {
                    ForEach(tabs) { tab in
                        WorkspaceTabPill(
                            tab: tab,
                            isActive: tab.id == activeID,
                            onSelect: { onSelect(tab.id) },
                            onClose: { onClose(tab.id) }
                        )
                    }
                }
                .padding(.leading, Spacing.x2)
                .padding(.vertical, Spacing.x1)
            }
            Button(action: onCreate) {
                Image(systemName: "plus")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.inkSecondary)
                    .iconHitTarget(34)
                    .background(Color.surfaceCardRaised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isCreating)
            .help("New tab")
            .padding(.trailing, Spacing.x2)
        }
        .frame(height: 42)
        .background(Color.surfaceCard)
        .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                .strokeBorder(Color.hairlineDark.opacity(0.65), lineWidth: 1)
        )
    }
}

struct TaskPaneSpec: Identifiable, Equatable {
    let id: String
    let title: String
    let icon: String
    let shortcut: String
    let panel: Panel
}

let taskPaneSpecs: [TaskPaneSpec] = [
    TaskPaneSpec(id: "terminal", title: "Terminal", icon: "terminal", shortcut: "⌘T", panel: .terminal),
    TaskPaneSpec(id: "editor", title: "Editor", icon: "doc.text", shortcut: "⌘E", panel: .app(slug: "editor")),
    TaskPaneSpec(id: "artifacts", title: "Artifacts", icon: "paperclip", shortcut: "⌘⇧A", panel: .app(slug: "artifacts")),
    TaskPaneSpec(id: "git", title: "Git", icon: "arrow.triangle.branch", shortcut: "⌘G", panel: .app(slug: "git")),
    TaskPaneSpec(id: "settings", title: "Settings", icon: "slider.horizontal.3", shortcut: "⌘J", panel: .app(slug: "settings")),
    TaskPaneSpec(id: "processes", title: "Processes", icon: "cpu", shortcut: "⌘⇧P", panel: .app(slug: "processes")),
    TaskPaneSpec(id: "whiteboard", title: "Excalidraw", icon: "scribble.variable", shortcut: "⌘X", panel: .app(slug: "whiteboard")),
]

struct TaskPaneStrip: View {
    let activePanel: Panel
    let enabledPanels: [Panel]
    let onToggle: (Panel) -> Void
    let onFocus: (Panel) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.x1) {
                ForEach(taskPaneSpecs) { pane in
                    TaskPaneButton(
                        pane: pane,
                        isActive: enabledPanels.contains(pane.panel),
                        isFocused: pane.panel == activePanel,
                        action: { onToggle(pane.panel) }
                    )
                    .keyboardShortcut(shortcutKey(for: pane.id), modifiers: shortcutModifiers(for: pane.id))
                    .contextMenu {
                        Button("Focus \(pane.title)") { onFocus(pane.panel) }
                    }
                }
            }
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, Spacing.x3)
            .padding(.vertical, Spacing.x1)
        }
        .frame(height: 38)
        .background(Color.surfaceRail)
    }

    private func shortcutKey(for id: String) -> KeyEquivalent {
        switch id {
        case "terminal": return "t"
        case "editor": return "e"
        case "artifacts": return "a"
        case "git": return "g"
        case "settings": return "j"
        case "processes": return "p"
        case "whiteboard": return "x"
        default: return "0"
        }
    }

    private func shortcutModifiers(for id: String) -> EventModifiers {
        ["artifacts", "processes"].contains(id) ? [.command, .shift] : [.command]
    }
}

private struct TaskPaneButton: View {
    let pane: TaskPaneSpec
    let isActive: Bool
    let isFocused: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.x1) {
                Image(systemName: isActive ? "checkmark.square.fill" : "square")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isActive ? Color.signalLive : Color.inkTertiary)
                Image(systemName: pane.icon)
                    .font(.system(size: 12, weight: .semibold))
                Text(pane.title)
                    .font(.plexSans(12, weight: isFocused ? .semibold : .medium))
                    .lineLimit(1)
                Text(pane.shortcut)
                    .font(.plexMono(9, weight: .semibold))
                    .foregroundStyle(isFocused ? Color.inkSecondary : Color.inkTertiary)
            }
            .foregroundStyle(isFocused ? Color.inkPrimary : Color.inkSecondary)
            .padding(.horizontal, Spacing.x2)
            .frame(height: 30)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(isActive ? Color.surfaceCard : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(isFocused ? Color.signalLive.opacity(0.7) : (isActive ? Color.hairlineDark : Color.clear), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(pane.title) \(pane.shortcut)")
        .accessibilityLabel(pane.title)
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
    }
}

struct TerminalSessionTabStrip: View {
    let sessions: [WorkspaceSession]
    let activeName: String?
    let isCreating: Bool
    let onSelect: (String) -> Void
    let onClose: (String) -> Void
    let onCreate: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.x1) {
                    ForEach(sessions) { session in
                        terminalTab(session)
                    }
                }
                .padding(.horizontal, Spacing.x2)
                .padding(.vertical, Spacing.x1)
            }
            Button(action: onCreate) {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.inkSecondary)
                    .iconHitTarget(30)
            }
            .buttonStyle(.plain)
            .disabled(isCreating)
            .help("New terminal tab")
        }
        .frame(height: 36)
        .background(Color.surfaceRail)
    }

    private func terminalTab(_ session: WorkspaceSession) -> some View {
        let active = session.name == activeName
        return HStack(spacing: Spacing.x1) {
            Button { onSelect(session.name) } label: {
                HStack(spacing: Spacing.x2) {
                    Circle()
                        .fill(session.isActive ? Color.signalLive : Color.inkTertiary)
                        .frame(width: 6, height: 6)
                    Image(systemName: "terminal")
                        .font(.system(size: 11, weight: .semibold))
                    Text(session.name)
                        .font(.plexMono(11, weight: active ? .semibold : .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .foregroundStyle(active ? Color.inkPrimary : Color.inkSecondary)
                .frame(minWidth: 118, maxWidth: 230, alignment: .leading)
                .padding(.leading, Spacing.x2)
                .frame(height: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if active {
                Button { onClose(session.name) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.inkTertiary)
                        .iconHitTarget(24)
                }
                .buttonStyle(.plain)
                .help("Close terminal tab")
            }
        }
        .padding(.trailing, active ? Spacing.x1 : Spacing.x2)
        .background(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .fill(active ? Color.surfaceCard : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(active ? Color.hairlineDark : Color.clear, lineWidth: 1)
        )
        .help(session.name)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Terminal \(session.name)")
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }
}

private struct WorkspaceTabPill: View {
    let tab: WorkspaceTab
    let isActive: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: Spacing.x1) {
            Button(action: onSelect) {
                HStack(spacing: Spacing.x2) {
                    Image(systemName: icon)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(isActive ? Color.signalLive : Color.inkTertiary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(tab.title)
                            .font(.plexSans(12, weight: isActive ? .semibold : .medium))
                            .foregroundStyle(isActive ? Color.inkPrimary : Color.inkSecondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(tab.projectName)
                            .font(.plexMono(9, weight: .medium))
                            .foregroundStyle(Color.inkTertiary)
                            .lineLimit(1)
                    }
                }
                .frame(minWidth: 132, maxWidth: 210, alignment: .leading)
                .padding(.leading, Spacing.x2)
                .padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.inkTertiary)
                    .iconHitTarget(24)
            }
            .buttonStyle(.plain)
            .help("Close tab")
        }
        .padding(.trailing, Spacing.x1)
        .background(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .fill(isActive ? Color.surfaceCard : Color.surfaceCardRaised.opacity(0.65))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(isActive ? Color.hairlineDark : Color.hairlineHighlight, lineWidth: 1)
        )
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(isActive ? Color.signalLive : Color.clear)
                .frame(height: 2)
                .padding(.horizontal, Spacing.x2)
        }
        .shadow(color: isActive ? Color.black.opacity(0.08) : Color.clear, radius: 7, y: 2)
        .help("\(tab.title) · \(tab.projectName)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(tab.title), \(tab.projectName)")
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
    }

    private var icon: String {
        switch tab.kind {
        case .home:
            return "house"
        case .board:
            return "rectangle.split.3x1"
        case .task:
            return "checklist"
        case .session:
            return "terminal"
        case .settings:
            return "gearshape"
        case .resources:
            return "gauge.with.dots.needle.67percent"
        case .app:
            return "square.grid.2x2"
        }
    }
}
#endif
