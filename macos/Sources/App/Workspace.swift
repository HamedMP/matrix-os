// Matrix OS — workspace shell: left rail (Board / Terminals) + section content.
//
// Board = task kanban (cards open a zellij session). Terminals = the live zellij
// session list, opened in a side terminal (full terminal experience). This keeps
// raw sessions OUT of the kanban (per product direction) while still one click away.
#if os(macOS)
import SwiftUI
import DesignSystem
import MatrixTerminal

struct RootShellView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Group {
            if model.phase == .needsProfile {
                // Onboarding/sign-in takes the whole window (no rail yet).
                BoardView(model: model)
            } else {
                HStack(spacing: 0) {
                    Sidebar(model: model)
                    Rectangle().fill(Color.hairlineDark).frame(width: 1)
                    sectionContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .background(Color.canvasVoid)
    }

    @ViewBuilder
    private var sectionContent: some View {
        switch model.section {
        case .board:
            BoardView(model: model)
        case .terminals:
            TerminalsView(model: model)
        }
    }
}

/// Narrow left rail with section icons + a context "+" (new task / new session).
private struct Sidebar: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: Spacing.x2) {
            ForEach(AppSection.allCases, id: \.self) { section in
                railButton(section)
            }
            Divider().overlay(Color.hairlineDark).padding(.vertical, Spacing.x1)
            addButton
            Spacer()
            handleBadge
        }
        .padding(.vertical, Spacing.x3)
        .frame(width: 60)
        .frame(maxHeight: .infinity)
        .background(Color.surfaceRail)
    }

    private func railButton(_ section: AppSection) -> some View {
        let active = model.section == section
        return Button { model.section = section } label: {
            VStack(spacing: 3) {
                Image(systemName: section.symbol)
                    .font(.system(size: 16, weight: .medium))
                Text(section.title)
                    .font(.plexMono(8, weight: .medium))
                    .tracking(0.3)
            }
            .foregroundStyle(active ? Color.signalLive : Color.inkTertiary)
            .frame(width: 48, height: 44)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(active ? Color.surfaceCardRaised : Color.clear)
            )
        }
        .buttonStyle(.plain)
        .help(section.title)
    }

    private var addButton: some View {
        Button {
            if model.section == .terminals { model.createSession() } else { model.createTask(status: .todo) }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Color.canvasVoid)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color.signalLive))
        }
        .buttonStyle(.plain)
        .disabled(model.isCreatingSession)
        .help(model.section == .terminals ? "New session" : "New task (⌘N)")
    }

    private var handleBadge: some View {
        Text(String((model.profile?.handle ?? "?").prefix(2)).uppercased())
            .font(.plexMono(10, weight: .semibold))
            .foregroundStyle(Color.inkSecondary)
            .frame(width: 30, height: 30)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(Color.surfaceCard)
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .strokeBorder(Color.hairlineHighlight, lineWidth: 1))
            )
            .help(model.profile?.handle ?? "")
    }
}

/// Terminals section: list of live zellij sessions on the left, full terminal on
/// the right (resizable). One click opens the session over the gateway shell WS.
private struct TerminalsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        HSplitView {
            sessionList
                .frame(minWidth: 220, idealWidth: 300, maxWidth: 420, maxHeight: .infinity)
            terminalPane
                .frame(minWidth: 380, maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var sessionList: some View {
        VStack(spacing: 0) {
            HStack {
                Text("TERMINALS")
                    .font(.plexMono(11, weight: .semibold)).tracking(1.32)
                    .foregroundStyle(Color.inkTertiary)
                Spacer()
                Text("\(model.sessions.count)")
                    .font(.plexMono(11)).foregroundStyle(Color.inkTertiary)
                Button { model.createSession() } label: {
                    Image(systemName: "plus").font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Color.inkSecondary)
                }
                .buttonStyle(.plain).disabled(model.isCreatingSession)
            }
            .padding(.horizontal, Spacing.x3).padding(.vertical, Spacing.x3)

            ScrollView {
                LazyVStack(spacing: Spacing.x1) {
                    ForEach(model.sessions) { session in
                        sessionRow(session)
                    }
                }
                .padding(.horizontal, Spacing.x2)
            }
            if model.sessions.isEmpty {
                Spacer()
                Text("No sessions yet — press + to start one.")
                    .font(.plexSans(12)).foregroundStyle(Color.inkTertiary)
                    .padding(Spacing.x4)
                Spacer()
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color.surfaceRail)
    }

    private func sessionRow(_ session: WorkspaceSession) -> some View {
        let selected = model.selectedCard?.id == session.name
        return Button { model.openSession(named: session.name) } label: {
            HStack(spacing: Spacing.x2) {
                Circle()
                    .fill(session.isActive ? Color.signalLive : Color.inkTertiary)
                    .frame(width: 7, height: 7)
                Text(session.name)
                    .font(.plexMono(12)).foregroundStyle(Color.inkPrimary)
                    .lineLimit(1).truncationMode(.middle)
                Spacer()
            }
            .padding(.horizontal, Spacing.x3).padding(.vertical, Spacing.x2)
            .background(
                RoundedRectangle(cornerRadius: Radius.badge, style: .continuous)
                    .fill(selected ? Color.surfaceCardRaised : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var terminalPane: some View {
        if let terminal = model.terminal {
            TerminalPanelView(session: terminal)
                .background(Color.surfaceTerminal)
        } else {
            ZStack {
                Color.surfaceTerminal
                VStack(spacing: Spacing.x2) {
                    Image(systemName: "terminal")
                        .font(.system(size: 28, weight: .light))
                        .foregroundStyle(Color.inkTertiary)
                    Text("Select a session to open its terminal")
                        .font(.plexSans(13)).foregroundStyle(Color.inkSecondary)
                }
            }
        }
    }
}
#endif
