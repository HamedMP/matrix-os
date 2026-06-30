// Matrix OS — board column / lifecycle lane (design.md §6.1).
//
// Sticky header: uppercase Plex Mono label + count chip + a live signal dot when
// any card in the column is live + a `+` add. Body is a LazyVStack (view
// recycling for 200+ cards) over the column's cards. Empty columns show the
// ghosted insertion zone (§6.6). Column background is surface.rail, a hair
// lighter than the void. The whole lane is a drop target: while a card is
// dragged over it the rail brightens and an signal.idle insertion bar appears
// (§6.1). On drop it calls `onMoveCard(cardId, status)`.
#if os(macOS)
import SwiftUI
import DesignSystem
import MatrixBoard
import MatrixModel

struct ColumnView: View {
    let column: BoardColumn
    let selectedCardID: Card.ID?
    let onOpenCard: (Card) -> Void
    var onAddCard: (TaskStatus) -> Void = { _ in }
    var onEditCard: (Card) -> Void = { _ in }
    var onArchiveCard: (Card) -> Void = { _ in }
    var onDeleteCard: (Card) -> Void = { _ in }
    var onSetCardStatus: (Card, TaskStatus) -> Void = { _, _ in }
    var onSetCardPriority: (Card, TaskPriority) -> Void = { _, _ in }
    /// Called when a card is dropped onto this lane. The board wires this to
    /// `model.updateTaskStatus(cardId:to:order:)`.
    var onMoveCard: (String, TaskStatus) -> Void = { _, _ in }

    @State private var isTargeted = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: Spacing.x3) {
                    if isTargeted {
                        InsertionBar()
                    }
                    if column.cards.isEmpty {
                        EmptyColumnZone(isTargeted: isTargeted)
                    } else {
                        ForEach(column.cards) { card in
                            CardView(
                                card: card,
                                isSelected: card.id == selectedCardID,
                                onOpen: { onOpenCard(card) },
                                onEdit: { onEditCard(card) },
                                onArchive: { onArchiveCard(card) },
                                onDelete: { onDeleteCard(card) },
                                onSetStatus: { onSetCardStatus(card, $0) },
                                onSetPriority: { onSetCardPriority(card, $0) }
                            )
                        }
                    }
                }
                .padding(.horizontal, Spacing.x2)
                .padding(.top, Spacing.x2)
                .padding(.bottom, Spacing.x4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 240, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(railBackground)
        .overlay(dropRing)
        .overlay(alignment: .trailing) {
            // Subtle vertical hairline between columns.
            Rectangle().fill(Color.hairlineDark).frame(width: 1)
        }
        // Whole lane accepts a dropped card id (cross-column move).
        .dropDestination(for: String.self) { items, _ in
            guard let cardID = items.first else { return false }
            onMoveCard(cardID, column.status)
            return true
        } isTargeted: { targeted in
            withAnimation(reduceMotion ? nil : Motion.columnReflow) { isTargeted = targeted }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title) column, \(column.cards.count) cards")
    }

    /// Rail brightens ~4% while a card hovers over the lane (§6.1).
    private var railBackground: Color {
        isTargeted ? .surfaceCardRaised : .surfaceRail
    }

    @ViewBuilder
    private var dropRing: some View {
        if isTargeted {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(edgeColor.opacity(0.45), lineWidth: 1.5)
                .padding(1)
                .allowsHitTesting(false)
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.x2) {
            Text(title)
                .font(.plexMono(11, weight: .semibold))
                .tracking(1.32)
                .foregroundStyle(Color.inkSecondary)

            if hasLive {
                BreathingDot(color: .signalLive, reduceMotion: reduceMotion)
            }

            Spacer(minLength: Spacing.x2)

            Text("\(column.cards.count)")
                .font(.plexMono(11, weight: .medium))
                .foregroundStyle(Color.inkTertiary)
                .padding(.horizontal, Spacing.x2)
                .padding(.vertical, 1)
                .background(
                    RoundedRectangle(cornerRadius: Radius.badge, style: .continuous)
                        .fill(Color.surfaceCard)
                )

            AddCardButton { onAddCard(column.status) }
                .help("New task in \(title)")
        }
        .padding(.horizontal, Spacing.x3)
        .padding(.vertical, Spacing.x3)
        .background(Color.surfaceRail)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.hairlineDark).frame(height: 1)
        }
    }

    private var hasLive: Bool {
        column.cards.contains { $0.isLive }
    }

    private var edgeColor: Color {
        switch column.status {
        case .todo: return .signalIdle
        case .running: return .signalLive
        case .waiting: return .signalWaiting
        case .blocked: return .signalBlocked
        case .complete: return .signalDone
        case .archived: return .signalIdle
        }
    }

    private var title: String {
        switch column.status {
        case .todo: return "TODO"
        case .running: return "RUNNING"
        case .waiting: return "WAITING"
        case .blocked: return "BLOCKED"
        case .complete: return "COMPLETE"
        case .archived: return "ARCHIVED"
        }
    }
}

/// Header `+` button with a hover-lit hit target (no layout shift).
private struct AddCardButton: View {
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(hovered ? Color.inkPrimary : Color.inkTertiary)
                .frame(width: 20, height: 20)
                .background(
                    RoundedRectangle(cornerRadius: Radius.badge, style: .continuous)
                        .fill(hovered ? Color.surfaceCard : Color.clear)
                )
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .accessibilityLabel("Add task")
    }
}

/// signal.idle insertion bar shown at the top of a lane while a card is dragged
/// over it (design.md §6.1). A thin glowing rule that reads as "drops here".
private struct InsertionBar: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(Color.signalLive.opacity(0.7))
            .frame(height: 3)
            .shadow(color: Color.signalGlowLive, radius: 4)
            .padding(.horizontal, Spacing.x1)
            .transition(.opacity)
    }
}

/// Ghosted dashed insertion zone for an empty column (design.md §6.6). Brightens
/// while a card is dragged over the lane.
private struct EmptyColumnZone: View {
    var isTargeted: Bool = false

    var body: some View {
        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            .strokeBorder(
                isTargeted ? Color.signalLive.opacity(0.6) : Color.inkDisabled,
                style: StrokeStyle(lineWidth: 1, dash: [4, 4])
            )
            .frame(height: 72)
            .overlay(
                Text(isTargeted ? "Release to drop" : "Drop a task here or ⌘N")
                    .font(.plexSans(13))
                    .foregroundStyle(isTargeted ? Color.inkSecondary : Color.inkTertiary)
            )
            .padding(.top, Spacing.x1)
    }
}
#endif
