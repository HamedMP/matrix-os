// Matrix OS — card status badge (design.md §6.3).
//
// Mono 10pt uppercase on a 10%-tint of its signal color with a solid signal dot.
// The RUNNING dot breathes (signal.live); other states are static. Reduce Motion
// collapses the breathe to a steady glow. State always pairs color with shape so
// it never relies on color alone (accessibility, §8).
#if os(macOS)
import SwiftUI
import DesignSystem
import MatrixModel

struct StatusBadge: View {
    let status: TaskStatus
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: Spacing.x1) {
            dot
            Text(label)
                .font(.plexMono(10, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(color)
        }
        .padding(.horizontal, Spacing.x2)
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: Radius.badge, style: .continuous)
                .fill(color.opacity(0.12))
        )
        .accessibilityElement()
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private var dot: some View {
        if status == .running {
            BreathingDot(color: color, reduceMotion: reduceMotion)
        } else {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
        }
    }

    private var label: String {
        switch status {
        case .todo: return "IDLE"
        case .running: return "RUNNING"
        case .waiting: return "WAITING"
        case .blocked: return "BLOCKED"
        case .complete: return "COMPLETE"
        case .archived: return "EXITED"
        }
    }

    private var color: Color {
        switch status {
        case .todo: return .signalIdle
        case .running: return .signalLive
        case .waiting: return .signalWaiting
        case .blocked: return .signalBlocked
        case .complete: return .signalDone
        case .archived: return .signalIdle
        }
    }
}

/// A signal dot that breathes (opacity 0.55↔1.0 over 2.4s). The board's heartbeat
/// (design.md §6.3). Reduce Motion → steady full-opacity dot.
struct BreathingDot: View {
    let color: Color
    let reduceMotion: Bool
    @State private var breathing = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 6, height: 6)
            .opacity(reduceMotion ? 1 : (breathing ? 1 : 0.55))
            .animation(reduceMotion ? nil : Motion.liveBreathe, value: breathing)
            .onAppear { if !reduceMotion { breathing = true } }
    }
}
#endif
