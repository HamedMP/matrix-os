// Matrix OS — board card (design.md §6.2).
//
// Layout: left signal edge bar (3pt, color = status; glows/breathes when live) ·
// Plex Sans 14 title · mono meta row (session name, worktree/branch, relative time)
// · status badge. Selected card carries a persistent ink hairline + faint signal
// tint (spatial memory, §6.2). Hover raises to surface.cardRaised with no layout
// shift. A value-type SwiftUI view — never rebuilds the whole list.
#if os(macOS)
import SwiftUI
import DesignSystem
import MatrixModel

struct CardView: View {
    let card: Card
    let isSelected: Bool
    let onOpen: () -> Void

    @State private var isHovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 0) {
                signalEdge
                content
            }
            .background(surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(border)
            .overlay(alignment: .leading) { liveGlow }
            .shadow(color: isHovered ? Color.black.opacity(0.35) : .clear, radius: isHovered ? 10 : 0, y: isHovered ? 2 : 0)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(reduceMotion ? nil : Motion.hover) { isHovered = hovering }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(card.title), \(card.status.rawValue)")
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - Signal edge

    private var signalEdge: some View {
        Rectangle()
            .fill(edgeColor)
            .frame(width: 3)
            .opacity(card.isLive ? 1 : 0.7)
    }

    /// Left-edge phosphor bloom on live cards (signal.glow.live). Breathes on a
    /// 2.4s loop; Reduce Motion shows a steady glow.
    @ViewBuilder
    private var liveGlow: some View {
        if card.isLive {
            LiveEdgeGlow(reduceMotion: reduceMotion)
                .allowsHitTesting(false)
        }
    }

    private var edgeColor: Color {
        switch card.status {
        case .todo: return .signalIdle
        case .running: return .signalLive
        case .waiting: return .signalWaiting
        case .blocked: return .signalBlocked
        case .complete: return .signalDone
        case .archived: return .signalIdle
        }
    }

    // MARK: - Content

    private var content: some View {
        VStack(alignment: .leading, spacing: Spacing.x2) {
            HStack(alignment: .top, spacing: Spacing.x2) {
                Text(card.title)
                    .font(.plexSans(14, weight: .medium))
                    .tracking(-0.14)
                    .foregroundStyle(Color.inkPrimary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                StatusBadge(status: card.status)
            }
            metaRow
        }
        .padding(.horizontal, Spacing.x3)
        .padding(.vertical, Spacing.x3)
    }

    private var metaRow: some View {
        HStack(spacing: Spacing.x2) {
            if let session = card.linkedSessionId, !session.isEmpty {
                metaItem(text: session)
            }
            if let worktree = card.linkedWorktreeId, !worktree.isEmpty {
                metaItem(text: worktree, separator: true)
            }
            Spacer(minLength: Spacing.x1)
            Text(RelativeTime.compact(card.updatedAt))
                .font(.plexMono(11))
                .tracking(0.22)
                .foregroundStyle(Color.inkTertiary)
        }
    }

    private func metaItem(text: String, separator: Bool = false) -> some View {
        HStack(spacing: Spacing.x1) {
            if separator {
                Text("·")
                    .font(.plexMono(11))
                    .foregroundStyle(Color.inkDisabled)
            }
            Text(text)
                .font(.plexMono(11))
                .tracking(0.22)
                .foregroundStyle(Color.inkSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    // MARK: - Surface / border

    private var surface: Color {
        isHovered ? .surfaceCardRaised : .surfaceCard
    }

    @ViewBuilder
    private var border: some View {
        if isSelected {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(Color.inkPrimary.opacity(0.5), lineWidth: 1)
                .background(
                    RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                        .fill(edgeColor.opacity(0.06))
                )
        } else {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
        }
    }
}

/// Left-edge radial phosphor bloom that breathes (opacity 0.12↔0.26, 2.4s loop).
private struct LiveEdgeGlow: View {
    let reduceMotion: Bool
    @State private var bright = false

    var body: some View {
        LinearGradient(
            colors: [Color.signalLive.opacity(0.5), .clear],
            startPoint: .leading,
            endPoint: .trailing
        )
        .frame(width: 36)
        .blur(radius: 8)
        .opacity(reduceMotion ? 0.20 : (bright ? 0.26 : 0.12))
        .animation(reduceMotion ? nil : Motion.liveBreathe, value: bright)
        .onAppear { if !reduceMotion { bright = true } }
    }
}
#endif
