#if os(macOS)
import SwiftUI
import AppKit
import CodeEditLanguages
import CodeEditSourceEditor
import DesignSystem

public enum CodeEditorTheme: String, CaseIterable, Identifiable {
    case matrixLight = "Matrix Light"
    case xcodeLight = "Xcode"
    case xcodeDark = "Xcode Dark"
    case solarizedLight = "Solarized"
    case solarizedDark = "Solarized Dark"
    case terminalDark = "Terminal"
    case oneDark = "One Dark"

    public var id: String { rawValue }

    public var isDark: Bool {
        switch self {
        case .xcodeDark, .solarizedDark, .terminalDark, .oneDark:
            return true
        case .matrixLight, .xcodeLight, .solarizedLight:
            return false
        }
    }

    var background: NSColor {
        switch self {
        case .matrixLight: return NSColor.matrixHex(0xFFFFFF)
        case .xcodeLight: return NSColor(calibratedWhite: 0.99, alpha: 1)
        case .xcodeDark: return NSColor.matrixHex(0x1F2024)
        case .solarizedLight: return NSColor.matrixHex(0xFDF6E3)
        case .solarizedDark: return NSColor.matrixHex(0x002B36)
        case .terminalDark: return NSColor.matrixHex(0x0C0D10)
        case .oneDark: return NSColor.matrixHex(0x282C34)
        }
    }

    var foreground: NSColor {
        switch self {
        case .matrixLight, .xcodeLight: return NSColor.matrixHex(0x32352E)
        case .solarizedLight: return NSColor.matrixHex(0x586E75)
        case .solarizedDark: return NSColor.matrixHex(0x839496)
        case .xcodeDark, .terminalDark, .oneDark: return NSColor.matrixHex(0xE8EAED)
        }
    }

    var keyword: NSColor {
        switch self {
        case .matrixLight: return NSColor(Color.signalLive)
        case .xcodeLight: return NSColor(calibratedRed: 0.58, green: 0.16, blue: 0.66, alpha: 1)
        case .xcodeDark: return NSColor.matrixHex(0xFC5FA3)
        case .solarizedLight, .solarizedDark: return NSColor.matrixHex(0x859900)
        case .terminalDark: return NSColor(calibratedRed: 0.67, green: 0.82, blue: 1.0, alpha: 1)
        case .oneDark: return NSColor.matrixHex(0xC678DD)
        }
    }

    var string: NSColor {
        switch self {
        case .matrixLight: return NSColor(calibratedRed: 0.62, green: 0.31, blue: 0.12, alpha: 1)
        case .xcodeLight: return NSColor(calibratedRed: 0.74, green: 0.25, blue: 0.12, alpha: 1)
        case .xcodeDark: return NSColor.matrixHex(0xFC6A5D)
        case .solarizedLight, .solarizedDark: return NSColor.matrixHex(0x2AA198)
        case .terminalDark: return NSColor(calibratedRed: 0.84, green: 0.70, blue: 0.45, alpha: 1)
        case .oneDark: return NSColor.matrixHex(0x98C379)
        }
    }

    var comment: NSColor {
        switch self {
        case .matrixLight, .xcodeLight: return NSColor.matrixHex(0x7A7768)
        case .solarizedLight: return NSColor.matrixHex(0x93A1A1)
        case .solarizedDark: return NSColor.matrixHex(0x586E75)
        case .xcodeDark: return NSColor.matrixHex(0x6C7986)
        case .terminalDark: return NSColor.matrixHex(0x9BA1AC)
        case .oneDark: return NSColor.matrixHex(0x7F848E)
        }
    }

    private var number: NSColor {
        switch self {
        case .matrixLight: return NSColor(calibratedRed: 0.17, green: 0.40, blue: 0.75, alpha: 1)
        case .xcodeLight: return NSColor(calibratedRed: 0.15, green: 0.37, blue: 0.71, alpha: 1)
        case .xcodeDark: return NSColor.matrixHex(0xD9C97C)
        case .solarizedLight, .solarizedDark: return NSColor.matrixHex(0xCB4B16)
        case .terminalDark: return NSColor(calibratedRed: 0.8, green: 0.62, blue: 0.45, alpha: 1)
        case .oneDark: return NSColor.matrixHex(0xD19A66)
        }
    }

    private var gutterBackground: NSColor {
        switch self {
        case .matrixLight: return NSColor.matrixHex(0xF0EDE4)
        case .xcodeLight: return NSColor(calibratedWhite: 0.95, alpha: 1)
        case .xcodeDark: return NSColor.matrixHex(0x25262B)
        case .solarizedLight: return NSColor.matrixHex(0xEEE8D5)
        case .solarizedDark: return NSColor.matrixHex(0x073642)
        case .terminalDark: return NSColor(calibratedWhite: 0.08, alpha: 1)
        case .oneDark: return NSColor.matrixHex(0x21252B)
        }
    }

    var sourceEditorTheme: EditorTheme {
        let foreground = EditorTheme.Attribute(color: foreground)
        let muted = EditorTheme.Attribute(color: comment)
        let keyword = EditorTheme.Attribute(color: keyword, bold: true)
        let string = EditorTheme.Attribute(color: string)
        let number = EditorTheme.Attribute(color: number)
        return EditorTheme(
            text: foreground,
            insertionPoint: self.foreground,
            invisibles: EditorTheme.Attribute(color: comment.withAlphaComponent(0.55)),
            background: background,
            lineHighlight: gutterBackground.withAlphaComponent(isDark ? 0.55 : 0.75),
            selection: NSColor(calibratedRed: 0.28, green: 0.48, blue: 0.85, alpha: isDark ? 0.35 : 0.22),
            keywords: keyword,
            commands: keyword,
            types: EditorTheme.Attribute(color: self.keyword.withAlphaComponent(0.92), bold: false),
            attributes: muted,
            variables: foreground,
            values: string,
            numbers: number,
            strings: string,
            characters: string,
            comments: muted
        )
    }
}

public struct CodeEditorPreferences: Equatable, Sendable {
    public var fontSize: Double
    public var wrapsLines: Bool
    public var tabWidth: Int
    public var showsInvisibleCharacters: Bool

    public init(fontSize: Double, wrapsLines: Bool, tabWidth: Int, showsInvisibleCharacters: Bool) {
        self.fontSize = fontSize
        self.wrapsLines = wrapsLines
        self.tabWidth = tabWidth
        self.showsInvisibleCharacters = showsInvisibleCharacters
    }

    public static let `default` = CodeEditorPreferences(
        fontSize: 13,
        wrapsLines: true,
        tabWidth: 4,
        showsInvisibleCharacters: false
    )
}

private extension NSColor {
    static func matrixHex(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
        NSColor(
            srgbRed: CGFloat((hex >> 16) & 0xff) / 255.0,
            green: CGFloat((hex >> 8) & 0xff) / 255.0,
            blue: CGFloat(hex & 0xff) / 255.0,
            alpha: alpha
        )
    }
}

struct SyntaxHighlightedCodeEditor: View {
    nonisolated static let engineConfiguration = EditorEngineConfiguration(kind: .codeEditSourceEditor)

    @Binding var text: String
    let filePath: String?
    let theme: CodeEditorTheme
    var preferences: CodeEditorPreferences = .default
    var isEditable = true

    @State private var cursorPositions: [CursorPosition] = []

    var body: some View {
        CodeEditSourceEditor(
            $text,
            language: Self.codeLanguage(for: filePath, text: text),
            theme: theme.sourceEditorTheme,
            font: Self.editorFont(size: preferences.fontSize),
            tabWidth: preferences.tabWidth,
            indentOption: .spaces(count: preferences.tabWidth),
            lineHeight: 1.2,
            wrapLines: preferences.wrapsLines,
            editorOverscroll: 0.2,
            cursorPositions: $cursorPositions,
            contentInsets: NSEdgeInsets(top: 12, left: 0, bottom: 12, right: 0),
            additionalTextInsets: NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 12),
            isEditable: isEditable,
            isSelectable: true,
            letterSpacing: 1.0,
            coordinators: [InitialHighlightRefreshCoordinator()],
            showMinimap: false
        )
        .id(Self.editorIdentity(for: filePath, text: text))
        .background(Color(nsColor: theme.background))
    }

    static func editorFont(size: Double) -> NSFont {
        let pointSize = CGFloat(size)
        for name in ["JetBrainsMono Nerd Font Mono", "JetBrains Mono", "SFMono-Regular", "Menlo"] {
            if let font = NSFont(name: name, size: pointSize) { return font }
        }
        return NSFont.monospacedSystemFont(ofSize: pointSize, weight: .regular)
    }

    static func codeLanguage(for filePath: String?, text: String) -> CodeLanguage {
        let url = URL(fileURLWithPath: filePath?.isEmpty == false ? filePath! : "untitled.txt")
        return CodeLanguage.detectLanguageFrom(
            url: url,
            prefixBuffer: String(text.prefix(2048)),
            suffixBuffer: String(text.suffix(2048))
        )
    }

    static func languageName(for filePath: String?, text: String = "") -> String {
        codeLanguage(for: filePath, text: text).tsName
    }

    private static func editorIdentity(for filePath: String?, text: String) -> String {
        let language = codeLanguage(for: filePath, text: text)
        return "\(filePath ?? "untitled"):\(language.id.rawValue)"
    }
}

private final class InitialHighlightRefreshCoordinator: TextViewCoordinator {
    func prepareCoordinator(controller: TextViewController) {
        Task { @MainActor [weak controller] in
            guard let controller else { return }
            let language = controller.language
            controller.language = language
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled else { return }
            controller.language = language
        }
    }
}
#endif
