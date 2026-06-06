// Matrix OS — project picker: switch / create / clone projects.
//
// Lives at the top of the left rail. Shows the active project and a menu to:
//   * switch to any of `model.projects` (calls `openProject(slug:)`),
//   * create a new empty project ("New project…"),
//   * clone a git repo into a new project ("Clone repo…").
//
// Create/clone open a small native sheet (Form) that calls
// `model.createProject(name:remote:startMode:)` — remote nil = empty, non-nil = clone/sync.
// All styling references DesignSystem tokens only (design.md).
#if os(macOS)
import SwiftUI
import AppKit
import DesignSystem

/// The mode the create/clone sheet is presented in.
enum ProjectSheetMode: Identifiable {
    case create
    case clone
    var id: Int { self == .create ? 0 : 1 }

    var title: String { self == .create ? "New Project" : "Clone Repository" }
    var confirmLabel: String { self == .create ? "Create" : "Clone" }
    var needsRemote: Bool { self == .clone }
}

/// Project switcher shown as direct project squares in the left rail. Project
/// selection is explicit: clicking a square opens that project's kanban board.
struct ProjectPickerRail: View {
    @ObservedObject var model: AppModel
    let collapsed: Bool
    @State private var sheet: ProjectSheetMode?

    private var activeName: String {
        model.projects.first { $0.slug == model.projectSlug }?.name ?? model.projectSlug
    }

    private var activeInitials: String {
        let parts = activeName
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
        let raw = parts.prefix(2).compactMap { $0.first }.map(String.init).joined()
        return (raw.isEmpty ? String(activeName.prefix(2)) : raw).uppercased()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.x2) {
            if model.projects.isEmpty {
                emptyProjectState
            } else if collapsed {
                VStack(spacing: Spacing.x2) {
                    ForEach(model.projects.prefix(8)) { project in
                        ProjectSquareButton(
                            project: project,
                            isActive: model.hasSelectedProject && project.slug == model.projectSlug,
                            compact: true,
                            onOpen: { model.openProject(slug: project.slug) }
                        )
                    }
                    NewProjectSquare(compact: true) { sheet = .create }
                }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: Spacing.x2)], spacing: Spacing.x2) {
                    ForEach(model.projects) { project in
                        ProjectSquareButton(
                            project: project,
                            isActive: model.hasSelectedProject && project.slug == model.projectSlug,
                            compact: false,
                            onOpen: { model.openProject(slug: project.slug) }
                        )
                    }
                    NewProjectSquare(compact: false) { sheet = .create }
                }
            }
        }
        .help("Project: \(activeName)")
        .sheet(item: $sheet) { mode in
            ProjectCreateSheet(mode: mode) { name, remote, startMode in
                model.createProject(name: name, remote: remote, startMode: startMode)
            }
        }
    }

    private var emptyProjectState: some View {
        VStack(alignment: .leading, spacing: Spacing.x2) {
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 18, weight: .light))
                .foregroundStyle(Color.signalLive)
            Text("No projects")
                .font(.plexSans(12, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
            Button("Create project") { sheet = .create }
                .font(.plexSans(12, weight: .medium))
        }
        .padding(Spacing.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Color.hairlineDark, lineWidth: 1))
    }
}

private struct NewProjectSquare: View {
    let compact: Bool
    let onCreate: () -> Void

    var body: some View {
        Button(action: onCreate) {
            VStack(spacing: compact ? 0 : Spacing.x1) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.surfaceCard)
                    Image(systemName: "plus")
                        .font(.system(size: compact ? 16 : 18, weight: .semibold))
                        .foregroundStyle(Color.signalLive)
                }
                .frame(width: compact ? 42 : 54, height: compact ? 42 : 54)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.hairlineDark, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                )
                if !compact {
                    Text("New")
                        .font(.plexSans(11, weight: .medium))
                        .foregroundStyle(Color.inkSecondary)
                }
            }
            .frame(maxWidth: compact ? 46 : .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("New project")
        .accessibilityLabel("New project")
    }
}

private struct ProjectSquareButton: View {
    let project: ProjectSummary
    let isActive: Bool
    let compact: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(spacing: compact ? 0 : Spacing.x1) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(isActive ? Color.signalLive : Color.surfaceCard)
                    Text(initials)
                        .font(.plexMono(compact ? 12 : 14, weight: .semibold))
                        .foregroundStyle(isActive ? Color.canvasVoid : Color.inkPrimary)
                }
                .frame(width: compact ? 42 : 54, height: compact ? 42 : 54)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(isActive ? Color.signalLive : Color.hairlineDark, lineWidth: 1)
                )
                if !compact {
                    Text(project.name)
                        .font(.plexSans(11, weight: isActive ? .semibold : .medium))
                        .foregroundStyle(isActive ? Color.inkPrimary : Color.inkSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 76)
                }
            }
            .frame(maxWidth: compact ? 46 : .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(project.name)
        .accessibilityLabel(project.name)
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
    }

    private var initials: String {
        let parts = project.name
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
        let raw = parts.prefix(2).compactMap { $0.first }.map(String.init).joined()
        return (raw.isEmpty ? String(project.name.prefix(2)) : raw).uppercased()
    }
}

struct NewProjectButton: View {
    @ObservedObject var model: AppModel
    @State private var sheet: ProjectSheetMode?

    var body: some View {
        Button { sheet = .create } label: {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.inkSecondary)
                .iconHitTarget(28)
        }
        .buttonStyle(.plain)
        .help("New project")
        .sheet(item: $sheet) { mode in
            ProjectCreateSheet(mode: mode) { name, remote, startMode in
                model.createProject(name: name, remote: remote, startMode: startMode)
            }
        }
    }
}

/// Native sheet to create an empty project or clone a git remote into one.
struct ProjectCreateSheet: View {
    let mode: ProjectSheetMode
    /// (name, remote?, start mode) — remote is nil for an empty project.
    let onConfirm: (String, String?, ProjectStartMode) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var remote = ""
    @State private var colorHex = "#ef4444"
    @State private var startMode: ProjectStartMode = .scratch

    init(mode: ProjectSheetMode, onConfirm: @escaping (String, String?, ProjectStartMode) -> Void) {
        self.mode = mode
        self.onConfirm = onConfirm
        _startMode = State(initialValue: mode.needsRemote ? .github : .scratch)
    }

    private var trimmedRemote: String {
        remote.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// For clone, a remote is required; the name can be derived from it if blank.
    private var canConfirm: Bool {
        switch startMode {
        case .scratch:
            return !trimmedName.isEmpty
        case .github:
            return !trimmedRemote.isEmpty
        case .linear:
            return false
        }
    }

    /// Derives a project name from a git remote URL when the field is left blank.
    private var resolvedName: String {
        if !trimmedName.isEmpty { return trimmedName }
        guard mode.needsRemote || startMode == .github else { return trimmedName }
        let last = trimmedRemote
            .split(separator: "/").last.map(String.init) ?? trimmedRemote
        return last.replacingOccurrences(of: ".git", with: "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.x4) {
            HStack {
                Text(mode.title)
                    .font(.plexSans(24, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.inkTertiary)
                        .iconHitTarget(34)
                }
                .buttonStyle(.plain)
            }

            VStack(alignment: .leading, spacing: Spacing.x2) {
                fieldLabel("Name")
                TextField("Project name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .font(.plexSans(17))

                fieldLabel("Repository Path")
                    .padding(.top, Spacing.x2)
                HStack(spacing: Spacing.x2) {
                    TextField("/path/to/repo or https://github.com/org/repo.git", text: $remote)
                        .textFieldStyle(.roundedBorder)
                        .font(.plexSans(15))
                    Button { chooseRepositoryPath() } label: {
                        Image(systemName: "folder")
                            .font(.system(size: 16, weight: .semibold))
                            .iconHitTarget(42)
                    }
                    .buttonStyle(.bordered)
                }
                Text("Matrix opens agent terminals in this directory when a repository is provided.")
                    .font(.plexSans(13))
                    .foregroundStyle(Color.inkTertiary)

                fieldLabel("Color")
                    .padding(.top, Spacing.x2)
                HStack(spacing: Spacing.x3) {
                    RoundedRectangle(cornerRadius: Radius.badge, style: .continuous)
                        .fill(projectColor)
                        .frame(width: 28, height: 28)
                    TextField("#ef4444", text: $colorHex)
                        .textFieldStyle(.plain)
                        .font(.plexMono(16, weight: .medium))
                }
                .padding(.horizontal, Spacing.x3)
                .frame(height: 44)
                .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Color.hairlineDark, lineWidth: 1))

                fieldLabel("How do you want to start this project?")
                    .padding(.top, Spacing.x2)
                VStack(spacing: Spacing.x2) {
                    startOption(.scratch, title: "Start from scratch", subtitle: "Create tasks manually and configure integrations later.")
                    startOption(.github, title: "Sync with GitHub Projects", subtitle: "Set up project-scoped sync from a GitHub Project board.")
                    startOption(.linear, title: "Sync with Linear", subtitle: "Set up project-scoped sync from a Linear team or project.", isEnabled: false, badge: "Coming soon")
                }
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(mode.confirmLabel) {
                    onConfirm(resolvedName, trimmedRemote.isEmpty ? nil : trimmedRemote, startMode)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canConfirm)
            }
        }
        .padding(Spacing.x6)
        .frame(width: 620)
        .background(Color.canvasVoid)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.plexSans(16, weight: .semibold))
            .foregroundStyle(Color.inkPrimary)
    }

    private var projectColor: Color {
        let trimmed = colorHex.trimmingCharacters(in: CharacterSet(charactersIn: "#").union(.whitespacesAndNewlines))
        guard trimmed.count == 6, let value = Int(trimmed, radix: 16) else {
            return Color.signalBlocked
        }
        return Color(
            red: Double((value >> 16) & 0xff) / 255.0,
            green: Double((value >> 8) & 0xff) / 255.0,
            blue: Double(value & 0xff) / 255.0
        )
    }

    private func startOption(_ option: ProjectStartMode, title: String, subtitle: String, isEnabled: Bool = true, badge: String? = nil) -> some View {
        Button {
            if isEnabled {
                startMode = option
            }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Spacing.x2) {
                    Text(title)
                        .font(.plexSans(16, weight: .semibold))
                        .foregroundStyle(isEnabled ? Color.inkPrimary : Color.inkTertiary)
                    if let badge {
                        Text(badge)
                            .font(.plexSans(11, weight: .semibold))
                            .foregroundStyle(Color.inkTertiary)
                            .padding(.horizontal, Spacing.x2)
                            .frame(height: 20)
                            .background(Color.surfaceRail, in: Capsule())
                    }
                }
                Text(subtitle)
                    .font(.plexSans(14))
                    .foregroundStyle(Color.inkTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Spacing.x3)
            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(startMode == option ? Color.inkPrimary : Color.hairlineDark, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }

    private func chooseRepositoryPath() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            remote = url.path
            if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                name = url.lastPathComponent
            }
        }
    }
}
#endif
