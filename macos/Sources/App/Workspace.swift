// Matrix OS — workspace shell: left rail (Home / Board / Terminal / Browser) + section content.
//
// Board = task kanban (cards open a zellij session). Terminal = the live zellij
// session list. Home is the hosted Matrix shell UI from the shell package.
#if os(macOS)
import SwiftUI
import AppKit
import DesignSystem
import MatrixTerminal

struct RootShellView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        rootContent
        .background(Color.canvasVoid)
        .overlay {
            if model.showCommandPalette {
                CommandPalette(model: model)
                    .transition(.opacity)
            }
            if model.showFileOpenPalette {
                FileOpenPalette(model: model)
                    .transition(.opacity)
            }
        }
        .animation(Motion.hover, value: model.showCommandPalette)
        .animation(Motion.hover, value: model.showFileOpenPalette)
    }

    @ViewBuilder
    private var rootContent: some View {
        if model.phase == .needsProfile {
            // Onboarding/sign-in takes the whole window (no rail yet).
            BoardView(model: model)
        } else if model.section == .settings {
            NativeSettingsPanel(model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            HStack(spacing: 0) {
                Sidebar(model: model)
                Rectangle().fill(Color.hairlineDark).frame(width: 1)
                VStack(spacing: 0) {
                    if !model.openTabs.isEmpty {
                        HStack(spacing: Spacing.x2) {
                            WorkspaceTabStrip(
                                tabs: model.filteredOpenTabs(matching: model.workspaceSearchQuery),
                                activeID: model.activeTabID,
                                isCreating: model.isCreatingWorkItem,
                                pendingTerminalTabID: model.pendingTerminalSessionTabID,
                                onSelect: model.focusTab,
                                onClose: model.closeTab,
                                onCreate: model.createWorkspaceTabFromCurrentContext,
                                onCommitPendingTerminalName: model.commitPendingTerminalSessionName,
                                onCancelPendingTerminalName: model.cancelPendingTerminalSessionCreation
                            )
                            .frame(maxWidth: .infinity)
                            HStack(spacing: Spacing.x1) {
                                Image(systemName: "magnifyingglass")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(Color.inkTertiary)
                                TextField("Filter", text: $model.workspaceSearchQuery)
                                    .textFieldStyle(.plain)
                                    .font(.plexSans(12))
                            }
                            .padding(.horizontal, Spacing.x2)
                            .frame(width: 180, height: 34)
                            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                    .strokeBorder(Color.hairlineDark.opacity(0.65), lineWidth: 1)
                            )
                        }
                        .padding(.horizontal, Spacing.x3)
                        .padding(.vertical, Spacing.x2)
                        Divider().overlay(Color.hairlineDark)
                    }
                    sectionContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }

    @ViewBuilder
    private var sectionContent: some View {
        switch model.section {
        case .home:
            MatrixWebShellPanel(model: model, url: model.shellURL(), title: "Matrix Home")
        case .board:
            BoardView(model: model)
        case .terminal:
            TerminalsView(model: model)
        case .settings:
            NativeSettingsPanel(model: model)
        case .resources:
            ResourcesPanel(model: model)
        case .browser:
            BrowserPageView()
        }
    }
}

/// Narrow left rail with section icons + a context "+" (new task / new session).
private struct Sidebar: View {
    @ObservedObject var model: AppModel
    @State private var collapsed = false
    @State private var sessionsCollapsed = false
    @State private var sidebarWidth: CGFloat = 320
    @State private var showSessionSearch = false
    @State private var sessionSearchQuery = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            sidebarHeader
                .padding(.horizontal, collapsed ? Spacing.x2 : Spacing.x4)
                .padding(.top, Spacing.x4)
                .padding(.bottom, Spacing.x3)

            if collapsed {
                collapsedRail
            } else {
                expandedSidebar
            }
        }
        .frame(width: collapsed ? 76 : sidebarWidth)
        .frame(maxHeight: .infinity)
        .background(Color.canvasVoid)
        .overlay(alignment: .trailing) {
            Rectangle().fill(Color.hairlineDark.opacity(0.65)).frame(width: 1)
        }
        .overlay(alignment: .trailing) {
            if !collapsed {
                SidebarResizeHandle(width: $sidebarWidth)
            }
        }
        .animation(Motion.columnReflow, value: collapsed)
    }

    private var sidebarHeader: some View {
        Group {
            if collapsed {
                VStack(spacing: Spacing.x2) {
                    AppMark(collapsed: true)
                    Button { collapsed.toggle() } label: {
                        Image(systemName: "sidebar.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.inkTertiary)
                            .frame(width: 40, height: 32)
                            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                    .strokeBorder(Color.hairlineDark.opacity(0.65), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .help("Expand sidebar")
                }
                .frame(maxWidth: .infinity)
            } else {
                HStack(spacing: Spacing.x3) {
                    AppMark(collapsed: false)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Matrix")
                        .font(.plexSans(17, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                    Text(model.hasSelectedProject ? model.activeProjectName : "Home")
                        .font(.plexMono(10, weight: .medium))
                        .foregroundStyle(Color.inkTertiary)
                }
                Spacer()
                    Button { collapsed.toggle() } label: {
                        Image(systemName: "sidebar.left")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.inkTertiary)
                            .iconHitTarget(32)
                    }
                    .buttonStyle(.plain)
                    .help("Collapse sidebar")
                }
            }
        }
    }

    private var collapsedRail: some View {
        VStack(spacing: 0) {
            ScrollView(showsIndicators: false) {
                VStack(spacing: Spacing.x2) {
                    ForEach(AppSection.allCases, id: \.self) { section in
                        railButton(section)
                    }
                    railDivider
                    ProjectPickerRail(model: model, collapsed: true)
                    railDivider
                    addButton(compact: true)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, Spacing.x1)
            }
            handleBadge
                .padding(.top, Spacing.x3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, Spacing.x1)
        .padding(.bottom, Spacing.x3)
    }

    private var expandedSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            navigationBlock
            projectsBlock
            sessionsBlock
                .frame(maxHeight: .infinity, alignment: .top)
            Divider().overlay(Color.hairlineDark.opacity(0.55))
                .padding(.horizontal, Spacing.x4)
                .padding(.vertical, Spacing.x2)
            handleBadge
                .padding(.horizontal, Spacing.x4)
                .padding(.bottom, Spacing.x2)
            commandPaletteCallout
                .padding(.horizontal, Spacing.x4)
                .padding(.bottom, Spacing.x4)
        }
    }

    private var navigationBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.x1) {
            sectionLabel("Navigate") {
                EmptyView()
            }
            ForEach(AppSection.allCases, id: \.self) { section in
                sectionRow(section)
            }
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.bottom, Spacing.x4)
    }

    private func sectionRow(_ section: AppSection) -> some View {
        let active = model.section == section
        return Button { selectSection(section) } label: {
            HStack(spacing: Spacing.x2) {
                Image(systemName: section.symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(active ? Color.signalLive : Color.inkTertiary)
                    .frame(width: 20)
                Text(section.title)
                    .font(.plexSans(13, weight: active ? .semibold : .medium))
                    .foregroundStyle(active ? Color.inkPrimary : Color.inkSecondary)
                Spacer()
            }
            .padding(.horizontal, Spacing.x3)
            .frame(height: 34)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(active ? Color.surfaceCardRaised : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(active ? Color.hairlineDark.opacity(0.75) : Color.clear, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(section.title)
        .accessibilityLabel(section.title)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    private func railButton(_ section: AppSection) -> some View {
        let active = model.section == section
        return Button { selectSection(section) } label: {
            Image(systemName: section.symbol)
                .font(.system(size: 16, weight: active ? .semibold : .medium))
            .foregroundStyle(active ? Color.signalLive : Color.inkTertiary)
            .frame(width: 46, height: 44)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(active ? Color.surfaceCardRaised : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(active ? Color.hairlineDark : Color.clear, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(section.title)
        .accessibilityLabel(section.title)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    private var railDivider: some View {
        Rectangle()
            .fill(Color.hairlineDark.opacity(0.7))
            .frame(width: 46, height: 1)
            .padding(.vertical, Spacing.x1)
    }

    private func selectSection(_ section: AppSection) {
        if section == .home {
            model.openHome()
        } else if section == .terminal {
            model.openTerminalSection()
        } else if section == .settings {
            model.openAppTab(slug: "settings", title: "Settings")
        } else if section == .resources {
            model.openAppTab(slug: "resources", title: "Resources")
        } else {
            model.section = section
        }
    }

    private func addButton(compact: Bool) -> some View {
        Button {
            performPrimaryAction()
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(Color.canvasVoid)
                .iconHitTarget(compact ? 42 : 36)
                .background(Circle().fill(Color.signalLive))
        }
        .buttonStyle(.plain)
        .disabled(model.isCreatingWorkItem)
        .help(primaryActionTitle)
        .accessibilityLabel(primaryActionTitle)
    }

    private func performPrimaryAction() {
        if model.section == .terminal {
            model.beginTerminalSessionCreation()
        } else if model.section == .board {
            model.createTask(status: .todo)
        } else {
            model.showCommandPalette = true
        }
    }

    private var primaryActionTitle: String {
        if model.section == .terminal { return "New session" }
        if model.section == .board { return "New task" }
        return "Command palette"
    }

    private var primaryActionShortcut: String {
        if model.section == .terminal { return "⌘T" }
        if model.section == .board { return "⌘N" }
        return "⌘K"
    }

    private var projectsBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.x2) {
            sectionLabel("Projects") {
                NewProjectButton(model: model)
            }
            ProjectPickerRail(model: model, collapsed: false)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.bottom, Spacing.x4)
    }

    private var sessionsBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.x2) {
            HStack(spacing: Spacing.x1) {
                Button { sessionsCollapsed.toggle() } label: {
                    HStack(spacing: Spacing.x2) {
                        Text("SESSIONS")
                            .font(.plexMono(10, weight: .semibold))
                            .foregroundStyle(Color.inkTertiary)
                            .tracking(1.1)
                        Image(systemName: sessionsCollapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Color.inkTertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(sessionsCollapsed ? "Show sessions" : "Hide sessions")

                Spacer()

                Button { showSessionSearch.toggle() } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(showSessionSearch ? Color.inkPrimary : Color.inkTertiary)
                        .iconHitTarget(28)
                }
                .buttonStyle(.plain)
                .help("Search sessions")

                Button { model.beginTerminalSessionCreation() } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.inkSecondary)
                        .iconHitTarget(28)
                }
                .buttonStyle(.plain)
                .disabled(model.isCreatingWorkItem)
                .help("New terminal tab")
            }

            if !sessionsCollapsed {
                if showSessionSearch {
                    HStack(spacing: Spacing.x2) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Color.inkTertiary)
                        TextField("Search sessions", text: $sessionSearchQuery)
                            .textFieldStyle(.plain)
                            .font(.plexSans(12))
                    }
                    .padding(.horizontal, Spacing.x3)
                    .frame(height: 30)
                    .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            .strokeBorder(Color.hairlineDark.opacity(0.65), lineWidth: 1)
                    )
                }
                ScrollView {
                    LazyVStack(spacing: 2) {
                        let sessionQuery = sessionSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                        let filteredSessions = sessionQuery.isEmpty
                            ? model.sessions
                            : model.sessions.filter { $0.name.lowercased().contains(sessionQuery) || $0.status.lowercased().contains(sessionQuery) }
                        let activeSessions = filteredSessions.filter(\.isActive)
                        if !activeSessions.isEmpty {
                            sidebarSubhead("Active")
                            ForEach(activeSessions) { session in
                                sessionRow(session)
                            }
                        }
                        let recentSessions = filteredSessions.filter { !$0.isActive }
                        if !recentSessions.isEmpty {
                            sidebarSubhead("Recent")
                                .padding(.top, Spacing.x2)
                            ForEach(recentSessions) { session in
                                sessionRow(session)
                            }
                        }
                        if model.sessions.isEmpty {
                            emptySessions
                        } else if filteredSessions.isEmpty {
                            Text("No matching sessions")
                                .font(.plexSans(12, weight: .medium))
                                .foregroundStyle(Color.inkTertiary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, Spacing.x2)
                        }
                    }
                    .padding(.bottom, Spacing.x2)
                }
            }
        }
        .padding(.horizontal, Spacing.x4)
    }

    private func sectionLabel<Accessory: View>(_ title: String, @ViewBuilder accessory: () -> Accessory) -> some View {
        HStack {
            Text(title.uppercased())
                .font(.plexMono(10, weight: .semibold))
                .foregroundStyle(Color.inkTertiary)
                .tracking(1.1)
            Spacer()
            accessory()
        }
    }

    private func sidebarSubhead(_ title: String) -> some View {
        Text(title)
            .font(.plexSans(12, weight: .medium))
            .foregroundStyle(Color.inkSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, Spacing.x1)
            .padding(.bottom, Spacing.x1)
    }

    private func sessionRow(_ session: WorkspaceSession) -> some View {
        let selected = model.activeTerminalSessionName == session.name
        return Button { model.openSession(named: session.name) } label: {
            HStack(spacing: Spacing.x2) {
                Image(systemName: session.isActive ? "terminal" : "doc.text")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.inkTertiary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.name)
                        .font(.plexSans(13, weight: selected ? .semibold : .regular))
                        .foregroundStyle(Color.inkPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Circle()
                    .fill(session.isActive ? Color.signalDone : Color.inkDisabled)
                    .frame(width: 7, height: 7)
                    .help(session.status.capitalized)
            }
            .padding(.horizontal, Spacing.x3)
            .frame(height: 32)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(selected ? Color.surfaceCardRaised.opacity(0.85) : Color.clear)
            )
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(selected ? Color.signalLive : Color.clear)
                    .frame(width: 2)
                    .padding(.vertical, Spacing.x2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open \(session.name)")
        .contextMenu {
            Button("Open Terminal") { model.openSession(named: session.name) }
            Button("Close Terminal Tab") { model.closeSession(named: session.name) }
            Button("Copy Session Name") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(session.name, forType: .string)
            }
            Divider()
            Button("New Terminal") { model.beginTerminalSessionCreation() }
        }
    }

    private var emptySessions: some View {
        VStack(alignment: .leading, spacing: Spacing.x2) {
            Image(systemName: "terminal")
                .font(.system(size: 18, weight: .light))
                .foregroundStyle(Color.inkTertiary)
            Text("No sessions yet")
                .font(.plexSans(13, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
            Text("Start a Matrix computer terminal.")
                .font(.plexSans(12))
                .foregroundStyle(Color.inkTertiary)
        }
        .padding(Spacing.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }

    private var commandPaletteCallout: some View {
        Button {
            model.showCommandPalette = true
        } label: {
            HStack(spacing: Spacing.x3) {
                Image(systemName: "command")
                    .font(.system(size: 13, weight: .semibold))
                Text("Command palette")
                    .font(.plexSans(14, weight: .semibold))
                Spacer()
                Text("⌘K")
                    .font(.plexMono(11, weight: .semibold))
                    .foregroundStyle(Color.inkSecondary)
                    .frame(width: 42, height: 28)
                    .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            }
            .foregroundStyle(Color.inkPrimary)
            .padding(.horizontal, Spacing.x4)
            .frame(height: 46)
            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                    .strokeBorder(Color.hairlineDark.opacity(0.65), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.06), radius: 10, y: 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Command palette")
        .accessibilityLabel("Command palette")
    }

    private var handleBadge: some View {
        let handle = model.profile?.handle ?? "unknown"
        return Menu {
            Button("Account Settings") {
                model.openAppTab(slug: "settings", title: "Settings")
            }
            Button("Resource Manager") {
                model.openAppTab(slug: "resources", title: "Resources")
            }
            if let url = model.shellURL() {
                Button("Open Web Shell") {
                    NSWorkspace.shared.open(url)
                }
            }
            Divider()
            Button("Sign Out", role: .destructive) {
                model.signOut()
            }
        } label: {
            HStack(spacing: Spacing.x2) {
                Text(String(handle.prefix(2)).uppercased())
                    .font(.plexMono(10, weight: .semibold))
                    .foregroundStyle(Color.canvasVoid)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Color.signalLive))
                if !collapsed {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(handle)
                            .font(.plexSans(12, weight: .semibold))
                            .foregroundStyle(Color.inkPrimary)
                            .lineLimit(1)
                        Text(profileSubtitle)
                            .font(.plexMono(9, weight: .medium))
                            .foregroundStyle(Color.inkTertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.inkTertiary)
                }
            }
            .padding(collapsed ? Spacing.x1 : Spacing.x3)
            .background(
                RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                    .fill(Color.surfaceCard)
                    .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                        .strokeBorder(Color.hairlineDark.opacity(0.6), lineWidth: 1))
            )
        }
        .menuStyle(.borderlessButton)
        .buttonStyle(.plain)
        .help(handle)
        .accessibilityLabel("Connected as \(handle)")
    }

    private var profileSubtitle: String {
        guard let profile = model.profile else { return "Not signed in" }
        if let slot = profile.runtimeSlot, !slot.isEmpty {
            return "\(profile.gatewayHost) · \(slot)"
        }
        return profile.gatewayHost
    }
}

private struct AppMark: View {
    let collapsed: Bool

    var body: some View {
        Group {
            if let image = Self.appIcon {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
            } else {
                Text("M")
                    .font(.plexMono(collapsed ? 18 : 20, weight: .semibold))
                    .foregroundStyle(Color.canvasVoid)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.signalLive)
            }
        }
        .frame(width: collapsed ? 46 : 52, height: collapsed ? 46 : 52)
        .clipShape(RoundedRectangle(cornerRadius: collapsed ? 10 : 12, style: .continuous))
        .shadow(color: Color.black.opacity(0.12), radius: 6, y: 2)
        .help("Matrix OS")
        .accessibilityLabel("Matrix OS")
    }

    private static var appIcon: NSImage? {
        if let resourceURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let image = NSImage(contentsOf: resourceURL) {
            return image
        }
        return NSApp.applicationIconImage
    }
}

private struct SidebarResizeHandle: View {
    @Binding var width: CGFloat
    @State private var startWidth: CGFloat?

    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: 8)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let base = startWidth ?? width
                        startWidth = base
                        width = min(460, max(240, base + value.translation.width))
                    }
                    .onEnded { _ in startWidth = nil }
            )
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            .help("Resize sidebar")
    }
}

/// Terminals section: list of live zellij sessions on the left, full terminal on
/// the right (resizable). One click opens the session over the gateway shell WS.
private struct TerminalsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        workbench
        .background(Color.canvasVoid)
    }

    private var workbench: some View {
        VStack(spacing: Spacing.x2) {
            workbenchHeader
            terminalSurface
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.top, Spacing.x3)
        .padding(.bottom, Spacing.x4)
        .background(Color.canvasVoid)
    }

    private var workbenchHeader: some View {
        HStack(spacing: Spacing.x2) {
            Label(model.terminal?.displayName ?? "Terminal", systemImage: "terminal")
                .font(.plexSans(13, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
                .lineLimit(1)
                .truncationMode(.middle)

            statusText

            Spacer()

            headerIcon("clock") { Task { await model.loadSessions() } }
            headerIcon("square.and.arrow.up") {
                if let url = model.shellURL() {
                    NSWorkspace.shared.open(url)
                }
            }
            headerIcon("ellipsis") { model.showCommandPalette = true }
        }
        .frame(height: 32)
    }

    private var statusText: some View {
        HStack(spacing: Spacing.x1) {
            Circle()
                .fill(model.terminal == nil ? Color.inkDisabled : Color.signalLive)
                .frame(width: 5, height: 5)
            Text(model.terminal == nil ? "detached" : "attached")
            Text("·")
            Text(model.sessions.isEmpty ? "0 sessions" : "\(model.sessions.count) sessions")
        }
        .font(.plexMono(10, weight: .medium))
        .foregroundStyle(Color.inkTertiary)
        .lineLimit(1)
    }

    private func headerIcon(_ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.inkTertiary)
                .iconHitTarget(32)
                .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .strokeBorder(Color.hairlineDark.opacity(0.65), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var taskWorkspaceSplit: some View {
        selectedPane
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var selectedPane: some View {
        switch model.activePanel {
        case .terminal:
            terminalSurface
        case .shell:
            workbenchPlaceholder(title: "Matrix OS Shell", icon: "globe", message: "The web shell panel is added in the next stack layer.")
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
                workbenchPlaceholder(title: "Excalidraw", icon: "scribble.variable", message: "Whiteboard opens once the web shell panel is available.")
            default:
                let meta = panelMeta(slug)
                workbenchPlaceholder(title: meta.title, icon: meta.icon, message: meta.message)
            }
        }
    }

    @ViewBuilder
    private var terminalSurface: some View {
        if let terminal = model.terminal {
            TerminalPanelView(session: terminal)
                .id(terminal.id)
                .background(Color.surfaceTerminal)
                .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                        .strokeBorder(Color.black.opacity(0.35), lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.18), radius: 18, y: 8)
        } else {
            ZStack {
                Color.surfaceTerminal
                VStack(spacing: Spacing.x2) {
                    Image(systemName: "terminal")
                        .font(.system(size: 28, weight: .light))
                        .foregroundStyle(Color.terminalMutedInk)
                    Text("Select a session to open its terminal")
                        .font(.plexSans(13))
                        .foregroundStyle(Color.terminalMutedInk)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        }
    }

    private func panelMeta(_ slug: String) -> (title: String, icon: String, message: String) {
        switch slug {
        case "editor":
            return ("Editor", "doc.text", "Code editor panel for this task.")
        case "artifacts":
            return ("Artifacts", "paperclip", "Generated files, previews, and links for this task.")
        case "git":
            return ("Git", "arrow.triangle.branch", "Branch, diff, commit, and PR controls for this task.")
        case "settings":
            return ("Settings", "slider.horizontal.3", "Task metadata is available in the inspector.")
        case "processes":
            return ("Processes", "cpu", "Running agents and background jobs for this task.")
        case "whiteboard":
            return ("Excalidraw", "scribble.variable", "Sketches and diagrams attached to this task.")
        default:
            return ("Panel", "square.grid.2x2", "Panel not available yet.")
        }
    }

    private func workbenchPlaceholder(title: String, icon: String, message: String) -> some View {
        VStack(spacing: Spacing.x3) {
            Image(systemName: icon)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Color.signalLive)
            Text(title)
                .font(.plexSans(18, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
            Text(message)
                .font(.plexSans(13))
                .foregroundStyle(Color.inkTertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.surfaceCard)
    }

    private var inspector: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.x3) {
                inspectorHeader
                inspectorSection("Description", icon: "text.alignleft") {
                    Text("Add description...")
                        .font(.plexSans(13))
                        .foregroundStyle(Color.inkTertiary)
                        .frame(maxWidth: .infinity, minHeight: 72, alignment: .topLeading)
                }
                inspectorSection("Sub-tasks", icon: "checklist") {
                    inspectorAddRow("Add subtask")
                }
                inspectorSection("Artifacts", icon: "paperclip") {
                    inspectorAddRow("Add artifact")
                }
                inspectorGrid
                inspectorSection("Working Directory", icon: "folder") {
                    Text(model.selectedCard?.linkedWorktreeId ?? "~/projects/\(model.projectSlug)")
                        .font(.plexMono(11))
                        .foregroundStyle(Color.inkSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Spacing.x2)
                        .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                }
            }
            .padding(Spacing.x3)
        }
        .background(Color.surfaceRail)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.hairlineDark).frame(width: 1)
        }
    }

    private var inspectorHeader: some View {
        HStack {
            Label("Settings", systemImage: "slider.horizontal.3")
                .font(.plexSans(14, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
            Spacer()
            Text("View activity")
                .font(.plexSans(11, weight: .medium))
                .foregroundStyle(Color.inkTertiary)
        }
    }

    private func inspectorSection<Content: View>(
        _ title: String,
        icon: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Spacing.x2) {
                Image(systemName: icon)
                Text(title)
                Spacer()
            }
            .font(.plexSans(12, weight: .semibold))
            .foregroundStyle(Color.inkSecondary)
            .padding(Spacing.x2)
            .background(Color.surfaceRail)
            Divider().overlay(Color.hairlineDark)
            content()
                .padding(Spacing.x2)
        }
        .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(Color.hairlineDark, lineWidth: 1)
        )
    }

    private func inspectorAddRow(_ title: String) -> some View {
        Button {
            model.createTask(status: .todo)
        } label: {
            Label(title, systemImage: "plus")
                .font(.plexSans(12))
                .foregroundStyle(Color.inkSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    private var inspectorGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Spacing.x2) {
            inspectorField("Project", value: model.projects.first { $0.slug == model.projectSlug }?.name ?? model.projectSlug, icon: "folder")
            inspectorField("Status", value: model.selectedCard?.status.rawValue ?? "running", icon: "circle")
            inspectorField("Priority", value: model.selectedCard?.priority.rawValue ?? "normal", icon: "chart.bar")
            inspectorField("Progress", value: model.terminal == nil ? "Not started" : "Attached", icon: "gauge.with.dots.needle.33percent")
        }
    }

    private func inspectorField(_ label: String, value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.x1) {
            Text(label)
                .font(.plexSans(11, weight: .medium))
                .foregroundStyle(Color.inkTertiary)
            HStack(spacing: Spacing.x1) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.signalLive)
                Text(value)
                    .font(.plexSans(12, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Color.inkPrimary)
            .padding(Spacing.x2)
            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(Color.hairlineDark, lineWidth: 1)
            )
        }
    }
}

struct EditorPanel: View {
    @ObservedObject var model: AppModel
    @State private var viewMode: EditorViewMode = .code

    private var fileKind: EditorFileKind {
        EditorFileKind(path: model.selectedFilePath)
    }

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                HStack(spacing: Spacing.x2) {
                    Button { model.goUpInFiles() } label: {
                        Image(systemName: "chevron.left")
                            .iconHitTarget(28)
                    }
                    .buttonStyle(.plain)
                    .help("Up")
                    Text(model.filePanelPath.isEmpty ? "projects/\(model.projectSlug)" : model.filePanelPath)
                        .font(.plexMono(11))
                        .foregroundStyle(Color.inkTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button { Task { await model.loadPanelData(for: .app(slug: "editor")) } } label: {
                        Image(systemName: "arrow.clockwise")
                            .iconHitTarget(28)
                    }
                    .buttonStyle(.plain)
                    .help("Refresh")
                }
                .padding(Spacing.x2)
                .background(Color.surfaceRail)
                .overlay(alignment: .bottom) { Rectangle().fill(Color.hairlineDark).frame(height: 1) }

                FileNavigatorOutlineView(
                    nodes: model.fileTree,
                    selectedPath: model.selectedFilePath,
                    onOpen: { model.openFileTreeNode($0) },
                    onToggle: { model.toggleFileTreeNode($0) }
                )
            }
            .frame(minWidth: 220, idealWidth: 280, maxWidth: 380)

            VStack(spacing: 0) {
                HStack {
                    Text(model.selectedFilePath ?? "Select a file")
                        .font(.plexSans(13, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    if fileKind == .markdown || fileKind == .code {
                        Picker("View", selection: $viewMode) {
                            Text("Preview").tag(EditorViewMode.preview)
                            Text("Edit").tag(EditorViewMode.code)
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .frame(width: 150)
                    }
                    if fileKind == .code {
                        editorSettingsMenu
                    }
                    if let state = model.fileSaveState {
                        Text(state)
                            .font(.plexSans(12))
                            .foregroundStyle(state == "Saved" ? Color.signalDone : Color.inkTertiary)
                    }
                    Button { model.saveSelectedFile() } label: {
                        Label("Save", systemImage: "square.and.arrow.down")
                    }
                    .disabled(model.selectedFilePath == nil || fileKind == .image)
                }
                .padding(Spacing.x2)
                .background(Color.surfaceRail)
                .overlay(alignment: .bottom) { Rectangle().fill(Color.hairlineDark).frame(height: 1) }

                if model.selectedFilePath == nil {
                    ContentUnavailableView(
                        "No file selected",
                        systemImage: "doc.text.magnifyingglass",
                        description: Text("Choose a project file to inspect or edit.")
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.isLoadingSelectedFile {
                    VStack(spacing: Spacing.x3) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Loading \(URL(fileURLWithPath: model.selectedFilePath ?? "").lastPathComponent)")
                            .font(.plexSans(13, weight: .medium))
                            .foregroundStyle(Color.inkSecondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if fileKind == .image {
                    ImageFilePreview(data: model.selectedFileData, path: model.selectedFilePath)
                } else if fileKind == .markdown && viewMode == .preview {
                    MarkdownRenderedPreview(markdown: model.selectedFileContent)
                } else if fileKind == .code && viewMode == .preview {
                    SyntaxHighlightedCodeEditor(
                        text: Binding(
                            get: { model.selectedFileContent },
                            set: { _ in }
                        ),
                        filePath: model.selectedFilePath,
                        theme: model.editorTheme,
                        preferences: model.editorPreferences,
                        isEditable: false
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    SyntaxHighlightedCodeEditor(
                        text: $model.selectedFileContent,
                        filePath: model.selectedFilePath,
                        theme: model.editorTheme,
                        preferences: model.editorPreferences
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 360, maxWidth: .infinity)
        }
        .background(Color.surfaceCard)
    }

    private var editorSettingsMenu: some View {
        Menu {
            Picker("Theme", selection: themeBinding) {
                ForEach(CodeEditorTheme.allCases) { theme in
                    Text(theme.rawValue).tag(theme)
                }
            }
            Divider()
            Toggle("Wrap lines", isOn: wrapBinding)
            Toggle("Show invisibles", isOn: invisiblesBinding)
            Divider()
            Stepper("Font \(Int(model.editorPreferences.fontSize)) pt", value: fontSizeBinding, in: 11...20, step: 1)
            Stepper("Tab width \(model.editorPreferences.tabWidth)", value: tabWidthBinding, in: 2...8)
        } label: {
            Label(model.editorTheme.rawValue, systemImage: "paintpalette")
                .labelStyle(.titleAndIcon)
        }
        .menuStyle(.button)
        .controlSize(.small)
        .help("Editor appearance")
    }

    private var themeBinding: Binding<CodeEditorTheme> {
        Binding(
            get: { model.editorTheme },
            set: { model.setEditorTheme($0) }
        )
    }

    private var wrapBinding: Binding<Bool> {
        Binding(
            get: { model.editorPreferences.wrapsLines },
            set: { model.setEditorWrapsLines($0) }
        )
    }

    private var invisiblesBinding: Binding<Bool> {
        Binding(
            get: { model.editorPreferences.showsInvisibleCharacters },
            set: { model.setEditorShowsInvisibleCharacters($0) }
        )
    }

    private var fontSizeBinding: Binding<Double> {
        Binding(
            get: { model.editorPreferences.fontSize },
            set: { model.setEditorFontSize($0) }
        )
    }

    private var tabWidthBinding: Binding<Int> {
        Binding(
            get: { model.editorPreferences.tabWidth },
            set: { model.setEditorTabWidth($0) }
        )
    }
}

private enum EditorViewMode: String, CaseIterable, Identifiable {
    case preview
    case code
    var id: String { rawValue }
}

private enum EditorFileKind {
    case markdown
    case image
    case code

    init(path: String?) {
        let ext = URL(fileURLWithPath: path ?? "").pathExtension.lowercased()
        if ["md", "markdown", "mdx"].contains(ext) {
            self = .markdown
        } else if ["png", "jpg", "jpeg", "gif", "tiff", "tif", "bmp", "webp", "svg", "heic"].contains(ext) {
            self = .image
        } else {
            self = .code
        }
    }
}

private struct MarkdownRenderedPreview: View {
    let markdown: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.x4) {
                renderedText
                    .font(.plexSans(15))
                    .foregroundStyle(Color.inkPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(Spacing.x5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.surfaceCard)
    }

    @ViewBuilder
    private var renderedText: some View {
        if let attributed = try? AttributedString(markdown: markdown) {
            Text(attributed)
        } else {
            Text(markdown)
                .font(.plexMono(13))
        }
    }
}

private struct ImageFilePreview: View {
    let data: Data?
    let path: String?

    var body: some View {
        ZStack {
            Color.surfaceCard
            if let image {
                ScrollView([.horizontal, .vertical]) {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .scaledToFit()
                        .padding(Spacing.x5)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                ContentUnavailableView(
                    "Preview unavailable",
                    systemImage: "photo",
                    description: Text(path ?? "This image format could not be rendered.")
                )
            }
        }
    }

    private var image: NSImage? {
        guard let data else { return nil }
        return NSImage(data: data)
    }
}

private struct FileTreeNodeRow: View {
    @ObservedObject var model: AppModel
    let node: WorkspaceFileTreeNode
    let depth: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                model.openFileTreeNode(node)
            } label: {
                HStack(spacing: Spacing.x1) {
                    Image(systemName: node.isDirectory ? (node.expanded ? "chevron.down" : "chevron.right") : "circle.fill")
                        .font(.system(size: node.isDirectory ? 10 : 4, weight: .semibold))
                        .foregroundStyle(Color.inkTertiary)
                        .frame(width: 12)
                    Image(systemName: node.isDirectory ? "folder" : "doc.text")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(node.isDirectory ? Color.signalLive : Color.inkTertiary)
                    Text(node.name)
                        .font(.plexSans(12, weight: model.selectedFilePath == node.path ? .semibold : .regular))
                        .foregroundStyle(Color.inkPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let status = node.gitStatus {
                        Text(status)
                            .font(.plexMono(9, weight: .medium))
                            .foregroundStyle(Color.signalWaiting)
                    } else if let changed = node.changedCount, changed > 0 {
                        Text("\(changed)")
                            .font(.plexMono(9, weight: .medium))
                            .foregroundStyle(Color.signalWaiting)
                    }
                }
                .padding(.leading, CGFloat(depth) * 14 + Spacing.x2)
                .padding(.trailing, Spacing.x2)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .fill(model.selectedFilePath == node.path ? Color.surfaceCardRaised : Color.clear)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button(node.isDirectory ? "Open Folder" : "Open File") {
                    model.openFileTreeNode(node)
                }
                Button("Copy Path") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(node.path, forType: .string)
                }
                if node.isDirectory {
                    Button(node.expanded ? "Collapse" : "Expand") {
                        model.toggleFileTreeNode(node)
                    }
                }
            }
            if node.expanded, let children = node.children {
                ForEach(children) { child in
                    FileTreeNodeRow(model: model, node: child, depth: depth + 1)
                }
            }
        }
    }
}

struct GitPanel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.x4) {
                HStack {
                    Label("Git", systemImage: "arrow.triangle.branch")
                        .font(.plexSans(16, weight: .semibold))
                    Spacer()
                    Button { Task { await model.loadPanelData(for: .app(slug: "git")) } } label: {
                        Image(systemName: "arrow.clockwise")
                            .iconHitTarget(30)
                    }
                    .buttonStyle(.plain)
                }
                quickActions
                gitSection("Branches", icon: "point.3.connected.trianglepath.dotted") {
                    if model.gitBranches.isEmpty {
                        emptyLine("No branches loaded")
                    } else {
                        ForEach(model.gitBranches) { branch in
                            gitRow(title: branch.name, subtitle: "Local branch", icon: "arrow.triangle.branch")
                        }
                    }
                }
                gitSection("Pull Requests", icon: "point.topleft.down.curvedto.point.bottomright.up") {
                    if model.gitPullRequests.isEmpty {
                        emptyLine("No pull requests loaded")
                    } else {
                        ForEach(model.gitPullRequests) { pr in
                            gitRow(
                                title: "#\(pr.number) \(pr.title)",
                                subtitle: [pr.headRefName, pr.baseRefName].compactMap { $0 }.joined(separator: " → "),
                                icon: "arrow.up.right.square"
                            )
                        }
                    }
                }
                gitSection("Worktrees", icon: "folder.badge.gearshape") {
                    if model.gitWorktrees.isEmpty {
                        emptyLine("No worktrees")
                    } else {
                        ForEach(model.gitWorktrees) { worktree in
                            gitRow(
                                title: worktree.currentBranch,
                                subtitle: "\(worktree.dirtyState) · \(worktree.path)",
                                icon: "folder"
                            )
                        }
                    }
                }
            }
            .padding(Spacing.x4)
        }
        .background(Color.surfaceCard)
    }

    private var quickActions: some View {
        HStack(spacing: Spacing.x2) {
            actionButton("Status", icon: "list.bullet.rectangle") {
                model.sendCommandToActiveTerminal("git -C ~/projects/\(model.projectSlug) status --short --branch")
            }
            actionButton("Pull", icon: "arrow.down") {
                model.sendCommandToActiveTerminal("git -C ~/projects/\(model.projectSlug) pull --ff-only")
            }
            actionButton("Push", icon: "arrow.up") {
                model.sendCommandToActiveTerminal("git -C ~/projects/\(model.projectSlug) push")
            }
            actionButton("Commit", icon: "checkmark.seal") {
                model.sendCommandToActiveTerminal("git -C ~/projects/\(model.projectSlug) commit")
            }
        }
    }

    private func actionButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
        }
        .buttonStyle(.bordered)
    }

    private func gitSection<Content: View>(
        _ title: String,
        icon: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: Spacing.x2) {
            Label(title, systemImage: icon)
                .font(.plexSans(13, weight: .semibold))
                .foregroundStyle(Color.inkSecondary)
            VStack(spacing: 0) {
                content()
            }
            .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
    }

    private func gitRow(title: String, subtitle: String, icon: String) -> some View {
        HStack(spacing: Spacing.x2) {
            Image(systemName: icon).foregroundStyle(Color.signalLive)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.plexSans(13, weight: .medium)).foregroundStyle(Color.inkPrimary)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.plexMono(11)).foregroundStyle(Color.inkTertiary).lineLimit(1)
                }
            }
            Spacer()
        }
        .padding(Spacing.x2)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.hairlineDark).frame(height: 1) }
    }

    private func emptyLine(_ text: String) -> some View {
        Text(text)
            .font(.plexSans(12))
            .foregroundStyle(Color.inkTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Spacing.x2)
    }
}

struct ArtifactsPanel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.x3) {
                HStack {
                    Label("Artifacts", systemImage: "paperclip")
                        .font(.plexSans(16, weight: .semibold))
                    Spacer()
                    Button { Task { await model.loadPanelData(for: .app(slug: "artifacts")) } } label: {
                        Image(systemName: "arrow.clockwise")
                            .iconHitTarget(30)
                    }
                    .buttonStyle(.plain)
                }
                if model.previews.isEmpty {
                    ContentUnavailableView(
                        "No artifacts yet",
                        systemImage: "tray",
                        description: Text("Previews created by agents will appear here.")
                    )
                    .frame(maxWidth: .infinity, minHeight: 280)
                } else {
                    ForEach(model.previews) { preview in
                        HStack(spacing: Spacing.x2) {
                            Image(systemName: "link")
                                .foregroundStyle(Color.signalLive)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(preview.label)
                                    .font(.plexSans(13, weight: .semibold))
                                Text(preview.url)
                                    .font(.plexMono(11))
                                    .foregroundStyle(Color.inkTertiary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            if let url = URL(string: preview.url) {
                                Link("Open", destination: url)
                            }
                        }
                        .padding(Spacing.x3)
                        .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    }
                }
            }
            .padding(Spacing.x4)
        }
        .background(Color.surfaceCard)
    }
}

struct ProcessesPanel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.x3) {
            HStack {
                Label("Processes", systemImage: "cpu")
                    .font(.plexSans(16, weight: .semibold))
                Spacer()
                Button { Task { await model.loadSessions() } } label: {
                    Image(systemName: "arrow.clockwise")
                        .iconHitTarget(30)
                }
                .buttonStyle(.plain)
            }
            List(model.sessions) { session in
                HStack {
                    Circle()
                        .fill(session.isActive ? Color.signalDone : Color.signalIdle)
                        .frame(width: 8, height: 8)
                    VStack(alignment: .leading) {
                        Text(session.name)
                            .font(.plexMono(12))
                        Text(session.status)
                            .font(.plexSans(11))
                            .foregroundStyle(Color.inkTertiary)
                    }
                    Spacer()
                    Button("Open") { model.openSession(named: session.name) }
                }
            }
            .listStyle(.inset)
        }
        .padding(Spacing.x4)
        .background(Color.surfaceCard)
    }
}

struct NativeSettingsPanel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollViewReader { proxy in
            HStack(spacing: 0) {
                settingsSidebar { section in
                    model.focusNativeSettingsSection(section)
                    withAnimation(.easeInOut(duration: 0.18)) {
                        proxy.scrollTo(section, anchor: .top)
                    }
                }
                .frame(width: 214)
                Rectangle().fill(Color.hairlineDark).frame(width: 1)
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.x5) {
                        header
                        HStack(alignment: .top, spacing: Spacing.x4) {
                            VStack(spacing: Spacing.x4) {
                                accountSection
                                    .id(NativeSettingsSection.account)
                                editorSection
                                    .id(NativeSettingsSection.editor)
                            }
                            .frame(minWidth: 320, idealWidth: 380, maxWidth: 440)

                            VStack(spacing: Spacing.x4) {
                                runtimeSection
                                    .id(NativeSettingsSection.runtime)
                                accessSection
                                    .id(NativeSettingsSection.workspace)
                            }
                            .frame(minWidth: 360, idealWidth: 440, maxWidth: 520)
                        }
                    }
                    .padding(Spacing.x5)
                    .frame(maxWidth: 980, alignment: .topLeading)
                }
            }
            .background(Color.canvasVoid)
        }
    }

    private func settingsSidebar(scrollTo: @escaping (NativeSettingsSection) -> Void) -> some View {
        VStack(alignment: .leading, spacing: Spacing.x1) {
            Text("SETTINGS")
                .font(.plexMono(10, weight: .semibold))
                .foregroundStyle(Color.inkTertiary)
                .tracking(1.2)
                .padding(.horizontal, Spacing.x3)
                .padding(.bottom, Spacing.x2)
            ForEach(NativeSettingsSection.allCases) { section in
                settingsNavItem(
                    section,
                    active: model.nativeSettingsSection == section,
                    action: { scrollTo(section) }
                )
            }
            Spacer()
            Button {
                Task { await model.loadSystemInfo() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .font(.plexSans(12, weight: .semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.inkSecondary)
            .padding(Spacing.x3)
            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(Color.hairlineDark.opacity(0.75), lineWidth: 1)
            )
            .help("Refresh settings")
        }
        .padding(Spacing.x3)
        .background(Color.surfaceRail)
    }

    private func settingsNavItem(
        _ section: NativeSettingsSection,
        active: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: Spacing.x2) {
                Image(systemName: section.symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 18)
                Text(section.title)
                    .font(.plexSans(13, weight: active ? .semibold : .medium))
                Spacer()
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? Color.inkPrimary : Color.inkSecondary)
        .padding(.horizontal, Spacing.x3)
        .frame(height: 34)
        .contentShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .background(active ? Color.surfaceCardRaised : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(active ? Color.hairlineDark.opacity(0.9) : Color.clear, lineWidth: 1)
        )
        .help(section.title)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: Spacing.x3) {
            AppGlyphTile(symbol: "gearshape", palette: .tab(.settings), size: 46, isActive: true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Settings")
                    .font(.plexSans(24, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Text("Account, runtime, editor, and native workspace preferences.")
                    .font(.plexSans(13))
                    .foregroundStyle(Color.inkTertiary)
            }
            Spacer()
        }
    }

    private var accountSection: some View {
        settingsSection("Account", icon: "person.crop.circle") {
            settingRow("Signed in as", value: model.profile?.handle ?? "Not signed in", icon: "person")
            settingRow("Computer", value: model.profile?.gatewayHost ?? "No runtime selected", icon: "server.rack")
            Divider().overlay(Color.hairlineDark)
            HStack(spacing: Spacing.x2) {
                Button {
                    model.signOut()
                } label: {
                    Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.surfaceCard)
                .padding(.horizontal, Spacing.x3)
                .frame(height: 34)
                .background(Color.signalBlocked, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                if let url = model.shellURL() {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Label("Open Web Shell", systemImage: "arrow.up.right.square")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.inkPrimary)
                    .padding(.horizontal, Spacing.x3)
                    .frame(height: 34)
                    .background(Color.surfaceCardRaised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            .strokeBorder(Color.hairlineDark.opacity(0.8), lineWidth: 1)
                    )
                }
            }
        }
    }

    private var runtimeSection: some View {
        settingsSection("Runtime", icon: "gauge.with.dots.needle.67percent") {
            if let info = model.systemInfo {
                settingRow("Runtime", value: info.displayRuntimeName, icon: "desktopcomputer")
                settingRow("Version", value: info.version, icon: "shippingbox")
                settingRow("Uptime", value: info.uptimeText, icon: "clock")
                ForEach(info.resourceRows) { row in
                    settingRow(row.label, value: "\(row.value) · \(row.detail)", icon: row.symbol)
                }
            } else {
                VStack(alignment: .leading, spacing: Spacing.x2) {
                    Label("Runtime unavailable", systemImage: "exclamationmark.triangle")
                        .font(.plexSans(13, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                    Text("Connect your Matrix computer to manage runtime resources.")
                        .font(.plexSans(12))
                        .foregroundStyle(Color.inkTertiary)
                }
            }
        }
    }

    private var editorSection: some View {
        settingsSection("Editor", icon: "chevron.left.forwardslash.chevron.right") {
            Picker("Theme", selection: themeBinding) {
                ForEach(CodeEditorTheme.allCases) { theme in
                    Text(theme.rawValue).tag(theme)
                }
            }
            .pickerStyle(.menu)
            Toggle("Wrap lines", isOn: wrapBinding)
            Toggle("Show invisible characters", isOn: invisiblesBinding)
            Stepper("Font size \(Int(model.editorPreferences.fontSize)) pt", value: fontSizeBinding, in: 11...20, step: 1)
            Stepper("Tab width \(model.editorPreferences.tabWidth)", value: tabWidthBinding, in: 2...8)
        }
    }

    private var accessSection: some View {
        settingsSection("Workspace Access", icon: "lock.shield") {
            settingRow("Projects", value: "\(model.projects.count) available", icon: "folder")
            settingRow("Open tabs", value: "\(model.openTabs.count)", icon: "rectangle.on.rectangle")
            settingRow("Terminal sessions", value: "\(model.sessions.count)", icon: "terminal")
            Button {
                model.openAppTab(slug: "resources", title: "Resources")
            } label: {
                Label("Open Resource Manager", systemImage: "gauge.with.dots.needle.67percent")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.inkPrimary)
            .padding(.horizontal, Spacing.x3)
            .frame(height: 34)
            .background(Color.surfaceCardRaised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(Color.hairlineDark.opacity(0.8), lineWidth: 1)
            )
        }
    }

    private func settingsSection<Content: View>(
        _ title: String,
        icon: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: Spacing.x3) {
            Label(title, systemImage: icon)
                .font(.plexSans(15, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
            content()
        }
        .padding(Spacing.x4)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                .strokeBorder(Color.hairlineDark.opacity(0.75), lineWidth: 1)
        )
    }

    private func settingRow(_ label: String, value: String, icon: String) -> some View {
        HStack(spacing: Spacing.x2) {
            Image(systemName: icon)
                .foregroundStyle(Color.signalLive)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.plexSans(11, weight: .medium))
                    .foregroundStyle(Color.inkTertiary)
                Text(value)
                    .font(.plexSans(12, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(Spacing.x2)
        .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(Color.hairlineDark.opacity(0.55), lineWidth: 1)
        )
    }

    private var themeBinding: Binding<CodeEditorTheme> {
        Binding(get: { model.editorTheme }, set: { model.setEditorTheme($0) })
    }

    private var wrapBinding: Binding<Bool> {
        Binding(get: { model.editorPreferences.wrapsLines }, set: { model.setEditorWrapsLines($0) })
    }

    private var invisiblesBinding: Binding<Bool> {
        Binding(get: { model.editorPreferences.showsInvisibleCharacters }, set: { model.setEditorShowsInvisibleCharacters($0) })
    }

    private var fontSizeBinding: Binding<Double> {
        Binding(get: { model.editorPreferences.fontSize }, set: { model.setEditorFontSize($0) })
    }

    private var tabWidthBinding: Binding<Int> {
        Binding(get: { model.editorPreferences.tabWidth }, set: { model.setEditorTabWidth($0) })
    }
}

struct ResourcesPanel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.x4) {
            HStack {
                Label("Resources", systemImage: "gauge.with.dots.needle.67percent")
                    .font(.plexSans(16, weight: .semibold))
                Spacer()
                Button { Task { await model.loadSystemInfo() } } label: {
                    Image(systemName: "arrow.clockwise")
                        .iconHitTarget(30)
                }
                .buttonStyle(.plain)
                .help("Refresh resources")
            }
            if let info = model.systemInfo {
                Text(info.summaryText)
                    .font(.plexSans(13, weight: .medium))
                    .foregroundStyle(Color.inkSecondary)
                ForEach(info.resourceRows) { row in
                    HStack(spacing: Spacing.x3) {
                        Image(systemName: row.symbol)
                            .foregroundStyle(Color.signalLive)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.label)
                                .font(.plexSans(12, weight: .medium))
                                .foregroundStyle(Color.inkSecondary)
                            Text(row.detail)
                                .font(.plexSans(11))
                                .foregroundStyle(Color.inkTertiary)
                        }
                        Spacer()
                        Text(row.value)
                            .font(.plexMono(12, weight: .semibold))
                            .foregroundStyle(Color.inkPrimary)
                    }
                    .padding(Spacing.x3)
                    .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                }
            } else {
                ContentUnavailableView(
                    "Resources unavailable",
                    systemImage: "gauge.with.dots.needle.67percent",
                    description: Text("Connect your Matrix computer to inspect CPU, memory, and storage.")
                )
            }
            Spacer()
        }
        .padding(Spacing.x4)
        .background(Color.surfaceCard)
    }
}
#endif
