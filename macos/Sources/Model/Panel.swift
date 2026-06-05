import Foundation

/// Client-only UI state for what a window pane is currently showing.
public enum Panel: Sendable, Equatable {
    case terminal
    case shell
    case app(slug: String)
}
