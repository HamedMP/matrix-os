// Matrix OS — project picker: switch / create / clone projects.
//
// Lives at the top of the left rail. Shows the active project and a menu to:
//   * switch to any of `model.projects` (calls `openProject(slug:)`),
//   * create a new empty project ("New project…"),
//   * clone a git repo into a new project ("Clone repo…").
//
// Create/clone open a small native sheet (Form) that calls
// `model.createProject(name:remote:)` — remote nil = empty, non-nil = clone.
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

/// Project switcher shown at the top of the left rail. A `Menu` keeps it native
/// and keyboard-reachable while the trigger keeps the selected project legible.
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
        Menu {
            if model.projects.isEmpty {
                Text("No projects yet")
            } else {
                ForEach(model.projects) { project in
                    Button {
                        model.openProject(slug: project.slug)
                    } label: {
                        Label(
                            project.name,
                            systemImage: project.slug == model.projectSlug ? "checkmark" : "folder"
                        )
                    }
                }
            }
            Divider()
            Button { sheet = .create } label: { Label("New project…", systemImage: "plus") }
            Button { sheet = .clone } label: { Label("Clone repo…", systemImage: "arrow.down.doc") }
        } label: {
            if collapsed {
                ZStack(alignment: .bottomTrailing) {
                    Text(activeInitials)
                        .font(.plexMono(11, weight: .semibold))
                        .foregroundStyle(Color.canvasVoid)
                        .frame(width: 42, height: 42)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(Color.signalLive)
                        )
                    Image(systemName: "chevron.down")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(Color.inkSecondary)
                        .frame(width: 16, height: 16)
                        .background(Circle().fill(Color.surfaceCard))
                        .offset(x: 4, y: 4)
                }
                    .frame(width: 52, height: 48)
                    .background(
                        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            .fill(Color.surfaceCardRaised)
                            .overlay(
                                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                    .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
                            )
                    )
                    .contentShape(Rectangle())
            } else {
                VStack(alignment: .leading, spacing: Spacing.x1) {
                    HStack(spacing: Spacing.x1) {
                        Image(systemName: "folder")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color.signalLive)
                        Text("PROJECT")
                            .font(.plexMono(8, weight: .semibold))
                            .tracking(0.7)
                            .foregroundStyle(Color.inkTertiary)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(Color.inkTertiary)
                    }
                    Text(activeName)
                        .font(.plexSans(12, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .padding(.horizontal, Spacing.x3)
                .padding(.vertical, Spacing.x2)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                        .fill(Color.surfaceCard)
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                                .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
                        )
                        .shadow(color: Color.black.opacity(0.06), radius: 6, y: 2)
                )
                .contentShape(Rectangle())
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .help("Project: \(activeName)")
        .sheet(item: $sheet) { mode in
            ProjectCreateSheet(mode: mode) { name, remote in
                model.createProject(name: name, remote: remote)
            }
        }
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
            ProjectCreateSheet(mode: mode) { name, remote in
                model.createProject(name: name, remote: remote)
            }
        }
    }
}

/// Native sheet to create an empty project or clone a git remote into one.
struct ProjectCreateSheet: View {
    let mode: ProjectSheetMode
    /// (name, remote?) — remote is nil for an empty project.
    let onConfirm: (String, String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var remote = ""
    @State private var colorHex = "#ef4444"
    @State private var startMode: ProjectStartMode = .scratch

    private var trimmedRemote: String {
        remote.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// For clone, a remote is required; the name can be derived from it if blank.
    private var canConfirm: Bool {
        if mode.needsRemote {
            return !trimmedRemote.isEmpty
        }
        return !trimmedName.isEmpty
    }

    /// Derives a project name from a git remote URL when the field is left blank.
    private var resolvedName: String {
        if !trimmedName.isEmpty { return trimmedName }
        guard mode.needsRemote else { return trimmedName }
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
                    startOption(.linear, title: "Sync with Linear", subtitle: "Set up project-scoped sync from a Linear team or project.")
                }
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(mode.confirmLabel) {
                    onConfirm(resolvedName, trimmedRemote.isEmpty ? nil : trimmedRemote)
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

    private func startOption(_ option: ProjectStartMode, title: String, subtitle: String) -> some View {
        Button { startMode = option } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.plexSans(16, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
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

private enum ProjectStartMode: String, CaseIterable {
    case scratch
    case github
    case linear
}
#endif
