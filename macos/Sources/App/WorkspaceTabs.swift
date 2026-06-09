#if os(macOS)
import SwiftUI
import AppKit
import DesignSystem
import MatrixModel

struct WorkspaceTabStrip: View {
    let tabs: [WorkspaceTab]
    let activeID: String?
    let isCreating: Bool
    let pendingTerminalTabID: String?
    let onSelect: (String) -> Void
    let onClose: (String) -> Void
    let onCreate: () -> Void
    let onCommitPendingTerminalName: (String) -> Void
    let onCancelPendingTerminalName: () -> Void

    var body: some View {
        HStack(spacing: Spacing.x1) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.x1) {
                    ForEach(tabs) { tab in
                        if tab.id == pendingTerminalTabID {
                            PendingTerminalTabPill(
                                projectName: tab.projectName,
                                onCommit: onCommitPendingTerminalName,
                                onCancel: onCancelPendingTerminalName
                            )
                        } else {
                            WorkspaceTabPill(
                                tab: tab,
                                isActive: tab.id == activeID,
                                onSelect: { onSelect(tab.id) },
                                onClose: { onClose(tab.id) }
                            )
                        }
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

private struct PendingTerminalTabPill: View {
    let projectName: String
    let onCommit: (String) -> Void
    let onCancel: () -> Void

    @State private var name = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Spacing.x1) {
            HStack(spacing: Spacing.x2) {
                AppGlyphTile(symbol: "terminal", palette: .terminal, size: 26, isActive: true)
                VStack(alignment: .leading, spacing: 1) {
                    TextField("session-name", text: $name)
                        .textFieldStyle(.plain)
                        .font(.plexSans(12, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                        .focused($focused)
                        .frame(width: 118)
                        .onSubmit(commit)
                    Text(projectName)
                        .font(.plexMono(9, weight: .medium))
                        .foregroundStyle(Color.inkTertiary)
                        .lineLimit(1)
                }
            }
            .padding(.leading, Spacing.x2)
            .padding(.vertical, 5)

            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.inkTertiary)
                    .iconHitTarget(24)
            }
            .buttonStyle(.plain)
            .help("Cancel")
        }
        .padding(.trailing, Spacing.x1)
        .background(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .fill(Color.surfaceCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(Color.signalLive.opacity(0.7), lineWidth: 1)
        )
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.signalLive)
                .frame(height: 2)
                .padding(.horizontal, Spacing.x2)
        }
        .onAppear {
            DispatchQueue.main.async {
                focused = true
            }
        }
        .onExitCommand(perform: onCancel)
        .help("Name terminal session")
        .accessibilityLabel("Name terminal session")
    }

    private func commit() {
        onCommit(name)
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
    TaskPaneSpec(id: "terminal", title: "Terminal", icon: "terminal", shortcut: "⌥⌘1", panel: .terminal),
    TaskPaneSpec(id: "editor", title: "Editor", icon: "doc.text", shortcut: "⌥⌘2", panel: .app(slug: "editor")),
    TaskPaneSpec(id: "artifacts", title: "Artifacts", icon: "paperclip", shortcut: "⌥⌘3", panel: .app(slug: "artifacts")),
    TaskPaneSpec(id: "git", title: "Git", icon: "arrow.triangle.branch", shortcut: "⌥⌘4", panel: .app(slug: "git")),
    TaskPaneSpec(id: "settings", title: "Settings", icon: "slider.horizontal.3", shortcut: "⌥⌘5", panel: .app(slug: "settings")),
    TaskPaneSpec(id: "processes", title: "Processes", icon: "cpu", shortcut: "⌥⌘6", panel: .app(slug: "processes")),
    TaskPaneSpec(id: "whiteboard", title: "Excalidraw", icon: "scribble.variable", shortcut: "⌥⌘7", panel: .app(slug: "whiteboard")),
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
                        isEnabled: enabledPanels.contains(pane.panel),
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
        case "terminal": return "1"
        case "editor": return "2"
        case "artifacts": return "3"
        case "git": return "4"
        case "settings": return "5"
        case "processes": return "6"
        case "whiteboard": return "7"
        default: return "0"
        }
    }

    private func shortcutModifiers(for id: String) -> EventModifiers {
        [.command, .option]
    }
}

private struct TaskPaneButton: View {
    let pane: TaskPaneSpec
    let isEnabled: Bool
    let isFocused: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.x1) {
                AppGlyphTile(symbol: pane.icon, palette: .panel(pane.id), size: 20, isActive: isFocused)
                Text(pane.title)
                    .font(.plexSans(12, weight: isFocused ? .semibold : .medium))
                    .lineLimit(1)
                if isEnabled {
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(isFocused ? Color.signalLive : Color.inkTertiary)
                }
                Text(pane.shortcut)
                    .font(.plexMono(9, weight: .semibold))
                    .foregroundStyle(isFocused ? Color.inkSecondary : Color.inkTertiary)
            }
            .foregroundStyle(isFocused ? Color.inkPrimary : Color.inkSecondary)
            .padding(.horizontal, Spacing.x2)
            .frame(height: 30)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(isFocused ? Color.surfaceCard : (isEnabled ? Color.surfaceCardRaised.opacity(0.7) : Color.clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(
                        isFocused ? Color.signalLive.opacity(0.7) : (isEnabled ? Color.hairlineDark : Color.clear),
                        lineWidth: 1
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(isEnabled ? "Hide" : "Show") \(pane.title) \(pane.shortcut)")
        .accessibilityLabel(pane.title)
        .accessibilityHint(isEnabled ? "Enabled pane" : "Disabled pane")
        .accessibilityAddTraits(isFocused ? [.isSelected] : [])
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
            }
            Button(action: onCreate) {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.inkSecondary)
                    .iconHitTarget(28)
            }
            .buttonStyle(.plain)
            .disabled(isCreating)
            .help("New terminal tab")
        }
        .frame(height: 30)
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
                    AppGlyphTile(symbol: "terminal", palette: .terminal, size: 20, isActive: active)
                    Text(session.name)
                        .font(.plexMono(11, weight: active ? .semibold : .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .foregroundStyle(active ? Color.inkPrimary : Color.inkSecondary)
                .frame(minWidth: 118, maxWidth: 230, alignment: .leading)
                .padding(.leading, Spacing.x2)
                .frame(height: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if active {
                Button { onClose(session.name) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.inkTertiary)
                        .iconHitTarget(22)
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
        .contextMenu {
            Button("Open Terminal") { onSelect(session.name) }
            Button("Close Terminal Tab") { onClose(session.name) }
            Button("Copy Session Name") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(session.name, forType: .string)
            }
        }
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
                    AppGlyphTile(symbol: icon, palette: .tab(tab.kind), size: 26, isActive: isActive)
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
        .contextMenu {
            Button("Open Tab", action: onSelect)
            Button("Close Tab", action: onClose)
            Button("Copy Tab Title") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(tab.title, forType: .string)
            }
        }
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

struct AppGlyphTile: View {
    let symbol: String
    let palette: GlyphPalette
    let size: CGFloat
    let isActive: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            palette.top.opacity(isActive ? 1 : 0.86),
                            palette.bottom.opacity(isActive ? 1 : 0.78),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                        .stroke(Color.white.opacity(isActive ? 0.62 : 0.4), lineWidth: 0.7)
                        .padding(0.5)
                }
                .shadow(color: palette.bottom.opacity(isActive ? 0.26 : 0.12), radius: isActive ? 5 : 2, y: isActive ? 2 : 1)
            Image(systemName: symbol)
                .font(.system(size: size * 0.48, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(palette.foreground)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct GlyphPalette {
    let top: Color
    let bottom: Color
    let foreground: Color

    static let terminal = GlyphPalette(top: Color(hex: 0x30343B), bottom: Color(hex: 0x101318), foreground: Color(hex: 0xC8F2D0))

    static func tab(_ kind: WorkspaceTab.Kind) -> GlyphPalette {
        switch kind {
        case .home:
            return GlyphPalette(top: Color(hex: 0x88C7FF), bottom: Color(hex: 0x2370D9), foreground: .white)
        case .board:
            return GlyphPalette(top: Color(hex: 0x7FD98B), bottom: Color(hex: 0x2F8A47), foreground: .white)
        case .task:
            return GlyphPalette(top: Color(hex: 0xFFE08A), bottom: Color(hex: 0xD49B2A), foreground: Color(hex: 0x3A2A0B))
        case .session:
            return terminal
        case .settings:
            return GlyphPalette(top: Color(hex: 0xD5D8E2), bottom: Color(hex: 0x7D8797), foreground: .white)
        case .resources:
            return GlyphPalette(top: Color(hex: 0xB7E8FF), bottom: Color(hex: 0x3298C8), foreground: Color(hex: 0x083547))
        case .app:
            return GlyphPalette(top: Color(hex: 0xD7C4FF), bottom: Color(hex: 0x7761D8), foreground: .white)
        }
    }

    static func panel(_ id: String) -> GlyphPalette {
        switch id {
        case "terminal":
            return terminal
        case "editor":
            return GlyphPalette(top: Color(hex: 0x7EC8FF), bottom: Color(hex: 0x2B74E8), foreground: .white)
        case "artifacts":
            return GlyphPalette(top: Color(hex: 0xFFCE86), bottom: Color(hex: 0xD36C28), foreground: .white)
        case "git":
            return GlyphPalette(top: Color(hex: 0xAADF8F), bottom: Color(hex: 0x3E8F4A), foreground: .white)
        case "settings":
            return GlyphPalette(top: Color(hex: 0xE4E6EC), bottom: Color(hex: 0x8792A3), foreground: .white)
        case "processes":
            return GlyphPalette(top: Color(hex: 0xBCE7FF), bottom: Color(hex: 0x368BC0), foreground: Color(hex: 0x073449))
        case "whiteboard":
            return GlyphPalette(top: Color(hex: 0xF6A5D7), bottom: Color(hex: 0xB44FD1), foreground: .white)
        default:
            return GlyphPalette(top: Color(hex: 0xD7C4FF), bottom: Color(hex: 0x7761D8), foreground: .white)
        }
    }
}
#endif
