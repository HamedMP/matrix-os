import Foundation

/// Bounded exponential backoff with optional jitter for reconnect (F1).
public struct BackoffPolicy: Sendable {
    public let base: Double
    public let factor: Double
    public let cap: Double
    /// Fractional jitter in [0, 1]; applied as a random subtractive fraction of the delay.
    public let jitter: Double

    public init(base: Double = 0.5, factor: Double = 2, cap: Double = 30, jitter: Double = 0.5) {
        self.base = base
        self.factor = factor
        self.cap = cap
        self.jitter = max(0, min(1, jitter))
    }

    /// Default production policy.
    public static let `default` = BackoffPolicy()

    /// Deterministic, fast policy for tests (no jitter, small cap).
    public static let test = BackoffPolicy(base: 0.01, factor: 2, cap: 0.04, jitter: 0)

    /// Delay (seconds) for a zero-based reconnect attempt, never exceeding `cap`.
    public func delay(forAttempt attempt: Int) -> Double {
        let raw = base * pow(factor, Double(max(0, attempt)))
        let capped = min(raw, cap)
        guard jitter > 0 else { return capped }
        let reduction = capped * jitter * Double.random(in: 0...1)
        return max(0, capped - reduction)
    }
}
