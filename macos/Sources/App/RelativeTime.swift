// Matrix OS — compact relative-time formatting for card meta rows.
//
// Cards carry an ISO-8601 `updatedAt` string. The meta row renders a compact
// relative stamp ("3m", "2h", "5d") in mono ink.tertiary (design.md §6.2).
import Foundation

enum RelativeTime {
    /// Parses an ISO-8601 timestamp (with or without fractional seconds).
    ///
    /// Formatters are created per call rather than cached in a static: under
    /// strict Swift 6 concurrency `ISO8601DateFormatter` is non-Sendable, so a
    /// shared static would be unsafe. Card-meta formatting is infrequent enough
    /// that per-call construction is fine.
    static func parse(_ string: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }

    /// Compact relative label for `updatedAt` vs `now`. Returns "—" when unparseable.
    static func compact(_ updatedAt: String, now: Date = Date()) -> String {
        guard let date = parse(updatedAt) else { return "—" }
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60:
            return "now"
        case ..<3600:
            return "\(Int(seconds / 60))m"
        case ..<86_400:
            return "\(Int(seconds / 3600))h"
        case ..<604_800:
            return "\(Int(seconds / 86_400))d"
        default:
            return "\(Int(seconds / 604_800))w"
        }
    }
}
