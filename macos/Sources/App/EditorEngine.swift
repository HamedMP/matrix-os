import Foundation

enum EditorEngineKind: String, CaseIterable, Equatable, Sendable {
    case textKitNative = "textkit-native"
    case codeEditSourceEditor = "codeedit-source-editor"
    case codeMirror = "codemirror"
    case monaco
}

struct EditorEngineConfiguration: Equatable, Sendable {
    let kind: EditorEngineKind

    init(kind: EditorEngineKind) {
        self.kind = kind
    }

    static let `default` = EditorEngineConfiguration(kind: .codeEditSourceEditor)

    var displayName: String {
        switch kind {
        case .textKitNative:
            return "Native TextKit"
        case .codeEditSourceEditor:
            return "CodeEditSourceEditor"
        case .codeMirror:
            return "CodeMirror"
        case .monaco:
            return "Monaco"
        }
    }

    var isLaunchSafe: Bool {
        switch kind {
        case .textKitNative, .codeEditSourceEditor, .codeMirror:
            return true
        case .monaco:
            return false
        }
    }

    var isLightweight: Bool {
        switch kind {
        case .codeMirror:
            return true
        case .textKitNative, .codeEditSourceEditor, .monaco:
            return false
        }
    }

    var isVSCodeClassTarget: Bool {
        kind == .monaco
    }
}
