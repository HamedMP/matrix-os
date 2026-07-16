// Matrix OS — board card (design.md §6.2).
//
// SlayZone/Linear-parity task card. Left signal edge bar (3pt, color = status;
// breathes when live) · Plex Sans 14 title · chip row (priority + status) ·
// optional tag pills · mono meta row (session/worktree affordance + relative
// time). Selected card carries a persistent ink hairline + faint signal tint
// (spatial memory, §6.2). Hover raises to surface.cardRaised with no layout
// shift and a real grab cursor. Draggable by card id for cross-column moves.
// A value-type SwiftUI view — never rebuilds the whole list.
#if os(macOS)
import SwiftUI
import AppKit
import DesignSystem
import MatrixModel

struct CardView: View {
    let card: Card
    let isSelected: Bool
    let onOpen: () -> Void
    var onEdit: () -> Void = {}
    var onArchive: () -> Void = {}
    var onDelete: () -> Void = {}
    var onSetStatus: (TaskStatus) -> Void = { _ in }
    var onSetPriority: (TaskPriority) -> Void = { _ in }

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
            .shadow(color: isHovered ? Color.black.opacity(0.40) : Color.black.opacity(0.18),
                    radius: isHovered ? 12 : 4,
                    y: isHovered ? 4 : 1)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .scaleEffect(isHovered ? 1.012 : 1)
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(reduceMotion ? nil : Motion.hover) { isHovered = hovering }
        }
        // Drag the card id out for cross-column moves (handled by ColumnView's
        // .dropDestination). The lifted preview reuses the same chrome.
        .draggable(card.id) {
            dragPreview
        }
        .contextMenu {
            Button("Open Task", action: onOpen)
            Button("Edit Task", action: onEdit)
            Menu("Status") {
                ForEach(TaskStatus.allCases, id: \.self) { status in
                    Button(status.menuTitle) { onSetStatus(status) }
                }
            }
            Menu("Priority") {
                ForEach(TaskPriority.allCases, id: \.self) { priority in
                    Button(priority.menuTitle) { onSetPriority(priority) }
                }
            }
            Divider()
            Button("Archive", action: onArchive)
            Button("Delete", role: .destructive, action: onDelete)
            Divider()
            Button("Copy Task ID") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(card.id, forType: .string)
            }
            if let session = card.linkedSessionId, !session.isEmpty {
                Button("Copy Session ID") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(session, forType: .string)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityHint("Opens the card terminal")
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - Drag preview

    private var dragPreview: some View {
        HStack(spacing: 0) {
            signalEdge
            content
        }
        .frame(width: 240, alignment: .leading)
        .background(Color.surfaceCardRaised, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(edgeColor.opacity(0.5), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.5), radius: 18, y: 8)
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
            chipRow
            if !card.tags.isEmpty {
                tagRow
            }
            metaRow
        }
        .padding(.horizontal, Spacing.x3)
        .padding(.vertical, Spacing.x3)
    }

    /// Priority chip + linked-session/worktree affordances — the dense, scannable
    /// signal row (Linear/SlayZone parity). Only shows what exists.
    @ViewBuilder
    private var chipRow: some View {
        let hasSession = (card.linkedSessionId?.isEmpty == false)
        let hasWorktree = (card.linkedWorktreeId?.isEmpty == false)
        if card.priority != .normal || hasSession || hasWorktree {
            HStack(spacing: Spacing.x2) {
                if card.priority != .normal {
                    PriorityChip(priority: card.priority)
                }
                if hasSession {
                    affordance(icon: "terminal", tint: card.isLive ? .signalLive : .inkTertiary)
                }
                if hasWorktree {
                    affordance(icon: "arrow.triangle.branch", tint: .inkTertiary)
                }
                Spacer(minLength: 0)
            }
        }
    }

    private func affordance(icon: String, tint: Color) -> some View {
        Image(systemName: icon)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 18, height: 16)
            .background(
                RoundedRectangle(cornerRadius: Radius.badge, style: .continuous)
                    .fill(Color.surfaceRail.opacity(0.8))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.badge, style: .continuous)
                    .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
            )
    }

    private var tagRow: some View {
        HStack(spacing: Spacing.x1) {
            ForEach(card.tags.prefix(3), id: \.self) { tag in
                TagPill(label: tag)
            }
            if card.tags.count > 3 {
                Text("+\(card.tags.count - 3)")
                    .font(.plexMono(10, weight: .medium))
                    .foregroundStyle(Color.inkTertiary)
            }
            Spacer(minLength: 0)
        }
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

    private var accessibilitySummary: String {
        var parts = [
            card.title,
            "status \(card.status.rawValue)",
            "priority \(card.priority.rawValue)",
        ]
        if let session = card.linkedSessionId, !session.isEmpty {
            parts.append("session \(session)")
        }
        if card.isLive {
            parts.append("live")
        }
        return parts.joined(separator: ", ")
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

/// Priority pill (design.md §6.2 chip row). Low/High/Urgent carry a signal color;
/// normal is omitted upstream so the row stays quiet by default. Color is always
/// paired with the uppercase label so state never relies on color alone (§8).
struct PriorityChip: View {
    let priority: TaskPriority

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 8, weight: .bold))
            Text(label)
                .font(.plexMono(9, weight: .semibold))
                .tracking(0.6)
        }
        .foregroundStyle(color)
        .padding(.horizontal, Spacing.x1 + 1)
        .padding(.vertical, 1)
        .background(
            RoundedRectangle(cornerRadius: Radius.badge, style: .continuous)
                .fill(color.opacity(0.12))
        )
        .accessibilityElement()
        .accessibilityLabel("Priority \(label)")
    }

    private var label: String {
        switch priority {
        case .low: return "LOW"
        case .normal: return "NORMAL"
        case .high: return "HIGH"
        case .urgent: return "URGENT"
        }
    }

    private var icon: String {
        switch priority {
        case .low: return "chevron.down"
        case .normal: return "minus"
        case .high: return "chevron.up"
        case .urgent: return "exclamationmark"
        }
    }

    private var color: Color {
        switch priority {
        case .low: return .inkTertiary
        case .normal: return .inkSecondary
        case .high: return .signalWaiting
        case .urgent: return .signalBlocked
        }
    }
}

/// Small tag pill (mono, ink.secondary on a rail tint). Truncates long tags.
struct TagPill: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.plexMono(10, weight: .medium))
            .foregroundStyle(Color.inkSecondary)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, Spacing.x2)
            .padding(.vertical, 1)
            .frame(maxWidth: 92, alignment: .leading)
            .background(
                Capsule(style: .continuous)
                    .fill(Color.surfaceRail.opacity(0.9))
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Color.hairlineHighlight, lineWidth: 1)
            )
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

private extension TaskStatus {
    var menuTitle: String {
        switch self {
        case .todo: return "Backlog"
        case .running: return "Running"
        case .waiting: return "Waiting"
        case .blocked: return "Blocked"
        case .complete: return "Complete"
        case .archived: return "Archived"
        }
    }
}

private extension TaskPriority {
    var menuTitle: String {
        switch self {
        case .low: return "Low"
        case .normal: return "Medium"
        case .high: return "High"
        case .urgent: return "Urgent"
        }
    }
}
#endif
