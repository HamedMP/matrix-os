// MatrixBoard — read-only board state for US1 (T032).
//
// `BoardStore` is an @MainActor ObservableObject that SwiftUI binds to. It holds
// the bounded board snapshot (`cards`), derives kanban `columns`, and exposes a
// `load(projectSlug:)` that drives an idle → loading → loaded/failed lifecycle.
// All errors collapse to a generic `BoardError`; raw server/provider/path text
// never reaches the UI (FR-023, CLAUDE.md error policy).
import Foundation
import MatrixModel
import MatrixNet

/// A kanban column: a status and the cards in it (ordered by `Card.order`).
public struct BoardColumn: Sendable, Equatable, Identifiable {
    public let status: TaskStatus
    public let cards: [Card]
    public var id: TaskStatus { status }

    public init(status: TaskStatus, cards: [Card]) {
        self.status = status
        self.cards = cards
    }
}

/// Generic, user-safe board error. Carries no raw server/DB/provider/path text.
public enum BoardError: Error, Equatable, Sendable {
    case unauthorized
    case offline
    case timeout
    case misconfigured
    case generic

    /// Safe copy for the UI.
    public var message: String {
        switch self {
        case .unauthorized: return "Your session has expired. Please sign in again."
        case .offline: return "Can't reach Matrix OS. Check your connection."
        case .timeout: return "The board took too long to load. Please try again."
        case .misconfigured: return "No computer is connected. Select a runtime to continue."
        case .generic: return "Couldn't load the board. Please try again."
        }
    }

    /// Map any thrown error to a generic case. Unknown errors collapse to
    /// `.generic` so leaky messages can never surface.
    static func from(_ error: Error) -> BoardError {
        guard let gateway = error as? GatewayError else { return .generic }
        switch gateway {
        case .unauthorized: return .unauthorized
        case .network: return .offline
        case .timeout: return .timeout
        case .misconfigured: return .misconfigured
        case .notFound, .conflict, .server, .decoding: return .generic
        }
    }
}

/// Lifecycle of a board load.
public enum BoardLoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(BoardError)
}

/// Columns the board renders, in canonical left-to-right order. `archived` is
/// intentionally excluded — archived cards are hidden from the board.
private let boardColumnOrder: [TaskStatus] = [.todo, .running, .waiting, .blocked, .complete]

@MainActor
public final class BoardStore: ObservableObject {
    @Published public private(set) var cards: [Card] = []
    @Published public private(set) var state: BoardLoadState = .idle

    private let loader: any BoardLoading

    public init(loader: any BoardLoading) {
        self.loader = loader
    }

    /// Kanban columns grouped by status, each sorted by `Card.order` then `id`
    /// for a stable tie-break. Archived cards are excluded.
    public var columns: [BoardColumn] {
        var byStatus: [TaskStatus: [Card]] = [:]
        for card in cards where card.status != .archived {
            byStatus[card.status, default: []].append(card)
        }
        return boardColumnOrder.map { status in
            let sorted = (byStatus[status] ?? []).sorted {
                $0.order != $1.order ? $0.order < $1.order : $0.id < $1.id
            }
            return BoardColumn(status: status, cards: sorted)
        }
    }

    /// Fetch the read-only board snapshot for a project. Sets `state` to
    /// `.loaded` on success or `.failed(.generic-ish)` on any error.
    public func load(projectSlug: String) async {
        state = .loading
        do {
            let fetched = try await loader.fetchTasks(projectSlug: projectSlug)
            cards = fetched
            state = .loaded
        } catch {
            // Never surface the raw error; collapse to a generic BoardError.
            state = .failed(BoardError.from(error))
        }
    }
}
