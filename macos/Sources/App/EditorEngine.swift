import Foundation

enum EditorEngineKind: String, CaseIterable, Equatable, Sendable {
    case textKitNative = "textkit-native"
    case codeMirror = "codemirror"
    case monaco
}

struct EditorEngineConfiguration: Equatable, Sendable {
    let kind: EditorEngineKind

    init(kind: EditorEngineKind) {
        self.kind = kind
    }

    static let `default` = EditorEngineConfiguration(kind: .textKitNative)

    var displayName: String {
        switch kind {
        case .textKitNative:
            return "Native TextKit"
        case .codeMirror:
            return "CodeMirror"
        case .monaco:
            return "Monaco"
        }
    }

    var isLaunchSafe: Bool {
        switch kind {
        case .textKitNative, .codeMirror:
            return true
        case .monaco:
            return false
        }
    }

    var isLightweight: Bool {
        switch kind {
        case .codeMirror:
            return true
        case .textKitNative, .monaco:
            return false
        }
    }

    var isVSCodeClassTarget: Bool {
        kind == .monaco
    }
}
