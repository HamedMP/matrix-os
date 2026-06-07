// Matrix OS — onboarding / loading / disconnected chrome (design.md §6.6).
//
// Onboarding-as-empty-state: calm, never an error. The "no VPS" state centers an
// engraved Matrix glyph + headline + one line of copy + a primary CTA. The board
// loading state is one orchestrated skeleton with a single sweeping shimmer (not
// per-card spinners). The disconnected state is a top amber inset bar; the board
// behind it goes read-only with a faint desaturation.
#if os(macOS)
import SwiftUI
import DesignSystem

/// "No Matrix computer yet" onboarding empty state. The CTA hands off to the
/// platform flow (wired by the host scene).
struct NoProfileView: View {
    let onCreate: () -> Void
    var onSignIn: () -> Void = {}
    var onCancelSignIn: () -> Void = {}
    var signIn: SignInState = .idle

    var body: some View {
        ZStack {
            Color.canvasVoid.ignoresSafeArea()
            VStack(spacing: Spacing.x4) {
                glyph
                Text("No Matrix computer yet")
                    .font(.plexSans(20, weight: .semibold))
                    .tracking(-0.4)
                    .foregroundStyle(Color.inkPrimary)
                Text("Sign in to see your sessions as a live board and work in a\nterminal — or create your Matrix OS if you don't have one.")
                    .font(.plexSans(13))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.inkSecondary)

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
                        .padding(.top, Spacing.x1)
                }
            }
            .padding(Spacing.x7)
        }
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
                Text("Create your Matrix OS")
                    .font(.plexSans(12, weight: .medium))
                    .foregroundStyle(Color.inkSecondary)
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
                .fill(Color.surfaceCard)
                .frame(width: 72, height: 72)
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                        .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
                )
            Circle()
                .fill(Color.signalLive)
                .frame(width: 12, height: 12)
                .shadow(color: Color.signalGlowLive, radius: 8)
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

struct MatrixComputerHomeView: View {
    @ObservedObject var model: AppModel
    let onOpenShell: () -> Void

    var body: some View {
        VStack(spacing: Spacing.x6) {
            Spacer(minLength: 0)
            VStack(spacing: Spacing.x2) {
                Image(systemName: "server.rack")
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(Color.signalLive)
                Text("Start coding on your Matrix computer")
                    .font(.plexSans(24, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
                Text("Open a project board or start a shell session on your private runtime.")
                    .font(.plexSans(14))
                    .foregroundStyle(Color.inkSecondary)
                    .multilineTextAlignment(.center)
            }

            HStack(spacing: Spacing.x3) {
                homeAction("Create project", icon: "folder.badge.plus") {
                    model.createProject(name: "New project", remote: nil)
                }
                homeAction("Open shell", icon: "terminal") {
                    onOpenShell()
                }
                homeAction("New task", icon: "plus.rectangle") {
                    model.createTask(status: .todo)
                }
            }
            .frame(maxWidth: 760)
            Spacer(minLength: 0)
        }
        .padding(Spacing.x6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.canvasVoid)
    }

    private func homeAction(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: Spacing.x3) {
                Image(systemName: icon)
                    .font(.system(size: 24, weight: .light))
                    .foregroundStyle(Color.signalLive)
                Text(title)
                    .font(.plexSans(14, weight: .semibold))
                    .foregroundStyle(Color.inkPrimary)
            }
            .frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
            .padding(Spacing.x4)
            .background(Color.surfaceCard, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Color.hairlineDark, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

struct ProjectSelectionRequiredView: View {
    var body: some View {
        VStack(spacing: Spacing.x3) {
            Image(systemName: "rectangle.split.3x1")
                .font(.system(size: 38, weight: .light))
                .foregroundStyle(Color.signalLive)
            Text("Select a project")
                .font(.plexSans(20, weight: .semibold))
                .foregroundStyle(Color.inkPrimary)
            Text("Choose a project in the sidebar to open its kanban board.")
                .font(.plexSans(13))
                .foregroundStyle(Color.inkSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.canvasVoid)
    }
}
#endif
