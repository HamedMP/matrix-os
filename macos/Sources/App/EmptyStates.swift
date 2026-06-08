// Matrix OS — onboarding / loading / disconnected chrome (design.md §6.6).
//
// Onboarding-as-empty-state: calm, never an error. The "no VPS" state centers an
// engraved Matrix glyph + headline + one line of copy + a primary CTA. The board
// loading state is one orchestrated skeleton with a single sweeping shimmer (not
// per-card spinners). The disconnected state is a top amber inset bar; the board
// behind it goes read-only with a faint desaturation.
#if os(macOS)
import SwiftUI
import AppKit
import DesignSystem

/// "No Matrix computer yet" onboarding empty state. The CTA hands off to the
/// platform flow (wired by the host scene).
struct NoProfileView: View {
    let onCreate: () -> Void
    var onSignIn: () -> Void = {}
    var onCancelSignIn: () -> Void = {}
    var signIn: SignInState = .idle

    var body: some View {
        HStack(spacing: 0) {
            onboardingBrandPanel
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
            VStack(spacing: Spacing.x5) {
                Spacer()
                authCard
                Spacer()
            }
            .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.canvasVoid)
        }
        .background(Color.canvasVoid.ignoresSafeArea())
    }

    private var onboardingBrandPanel: some View {
        ZStack(alignment: .leading) {
            Color.signalLive
            VStack(alignment: .leading, spacing: Spacing.x5) {
                glyph
                VStack(alignment: .leading, spacing: Spacing.x2) {
                    Text("Matrix OS")
                        .font(.plexSans(38, weight: .semibold))
                        .foregroundStyle(Color.canvasVoid)
                    Text("Code on your\ncloud computer.")
                        .font(.plexSans(30, weight: .semibold))
                        .foregroundStyle(Color.canvasVoid)
                        .lineSpacing(2)
                }
                Text("Every user gets a private VPS with shell, files, projects, agents, and review tools in one native app.")
                    .font(.plexSans(15))
                    .foregroundStyle(Color.canvasVoid.opacity(0.82))
                    .lineSpacing(3)
                    .frame(maxWidth: 360, alignment: .leading)
                VStack(alignment: .leading, spacing: Spacing.x3) {
                    brandBullet("checkmark.circle", "No local setup required")
                    brandBullet("chevron.left.forwardslash.chevron.right", "Works with GitHub")
                    brandBullet("sparkles", "Claude / Codex / OpenCode ready")
                }
                Spacer()
            }
            .padding(Spacing.x7)
        }
    }

    private var authCard: some View {
        VStack(spacing: Spacing.x4) {
            VStack(spacing: Spacing.x1) {
                Text("Welcome to Matrix OS")
                    .font(.plexSans(24, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Text("Sign in to your account or create a new one to get started.")
                    .font(.plexSans(13))
                    .foregroundStyle(Color.inkTertiary)
            }
            switch signIn {
            case .awaitingApproval(let code, let uri):
                approvalCard(code: code, uri: uri)
            default:
                actions
            }
            if case .failed(let message) = signIn {
                Text(message)
                    .font(.plexMono(11))
                    .foregroundStyle(Color.signalWaiting)
            }
        }
        .padding(Spacing.x6)
        .frame(width: 390)
        .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).strokeBorder(Color.hairlineDark, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.12), radius: 28, y: 16)
    }

    private var actions: some View {
        VStack(spacing: Spacing.x3) {
            Button(action: onSignIn) {
                HStack(spacing: Spacing.x2) {
                    if case .starting = signIn { ProgressView().controlSize(.small) }
                    Text(isStarting ? "Starting sign-in…" : "Sign in")
                        .font(.plexSans(13, weight: .semibold))
                        .foregroundStyle(Color.canvasVoid)
                }
                .padding(.horizontal, Spacing.x4)
                .padding(.vertical, Spacing.x2)
                .background(
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .fill(Color.signalLive)
                )
            }
            .buttonStyle(.plain)
            .disabled(isStarting)

            Button(action: onCreate) {
                Text("Create account")
                    .font(.plexSans(12, weight: .medium))
                    .foregroundStyle(Color.signalLive)
            }
            .buttonStyle(.plain)
        }
        .padding(.top, Spacing.x2)
    }

    private var isStarting: Bool { if case .starting = signIn { return true }; return false }

    /// Device-approval card: shows the user code + a hint that the browser is open.
    private func approvalCard(code: String, uri: String) -> some View {
        VStack(spacing: Spacing.x3) {
            Text("Approve in your browser")
                .font(.plexSans(13, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
            Text("Enter this code if prompted:")
                .font(.plexSans(11))
                .foregroundStyle(Color.inkSecondary)
            Text(code)
                .font(.plexMono(22, weight: .semibold))
                .tracking(4)
                .foregroundStyle(Color.signalLive)
                .padding(.horizontal, Spacing.x4)
                .padding(.vertical, Spacing.x2)
                .background(
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .fill(Color.surfaceCard)
                        .overlay(
                            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
                        )
                )
            HStack(spacing: Spacing.x2) {
                ProgressView().controlSize(.small)
                Text("Waiting for approval…")
                    .font(.plexMono(11))
                    .foregroundStyle(Color.inkSecondary)
            }
            Button("Cancel", action: onCancelSignIn)
                .buttonStyle(.plain)
                .font(.plexSans(11))
                .foregroundStyle(Color.inkTertiary)
        }
        .padding(.top, Spacing.x2)
    }

    /// Engraved Matrix glyph: a recessed rounded square with a phosphor signal dot.
    private var glyph: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                .fill(Color.canvasVoid.opacity(0.16))
                .frame(width: 72, height: 72)
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                        .strokeBorder(Color.canvasVoid.opacity(0.35), lineWidth: 1)
                )
            VStack(spacing: 4) {
                ForEach(0..<6, id: \.self) { row in
                    HStack(spacing: 5) {
                        ForEach(0..<(row + 1), id: \.self) { _ in
                            Circle().fill(Color.canvasVoid).frame(width: 5, height: 5)
                        }
                    }
                }
            }
        }
    }

    private func brandBullet(_ icon: String, _ text: String) -> some View {
        HStack(spacing: Spacing.x2) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .frame(width: 20)
            Text(text)
                .font(.plexSans(13, weight: .medium))
        }
        .foregroundStyle(Color.canvasVoid.opacity(0.92))
    }
}

struct MatrixComputerHomeView: View {
    @ObservedObject var model: AppModel
    let onOpenShell: () -> Void
    @State private var projectSheet: ProjectSheetMode?

    var body: some View {
        ScrollView {
            VStack(spacing: Spacing.x6) {
                VStack(spacing: Spacing.x2) {
                    Text("Start coding on your Matrix computer")
                        .font(.plexSans(34, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                    Text("This is your private cloud computer, ready for engineering work.\nBuild, test, and ship securely from one native workspace.")
                        .font(.plexSans(16))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Color.inkTertiary)
                        .lineSpacing(3)
                }
                HStack(spacing: Spacing.x4) {
                    homeAction("folder.badge.plus", "Create project", "Start from scratch or use a template.", action: { projectSheet = .create })
                    homeAction("folder", "Open folder on Matrix", "Open an existing repository or folder from your computer.", action: { projectSheet = .clone })
                    homeAction("terminal", "Open shell", "Launch a web shell and start working in your Matrix computer.", action: onOpenShell)
                }
                shellPreview
            }
            .padding(Spacing.x7)
            .frame(maxWidth: 1180)
            .frame(maxWidth: .infinity)
        }
        .background(Color.canvasVoid)
        .sheet(item: $projectSheet) { mode in
            ProjectCreateSheet(mode: mode) { name, remote, startMode in
                model.createProject(name: name, remote: remote, startMode: startMode)
            }
        }
    }

    private func homeAction(_ icon: String, _ title: String, _ subtitle: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: Spacing.x3) {
                Image(systemName: icon)
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(Color.signalLive)
                Text(title)
                    .font(.plexSans(18, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Text(subtitle)
                    .font(.plexSans(14))
                    .foregroundStyle(Color.inkTertiary)
                    .lineLimit(2)
                Spacer()
                HStack {
                    Spacer()
                    Image(systemName: "arrow.right")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                        .frame(width: 38, height: 34)
                        .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                }
            }
            .padding(Spacing.x5)
            .frame(maxWidth: .infinity, minHeight: 190, alignment: .leading)
            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).strokeBorder(Color.hairlineDark, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var shellPreview: some View {
        VStack(alignment: .leading, spacing: Spacing.x2) {
            HStack {
                Text("Matrix shell preview")
                    .font(.plexSans(13, weight: .medium))
                    .foregroundStyle(Color.inkTertiary)
                Spacer()
                Button("Open full shell", action: onOpenShell)
                    .font(.plexSans(12, weight: .semibold))
            }
            HStack(spacing: 0) {
                shellPreviewSidebar
                shellPreviewTerminal
            }
            .frame(height: 260)
            .background(Color.surfaceTerminal, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).strokeBorder(Color.black.opacity(0.35), lineWidth: 1))
        }
        .padding(Spacing.x3)
        .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).strokeBorder(Color.hairlineDark, lineWidth: 1))
    }

    private var shellPreviewSidebar: some View {
        VStack(alignment: .leading, spacing: Spacing.x3) {
            Text("Matrix")
                .font(.plexSans(18, weight: .semibold))
                .foregroundStyle(Color.canvasVoid)
            Label("Terminal", systemImage: "terminal")
            Label("Files", systemImage: "folder")
            Label("Processes", systemImage: "cpu")
            Label("Secrets", systemImage: "ellipsis.message")
            Spacer()
        }
        .font(.plexSans(13, weight: .medium))
        .foregroundStyle(Color.canvasVoid.opacity(0.82))
        .padding(Spacing.x4)
        .frame(width: 180, alignment: .leading)
        .frame(maxHeight: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.06))
    }

    private var shellPreviewTerminal: some View {
        VStack(alignment: .leading, spacing: Spacing.x2) {
            Text("matrix ~ $ uname -a")
            Text("Linux matrix-builder 6.6.15-arch1-1")
            Text("matrix ~ $ git status")
            Text("On branch main\nnothing to commit, working tree clean")
            Text("matrix ~ $")
        }
        .font(.plexMono(14))
        .foregroundStyle(Color.terminalInk)
        .padding(Spacing.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct ProjectSelectionRequiredView: View {
    @ObservedObject var model: AppModel
    @State private var sheet: ProjectSheetMode?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.x5) {
                HStack(alignment: .center, spacing: Spacing.x3) {
                    AppGlyphTile(symbol: "rectangle.split.3x1", palette: .tab(.board), size: 46, isActive: true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Projects")
                            .font(.plexSans(28, weight: .semibold))
                            .foregroundStyle(Color.inkPrimary)
                        Text("Open a workspace board or create a new project.")
                            .font(.plexSans(14))
                            .foregroundStyle(Color.inkTertiary)
                    }
                    Spacer()
                    Button {
                        sheet = .create
                    } label: {
                        Label("New Project", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                }

                if model.projects.isEmpty {
                    emptyProjects
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: Spacing.x3)], spacing: Spacing.x3) {
                        ForEach(model.projects) { project in
                            projectCard(project)
                        }
                        createCard
                    }
                }
            }
            .padding(Spacing.x6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.canvasVoid)
        .sheet(item: $sheet) { mode in
            ProjectCreateSheet(mode: mode) { name, remote, startMode in
                model.createProject(name: name, remote: remote, startMode: startMode)
            }
        }
    }

    private var emptyProjects: some View {
        VStack(alignment: .leading, spacing: Spacing.x3) {
            Label("No projects yet", systemImage: "folder.badge.plus")
                .font(.plexSans(16, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
            Text("Create a scratch workspace or clone a GitHub repository to load its tasks.")
                .font(.plexSans(13))
                .foregroundStyle(Color.inkTertiary)
            HStack(spacing: Spacing.x2) {
                Button("Create Project") { sheet = .create }
                    .buttonStyle(.borderedProminent)
                Button("Clone Repository") { sheet = .clone }
                    .buttonStyle(.bordered)
            }
        }
        .padding(Spacing.x5)
        .frame(maxWidth: 520, alignment: .leading)
        .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                .strokeBorder(Color.hairlineDark, lineWidth: 1)
        )
    }

    private func projectCard(_ project: ProjectSummary) -> some View {
        Button {
            model.openProject(slug: project.slug)
        } label: {
            VStack(alignment: .leading, spacing: Spacing.x3) {
                ProjectAvatarIcon(name: project.name, slug: project.slug, isActive: false, size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(project.name)
                        .font(.plexSans(15, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                        .lineLimit(1)
                    Text(project.remote ?? project.slug)
                        .font(.plexSans(12))
                        .foregroundStyle(Color.inkTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                HStack {
                    Text("Open Tasks")
                        .font(.plexSans(12, weight: .semibold))
                    Spacer()
                    Image(systemName: "arrow.right")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(projectAccentColor(slug: project.slug))
            }
            .padding(Spacing.x4)
            .frame(maxWidth: .infinity, minHeight: 160, alignment: .leading)
            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                    .strokeBorder(Color.hairlineDark.opacity(0.8), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Open Tasks") { model.openProject(slug: project.slug) }
            Button("Copy Project Slug") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(project.slug, forType: .string)
            }
        }
    }

    private var createCard: some View {
        Button { sheet = .create } label: {
            VStack(alignment: .leading, spacing: Spacing.x3) {
                Image(systemName: "plus")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Color.signalLive)
                    .frame(width: 44, height: 44)
                    .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.hairlineDark, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    )
                Text("New project")
                    .font(.plexSans(15, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Text("Create or clone a workspace.")
                    .font(.plexSans(12))
                    .foregroundStyle(Color.inkTertiary)
                Spacer()
            }
            .padding(Spacing.x4)
            .frame(maxWidth: .infinity, minHeight: 160, alignment: .leading)
            .background(Color.surfaceRail, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                    .strokeBorder(Color.hairlineDark.opacity(0.8), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Create Project") { sheet = .create }
            Button("Clone Repository") { sheet = .clone }
        }
    }
}

/// Board loading skeleton: a few ghost cards under one orchestrated sweeping
/// shimmer (design.md §6.6) — not per-card spinners. Reduce Motion → static cards.
struct BoardSkeletonView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweep = false

    private let columns = ["TODO", "RUNNING", "WAITING", "BLOCKED", "COMPLETE"]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(columns.enumerated()), id: \.offset) { _, label in
                    VStack(alignment: .leading, spacing: Spacing.x3) {
                        Text(label)
                            .font(.plexMono(11, weight: .semibold))
                            .tracking(1.32)
                            .foregroundStyle(Color.inkTertiary)
                            .padding(.horizontal, Spacing.x3)
                            .padding(.top, Spacing.x3)
                        ForEach(0..<3, id: \.self) { _ in
                            skeletonCard
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(width: 264)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .background(Color.surfaceRail)
                    .overlay(alignment: .trailing) {
                        Rectangle().fill(Color.hairlineDark).frame(width: 1)
                    }
                }
            }
        }
        .background(Color.canvasVoid)
        .overlay { shimmer.allowsHitTesting(false) }
        .onAppear { if !reduceMotion { sweep = true } }
    }

    private var skeletonCard: some View {
        RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
            .fill(Color.surfaceCard)
            .frame(height: 64)
            .overlay(
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
            )
            .padding(.horizontal, Spacing.x2)
    }

    @ViewBuilder
    private var shimmer: some View {
        if reduceMotion {
            EmptyView()
        } else {
            GeometryReader { geo in
                LinearGradient(
                    colors: [.clear, Color.signalIdle.opacity(0.12), .clear],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: geo.size.width * 0.5)
                .offset(x: sweep ? geo.size.width : -geo.size.width * 0.5)
                .animation(
                    .easeInOut(duration: 1.4).repeatForever(autoreverses: false),
                    value: sweep
                )
            }
        }
    }
}

/// Top amber inset bar shown while the live connection is dropped (design.md §6.6).
/// The board behind it stays visible but read-only (view-only, never persisted).
struct ReconnectingBar: View {
    let handle: String

    var body: some View {
        HStack(spacing: Spacing.x2) {
            Circle().fill(Color.signalWaiting).frame(width: 6, height: 6)
            Text("reconnecting to \(handle)…")
                .font(.plexMono(11, weight: .medium))
                .foregroundStyle(Color.signalWaiting)
            Spacer()
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.vertical, Spacing.x2)
        .background(.ultraThinMaterial)
        .background(Color.signalWaiting.opacity(0.10))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.signalWaiting.opacity(0.30)).frame(height: 1)
        }
    }
}

/// Generic, user-safe error banner (FR-023). Never shows raw text.
struct GenericErrorBanner: View {
    let message: String
    let onRetry: (() -> Void)?

    var body: some View {
        HStack(spacing: Spacing.x2) {
            Circle().fill(Color.signalBlocked).frame(width: 6, height: 6)
            Text(message)
                .font(.plexMono(11, weight: .medium))
                .foregroundStyle(Color.inkSecondary)
                .lineLimit(2)
            Spacer()
            if let onRetry {
                Button(action: onRetry) {
                    Text("Retry")
                        .font(.plexMono(11, weight: .semibold))
                        .foregroundStyle(Color.inkPrimary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, Spacing.x4)
        .padding(.vertical, Spacing.x2)
        .background(.ultraThinMaterial)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.hairlineDark).frame(height: 1)
        }
    }
}

#endif
