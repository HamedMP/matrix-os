// Matrix OS — board column / lifecycle lane (design.md §6.1).
//
// Sticky header: uppercase Plex Mono label + count chip + a live signal dot when
// any card in the column is live. Body is a LazyVStack (view recycling for 200+
// cards) over the column's cards. Empty columns show the ghosted insertion zone
// (§6.6). Column background is surface.rail, a hair lighter than the void.
#if os(macOS)
import SwiftUI
import DesignSystem
import MatrixBoard
import MatrixModel

struct ColumnView: View {
    let column: BoardColumn
    let selectedCardID: Card.ID?
    let onOpenCard: (Card) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: Spacing.x3) {
                    if column.cards.isEmpty {
                        EmptyColumnZone()
                    } else {
                        ForEach(column.cards) { card in
                            CardView(
                                card: card,
                                isSelected: card.id == selectedCardID,
                                onOpen: { onOpenCard(card) }
                            )
                        }
                    }
                }
                .padding(.horizontal, Spacing.x2)
                .padding(.top, Spacing.x2)
                .padding(.bottom, Spacing.x4)
            }
        }
        .frame(minWidth: 240, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.surfaceRail)
        .overlay(alignment: .trailing) {
            // Subtle vertical hairline between columns.
            Rectangle().fill(Color.hairlineDark).frame(width: 1)
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.x2) {
            Text(title)
                .font(.plexMono(11, weight: .semibold))
                .tracking(1.32)
                .foregroundStyle(Color.inkSecondary)

            if hasLive {
                Circle()
                    .fill(Color.signalLive)
                    .frame(width: 6, height: 6)
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

/// Ghosted dashed insertion zone for an empty column (design.md §6.6).
private struct EmptyColumnZone: View {
    var body: some View {
        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            .strokeBorder(
                Color.inkDisabled,
                style: StrokeStyle(lineWidth: 1, dash: [4, 4])
            )
            .frame(height: 72)
            .overlay(
                Text("Drop a task here or ⌘N")
                    .font(.plexSans(13))
                    .foregroundStyle(Color.inkTertiary)
            )
            .padding(.top, Spacing.x1)
    }
}
#endif
