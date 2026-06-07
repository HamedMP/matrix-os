import Foundation

/// Terminal rendering engines the native macOS shell can host.
///
/// The enum is intentionally small and value-only: Matrix terminal lifecycle,
/// auth, resize, and reconnect behavior stay in `TerminalSession`/`ShellWSClient`,
/// while renderer-specific code remains behind the view adapter.
public enum TerminalRendererKind: String, CaseIterable, Equatable, Sendable {
    case swiftTerm = "swiftterm"
    case ghostty
    case xtermWebView = "xterm-webview"
}

public struct TerminalRendererConfiguration: Equatable, Sendable {
    public let kind: TerminalRendererKind

    public init(kind: TerminalRendererKind) {
        self.kind = kind
    }

    public static let `default` = TerminalRendererConfiguration(kind: .swiftTerm)

    public static func available(includeExperimental: Bool = false) -> [TerminalRendererConfiguration] {
        TerminalRendererKind.allCases
            .map(TerminalRendererConfiguration.init(kind:))
            .filter { includeExperimental || !$0.isExperimental }
    }

    public var displayName: String {
        switch kind {
        case .swiftTerm:
            return "SwiftTerm"
        case .ghostty:
            return "Ghostty"
        case .xtermWebView:
            return "xterm.js WebView"
        }
    }

    public var isLaunchSafe: Bool {
        switch kind {
        case .swiftTerm:
            return true
        case .ghostty, .xtermWebView:
            return false
        }
    }

    public var isExperimental: Bool {
        switch kind {
        case .swiftTerm:
            return false
        case .ghostty, .xtermWebView:
            return true
        }
    }
}
