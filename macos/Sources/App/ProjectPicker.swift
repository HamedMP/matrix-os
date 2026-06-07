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

/// Compact project switcher shown at the top of the left rail. A `Menu` keeps it
/// native and keyboard-reachable; the trigger shows the active project initial.
struct ProjectPickerRail: View {
    @ObservedObject var model: AppModel
    var collapsed = false
    @State private var sheet: ProjectSheetMode?

    private var activeName: String {
        model.projects.first { $0.slug == model.projectSlug }?.name ?? model.projectSlug
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
            Text(String(activeName.prefix(2)).uppercased())
                .font(.plexMono(11, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
                .frame(width: 36, height: 36)
                .background(
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .fill(Color.surfaceCard)
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
                        )
                )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
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
            Text(mode.title)
                .font(.plexSans(16, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)

            Form {
                if mode.needsRemote {
                    TextField("Git remote URL", text: $remote, prompt: Text("https://github.com/org/repo.git"))
                        .textFieldStyle(.roundedBorder)
                    TextField("Project name (optional)", text: $name, prompt: Text("Derived from URL"))
                        .textFieldStyle(.roundedBorder)
                } else {
                    TextField("Project name", text: $name, prompt: Text("My project"))
                        .textFieldStyle(.roundedBorder)
                }
            }
            .font(.plexSans(13))

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(mode.confirmLabel) {
                    onConfirm(resolvedName, mode.needsRemote ? trimmedRemote : nil)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canConfirm)
            }
        }
        .padding(Spacing.x5)
        .frame(width: 420)
        .background(Color.canvasVoid)
    }
}
#endif
