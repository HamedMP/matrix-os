#if os(macOS)
import SwiftUI
import AppKit
import DesignSystem

public enum CodeEditorTheme: String, CaseIterable, Identifiable {
    case matrixLight = "Matrix Light"
    case xcodeLight = "Xcode"
    case xcodeDark = "Xcode Dark"
    case solarizedLight = "Solarized"
    case terminalDark = "Terminal"
    case oneDark = "One Dark"

    public var id: String { rawValue }

    public var isDark: Bool {
        switch self {
        case .xcodeDark, .terminalDark, .oneDark:
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
        case .terminalDark: return NSColor.matrixHex(0x0C0D10)
        case .oneDark: return NSColor.matrixHex(0x282C34)
        }
    }

    var foreground: NSColor {
        switch self {
        case .matrixLight, .xcodeLight: return NSColor.matrixHex(0x32352E)
        case .solarizedLight: return NSColor.matrixHex(0x586E75)
        case .xcodeDark, .terminalDark, .oneDark: return NSColor.matrixHex(0xE8EAED)
        }
    }

    var keyword: NSColor {
        switch self {
        case .matrixLight: return NSColor(Color.signalLive)
        case .xcodeLight: return NSColor(calibratedRed: 0.58, green: 0.16, blue: 0.66, alpha: 1)
        case .xcodeDark: return NSColor.matrixHex(0xFC5FA3)
        case .solarizedLight: return NSColor.matrixHex(0x859900)
        case .terminalDark: return NSColor(calibratedRed: 0.67, green: 0.82, blue: 1.0, alpha: 1)
        case .oneDark: return NSColor.matrixHex(0xC678DD)
        }
    }

    var string: NSColor {
        switch self {
        case .matrixLight: return NSColor(calibratedRed: 0.62, green: 0.31, blue: 0.12, alpha: 1)
        case .xcodeLight: return NSColor(calibratedRed: 0.74, green: 0.25, blue: 0.12, alpha: 1)
        case .xcodeDark: return NSColor.matrixHex(0xFC6A5D)
        case .solarizedLight: return NSColor.matrixHex(0x2AA198)
        case .terminalDark: return NSColor(calibratedRed: 0.84, green: 0.70, blue: 0.45, alpha: 1)
        case .oneDark: return NSColor.matrixHex(0x98C379)
        }
    }

    var comment: NSColor {
        switch self {
        case .matrixLight, .xcodeLight: return NSColor.matrixHex(0x7A7768)
        case .solarizedLight: return NSColor.matrixHex(0x93A1A1)
        case .xcodeDark: return NSColor.matrixHex(0x6C7986)
        case .terminalDark: return NSColor.matrixHex(0x9BA1AC)
        case .oneDark: return NSColor.matrixHex(0x7F848E)
        }
    }

    var gutterBackground: NSColor {
        switch self {
        case .matrixLight: return NSColor.matrixHex(0xF0EDE4)
        case .xcodeLight: return NSColor(calibratedWhite: 0.95, alpha: 1)
        case .xcodeDark: return NSColor.matrixHex(0x25262B)
        case .solarizedLight: return NSColor.matrixHex(0xEEE8D5)
        case .terminalDark: return NSColor(calibratedWhite: 0.08, alpha: 1)
        case .oneDark: return NSColor.matrixHex(0x21252B)
        }
    }

    var findHighlight: NSColor {
        switch self {
        case .matrixLight, .xcodeLight, .solarizedLight:
            return NSColor(calibratedRed: 1.0, green: 0.88, blue: 0.2, alpha: 0.55)
        case .xcodeDark, .terminalDark, .oneDark:
            return NSColor(calibratedRed: 0.9, green: 0.7, blue: 0.0, alpha: 0.45)
        }
    }

    var findActiveHighlight: NSColor {
        switch self {
        case .matrixLight, .xcodeLight, .solarizedLight:
            return NSColor(calibratedRed: 1.0, green: 0.65, blue: 0.0, alpha: 0.75)
        case .xcodeDark, .terminalDark, .oneDark:
            return NSColor(calibratedRed: 1.0, green: 0.75, blue: 0.1, alpha: 0.70)
        }
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

private extension NSFont {
    var spaceWidth: CGFloat {
        (" " as NSString).size(withAttributes: [.font: self]).width
    }
}

// MARK: - SyntaxHighlightedCodeEditor

struct SyntaxHighlightedCodeEditor: NSViewRepresentable {
    nonisolated static let engineConfiguration = EditorEngineConfiguration(kind: .textKitNative)

    @Binding var text: String
    let filePath: String?
    let theme: CodeEditorTheme
    var preferences: CodeEditorPreferences = .default
    var isEditable = true

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeNSView(context: Context) -> EditorScrollHost {
        let host = EditorScrollHost()
        let scrollView = host.scrollView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = true

        let textView = EditorTextView()
        textView.isRichText = false
        textView.isEditable = isEditable
        textView.isSelectable = true
        textView.drawsBackground = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.isGrammarCheckingEnabled = false
        textView.allowsUndo = true
        textView.delegate = context.coordinator
        textView.textContainerInset = NSSize(width: 14, height: 14)
        textView.textContainer?.lineFragmentPadding = 0
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = !preferences.wrapsLines
        textView.isVerticallyResizable = true
        textView.autoresizingMask = preferences.wrapsLines ? [.width] : []
        textView.usesFindBar = false
        textView.isIncrementalSearchingEnabled = false

        scrollView.documentView = textView
        // Layout preferences applied after documentView is set so contentSize is valid.
        applyLayoutPreferences(to: textView, in: scrollView, preferences: preferences)

        let ruler = LineNumberRulerView(textView: textView, theme: theme)
        scrollView.verticalRulerView = ruler
        scrollView.hasVerticalRuler = true
        scrollView.rulersVisible = true

        // Search bar: inserted above the scroll view inside the host.
        let searchBar = FindBar(theme: theme)
        searchBar.isHidden = true
        let coordinator = context.coordinator
        searchBar.onFind = { [weak coordinator] query, caseSensitive in
            coordinator?.performFind(query: query, caseSensitive: caseSensitive)
        }
        searchBar.onFindNext = { [weak coordinator] in
            coordinator?.findNext()
        }
        searchBar.onFindPrev = { [weak coordinator] in
            coordinator?.findPrevious()
        }
        searchBar.onClose = { [weak coordinator, weak host] in
            host?.setSearchVisible(false)
            coordinator?.showFindBar = false
            if let tv = coordinator?.textView {
                coordinator?.clearFindHighlights(in: tv)
                coordinator?.findMatches = []
            }
        }

        host.findBar = searchBar
        host.addSubview(searchBar)
        host.addSubview(scrollView)

        context.coordinator.textView = textView
        context.coordinator.theme = theme
        context.coordinator.preferences = preferences
        context.coordinator.filePath = filePath
        context.coordinator.isEditable = isEditable
        context.coordinator.host = host
        textView.coordinator = context.coordinator

        // Apply initial content. The text container width may be zero here if the
        // host hasn't been laid out yet; we track whether a real-size re-apply is
        // still needed via `needsInitialLayout`.
        context.coordinator.applyHighlight {
            applyContent(text: text, to: textView, theme: theme, filePath: filePath, preferences: preferences)
        }
        context.coordinator.pendingText = text
        context.coordinator.needsInitialLayout = true

        return host
    }

    func updateNSView(_ host: EditorScrollHost, context: Context) {
        let scrollView = host.scrollView
        guard let textView = scrollView.documentView as? NSTextView else { return }

        if let ruler = scrollView.verticalRulerView as? LineNumberRulerView {
            ruler.theme = theme
            ruler.needsDisplay = true
        }

        applyLayoutPreferences(to: textView, in: scrollView, preferences: preferences)
        textView.isEditable = isEditable

        let themeChanged = context.coordinator.theme != theme
        let prefsChanged = context.coordinator.preferences != preferences
        let pathChanged = context.coordinator.filePath != filePath
        let editableChanged = context.coordinator.isEditable != isEditable
        let textChanged = textView.string != text
        let needsLayout = context.coordinator.needsInitialLayout && scrollView.contentSize.width > 0

        if textChanged || themeChanged || prefsChanged || pathChanged || editableChanged
            || context.coordinator.needsHighlight || needsLayout {
            context.coordinator.theme = theme
            context.coordinator.preferences = preferences
            context.coordinator.filePath = filePath
            context.coordinator.isEditable = isEditable
            context.coordinator.needsHighlight = false
            if needsLayout {
                context.coordinator.needsInitialLayout = false
            }
            context.coordinator.applyHighlight {
                applyContent(text: text, to: textView, theme: theme, filePath: filePath, preferences: preferences)
            }
        }

        // Update search-bar theme whenever theme changes.
        if let findBar = host.findBar {
            findBar.theme = theme
        }
    }

    // MARK: - Layout helpers

    private func applyLayoutPreferences(to textView: NSTextView, in scrollView: NSScrollView, preferences: CodeEditorPreferences) {
        textView.isHorizontallyResizable = !preferences.wrapsLines
        textView.autoresizingMask = preferences.wrapsLines ? [.width] : []
        textView.textContainer?.widthTracksTextView = preferences.wrapsLines
        let width = Self.resolvedTextContainerWidth(
            contentWidth: scrollView.contentSize.width,
            boundsWidth: scrollView.bounds.width,
            wrapsLines: preferences.wrapsLines
        )
        textView.textContainer?.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        textView.minSize = NSSize(width: preferences.wrapsLines ? width : 320, height: 0)
        textView.maxSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        if preferences.wrapsLines, textView.frame.width < width {
            textView.frame.size.width = width
        }
    }

    nonisolated static func resolvedTextContainerWidth(contentWidth: CGFloat, boundsWidth: CGFloat, wrapsLines: Bool) -> CGFloat {
        guard wrapsLines else { return CGFloat.greatestFiniteMagnitude }
        return max(contentWidth, boundsWidth, 320)
    }

    // MARK: - Content application

    private func applyContent(text: String, to textView: NSTextView, theme: CodeEditorTheme, filePath: String?, preferences: CodeEditorPreferences) {
        let selected = textView.selectedRange()
        textView.backgroundColor = theme.background
        textView.insertionPointColor = theme.foreground
        textView.textColor = theme.foreground
        textView.font = Self.editorFont(size: preferences.fontSize)
        textView.defaultParagraphStyle = Self.paragraphStyle(tabWidth: preferences.tabWidth, fontSize: preferences.fontSize, wrapsLines: preferences.wrapsLines)
        textView.textStorage?.setAttributedString(Self.highlightedText(text, filePath: filePath, theme: theme, preferences: preferences))
        let safeLocation = min(selected.location, (text as NSString).length)
        textView.setSelectedRange(NSRange(location: safeLocation, length: 0))
        textView.needsDisplay = true
        if let container = textView.textContainer {
            textView.layoutManager?.ensureLayout(for: container)
        }
    }

    // MARK: - Font & paragraph style

    static func editorFont(size: Double) -> NSFont {
        let pointSize = CGFloat(size)
        for name in ["JetBrainsMono Nerd Font Mono", "JetBrains Mono", "SFMono-Regular", "Menlo"] {
            if let font = NSFont(name: name, size: pointSize) { return font }
        }
        return NSFont.monospacedSystemFont(ofSize: pointSize, weight: .regular)
    }

    private static func paragraphStyle(tabWidth: Int, fontSize: Double, wrapsLines: Bool) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        let width = max(2, min(tabWidth, 8))
        style.defaultTabInterval = CGFloat(width) * editorFont(size: fontSize).spaceWidth
        style.lineBreakMode = wrapsLines ? .byWordWrapping : .byClipping
        return style
    }

    // MARK: - Syntax highlighting

    static func highlightedText(_ text: String, filePath: String?, theme: CodeEditorTheme, preferences: CodeEditorPreferences) -> NSAttributedString {
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        let language = syntaxLanguage(for: filePath)
        let output = NSMutableAttributedString(
            string: text,
            attributes: [
                .font: editorFont(size: preferences.fontSize),
                .foregroundColor: theme.foreground,
                .paragraphStyle: paragraphStyle(tabWidth: preferences.tabWidth, fontSize: preferences.fontSize, wrapsLines: preferences.wrapsLines),
            ]
        )
        if preferences.showsInvisibleCharacters {
            applyPattern(#" |\t"#, color: theme.comment.withAlphaComponent(0.55), to: output, range: fullRange)
        }
        applyPattern(#""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"#, color: theme.string, to: output, range: fullRange)
        if language.supportsBlockComments {
            applyPattern(language.blockCommentPattern, color: theme.comment, to: output, range: fullRange)
        }
        if language.supportsLineComments {
            applyPattern(language.commentPattern, color: theme.comment, to: output, range: fullRange)
        }
        if language.supportsKeywords {
            applyPattern(language.keywordPattern, color: theme.keyword, to: output, range: fullRange)
        }
        if language.supportsNumbers {
            applyPattern(#"\b\d+\.?\d*\b"#, color: theme.number, to: output, range: fullRange)
        }
        return output
    }

    private struct SyntaxLanguage {
        var supportsLineComments: Bool
        var supportsBlockComments: Bool
        var supportsKeywords: Bool
        var supportsNumbers: Bool
        var commentPattern: String
        var blockCommentPattern: String
        var keywordPattern: String
    }

    private static func syntaxLanguage(for filePath: String?) -> SyntaxLanguage {
        let noHighlight = SyntaxLanguage(
            supportsLineComments: false,
            supportsBlockComments: false,
            supportsKeywords: false,
            supportsNumbers: false,
            commentPattern: "",
            blockCommentPattern: "",
            keywordPattern: ""
        )
        let jsKeywords = #"\b(import|export|from|as|default|function|let|const|var|class|extends|implements|interface|type|enum|namespace|module|declare|return|if|else|switch|case|break|continue|for|while|do|try|catch|finally|throw|new|delete|typeof|instanceof|in|of|await|async|yield|true|false|null|undefined|void|this|super|static|public|private|protected|abstract|override|readonly|keyof|infer|never|any|unknown)\b"#
        let swiftKeywords = #"\b(import|func|let|var|struct|class|enum|protocol|extension|public|private|internal|fileprivate|open|override|final|static|lazy|weak|unowned|mutating|nonmutating|inout|guard|return|if|else|switch|case|for|while|repeat|do|try|catch|throw|throws|rethrows|async|await|actor|nonisolated|some|any|self|Self|super|init|deinit|subscript|get|set|willSet|didSet|defer|typealias|associatedtype|where|in|as|is|nil|true|false)\b"#
        let pyKeywords = #"\b(import|from|as|def|class|return|if|elif|else|for|while|try|except|finally|raise|with|lambda|yield|pass|break|continue|del|global|nonlocal|and|or|not|in|is|True|False|None|async|await)\b"#
        let genericKeywords = #"\b(import|export|from|func|function|let|const|var|struct|class|enum|protocol|extension|public|private|return|if|else|switch|case|for|while|guard|try|await|async|throws|type|interface|extends|implements|new|in|of)\b"#

        guard let filePath, !filePath.isEmpty else {
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)(//.*$|#.*$)"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: genericKeywords
            )
        }
        let ext = URL(fileURLWithPath: filePath).pathExtension.lowercased()
        switch ext {
        case "md", "markdown", "mdx", "txt", "log", "csv":
            return noHighlight
        case "json", "jsonc":
            return SyntaxLanguage(
                supportsLineComments: false, supportsBlockComments: false, supportsKeywords: true, supportsNumbers: true,
                commentPattern: "",
                blockCommentPattern: "",
                keywordPattern: #"\b(true|false|null)\b"#
            )
        case "yaml", "yml":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: false, supportsKeywords: false, supportsNumbers: true,
                commentPattern: #"(?m)#.*$"#,
                blockCommentPattern: "",
                keywordPattern: ""
            )
        case "toml":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: false, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)#.*$"#,
                blockCommentPattern: "",
                keywordPattern: #"\b(true|false)\b"#
            )
        case "xml", "html", "htm", "svg":
            return SyntaxLanguage(
                supportsLineComments: false, supportsBlockComments: true, supportsKeywords: false, supportsNumbers: false,
                commentPattern: "",
                blockCommentPattern: #"<!--[\s\S]*?-->"#,
                keywordPattern: ""
            )
        case "py":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: false, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)#.*$"#,
                blockCommentPattern: "",
                keywordPattern: pyKeywords
            )
        case "rb":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: false, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)#.*$"#,
                blockCommentPattern: "",
                keywordPattern: #"\b(def|class|module|end|if|elsif|else|unless|case|when|while|until|for|do|begin|rescue|ensure|raise|return|require|require_relative|include|extend|attr|attr_reader|attr_writer|attr_accessor|true|false|nil|self|super|yield|and|or|not|in)\b"#
            )
        case "sh", "bash", "zsh", "fish":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: false, supportsKeywords: true, supportsNumbers: false,
                commentPattern: #"(?m)#.*$"#,
                blockCommentPattern: "",
                keywordPattern: #"\b(if|then|else|elif|fi|for|do|done|while|until|case|esac|function|return|local|export|readonly|declare|source|echo|exit|break|continue|shift|set|unset|trap)\b"#
            )
        case "swift":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: swiftKeywords
            )
        case "ts", "tsx":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: jsKeywords
            )
        case "js", "jsx", "mjs", "cjs":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: jsKeywords
            )
        case "go":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: #"\b(package|import|func|var|const|type|struct|interface|map|chan|go|defer|return|if|else|switch|case|for|range|break|continue|fallthrough|select|default|make|new|len|cap|append|copy|delete|close|panic|recover|nil|true|false)\b"#
            )
        case "rs":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: #"\b(use|mod|fn|let|mut|const|static|struct|enum|trait|impl|pub|priv|crate|super|self|Self|where|type|return|if|else|match|for|while|loop|break|continue|in|move|ref|as|async|await|dyn|unsafe|extern|true|false)\b"#
            )
        case "kt", "kts":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: #"\b(package|import|class|interface|object|fun|val|var|constructor|init|return|if|else|when|for|while|do|try|catch|finally|throw|override|open|final|abstract|sealed|data|inner|companion|suspend|inline|reified|crossinline|noinline|lateinit|lazy|const|by|in|is|as|null|true|false)\b"#
            )
        case "java":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: #"\b(package|import|class|interface|enum|extends|implements|public|private|protected|static|final|abstract|synchronized|volatile|native|return|if|else|switch|case|for|while|do|try|catch|finally|throw|throws|new|instanceof|this|super|null|true|false|void|int|long|float|double|boolean|char|byte|short)\b"#
            )
        case "c", "h":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: #"\b(include|define|ifdef|ifndef|endif|if|else|switch|case|for|while|do|return|break|continue|struct|union|enum|typedef|const|static|extern|register|volatile|auto|sizeof|void|int|long|float|double|char|unsigned|signed|short)\b"#
            )
        case "cpp", "cc", "cxx", "hpp":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: #"\b(include|define|namespace|class|struct|template|typename|virtual|override|final|public|private|protected|static|const|constexpr|inline|explicit|operator|new|delete|return|if|else|switch|case|for|while|do|try|catch|throw|nullptr|true|false|void|int|long|float|double|char|bool|auto)\b"#
            )
        case "css", "scss", "less":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: false, supportsNumbers: true,
                commentPattern: #"(?m)//.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: ""
            )
        case "sql":
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)--.*$"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: #"(?i)\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|BETWEEN|LIKE|IS|NULL|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|ON|AS|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|VIEW|DROP|ALTER|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|DEFAULT|NOT|NULL|CHECK|CONSTRAINT|BEGIN|COMMIT|ROLLBACK|TRANSACTION)\b"#
            )
        default:
            return SyntaxLanguage(
                supportsLineComments: true, supportsBlockComments: true, supportsKeywords: true, supportsNumbers: true,
                commentPattern: #"(?m)(//.*$|#.*$)"#,
                blockCommentPattern: #"/\*[\s\S]*?\*/"#,
                keywordPattern: genericKeywords
            )
        }
    }

    private static func applyPattern(_ pattern: String, color: NSColor, to output: NSMutableAttributedString, range: NSRange) {
        guard !pattern.isEmpty,
              let regex = try? NSRegularExpression(pattern: pattern) else { return }
        regex.enumerateMatches(in: output.string, range: range) { match, _, _ in
            guard let match else { return }
            output.addAttribute(.foregroundColor, value: color, range: match.range)
        }
    }

    // MARK: - Coordinator

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        weak var textView: NSTextView?
        weak var host: EditorScrollHost?
        var theme: CodeEditorTheme?
        var preferences: CodeEditorPreferences?
        var filePath: String?
        var isEditable = true
        var needsHighlight = false
        var needsInitialLayout = false
        var pendingText: String = ""
        var showFindBar = false
        private var isApplyingHighlight = false

        // Find state
        var findMatches: [NSRange] = []
        var findMatchIndex: Int = 0

        init(text: Binding<String>) {
            _text = text
        }

        func applyHighlight(_ body: () -> Void) {
            isApplyingHighlight = true
            defer { isApplyingHighlight = false }
            body()
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            guard !isApplyingHighlight else { return }
            needsHighlight = true
            text = textView.string
        }

        // MARK: Find

        func performFind(query: String, caseSensitive: Bool) {
            guard let textView, let textStorage = textView.textStorage else { return }
            clearFindHighlights(in: textView)
            guard !query.isEmpty else {
                findMatches = []
                findMatchIndex = 0
                host?.findBar?.updateMatchCount(0, index: 0)
                return
            }
            let options: NSRegularExpression.Options = caseSensitive ? [] : [.caseInsensitive]
            let escapedQuery = NSRegularExpression.escapedPattern(for: query)
            guard let regex = try? NSRegularExpression(pattern: escapedQuery, options: options) else {
                findMatches = []
                return
            }
            let fullRange = NSRange(location: 0, length: textStorage.length)
            var matches: [NSRange] = []
            regex.enumerateMatches(in: textStorage.string, range: fullRange) { match, _, _ in
                guard let match else { return }
                matches.append(match.range)
            }
            findMatches = matches
            findMatchIndex = 0
            guard let theme else { return }
            for (i, range) in matches.enumerated() {
                let color = i == 0 ? theme.findActiveHighlight : theme.findHighlight
                textStorage.addAttribute(.backgroundColor, value: color, range: range)
            }
            if !matches.isEmpty {
                textView.scrollRangeToVisible(matches[0])
                textView.setSelectedRange(matches[0])
            }
            host?.findBar?.updateMatchCount(matches.count, index: findMatchIndex)
        }

        func findNext() {
            guard !findMatches.isEmpty else { return }
            clearActiveHighlight()
            findMatchIndex = (findMatchIndex + 1) % findMatches.count
            activateMatch(at: findMatchIndex)
        }

        func findPrevious() {
            guard !findMatches.isEmpty else { return }
            clearActiveHighlight()
            findMatchIndex = (findMatchIndex - 1 + findMatches.count) % findMatches.count
            activateMatch(at: findMatchIndex)
        }

        private func activateMatch(at index: Int) {
            guard let textView, let textStorage = textView.textStorage,
                  index < findMatches.count, let theme else { return }
            let range = findMatches[index]
            textStorage.addAttribute(.backgroundColor, value: theme.findActiveHighlight, range: range)
            textView.scrollRangeToVisible(range)
            textView.setSelectedRange(range)
            host?.findBar?.updateMatchCount(findMatches.count, index: index)
        }

        private func clearActiveHighlight() {
            guard let textView, let textStorage = textView.textStorage, let theme else { return }
            if findMatchIndex < findMatches.count {
                textStorage.addAttribute(.backgroundColor, value: theme.findHighlight, range: findMatches[findMatchIndex])
            }
        }

        func clearFindHighlights(in textView: NSTextView) {
            guard let textStorage = textView.textStorage else { return }
            let fullRange = NSRange(location: 0, length: textStorage.length)
            textStorage.removeAttribute(.backgroundColor, range: fullRange)
        }

        func toggleFindBar() {
            guard let host else { return }
            let nowVisible = !(host.findBar?.isHidden ?? true)
            showFindBar = !nowVisible
            host.setSearchVisible(showFindBar)
            if showFindBar {
                host.findBar?.focusSearchField()
            } else if let textView {
                clearFindHighlights(in: textView)
                findMatches = []
                textView.window?.makeFirstResponder(textView)
            }
        }
    }
}

// MARK: - Number color extension

private extension CodeEditorTheme {
    var number: NSColor {
        switch self {
        case .matrixLight: return NSColor(calibratedRed: 0.17, green: 0.40, blue: 0.75, alpha: 1)
        case .xcodeLight: return NSColor(calibratedRed: 0.15, green: 0.37, blue: 0.71, alpha: 1)
        case .xcodeDark: return NSColor.matrixHex(0xD9C97C)
        case .solarizedLight: return NSColor.matrixHex(0xCB4B16)
        case .terminalDark: return NSColor(calibratedRed: 0.8, green: 0.62, blue: 0.45, alpha: 1)
        case .oneDark: return NSColor.matrixHex(0xD19A66)
        }
    }
}

// MARK: - EditorTextView (handles Find shortcut)

private final class EditorTextView: NSTextView {
    weak var coordinator: SyntaxHighlightedCodeEditor.Coordinator?

    override func keyDown(with event: NSEvent) {
        // Cmd+F → toggle find bar
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "f" {
            coordinator?.toggleFindBar()
            return
        }
        // Cmd+G → find next
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "g" {
            if event.modifierFlags.contains(.shift) {
                coordinator?.findPrevious()
            } else {
                coordinator?.findNext()
            }
            return
        }
        super.keyDown(with: event)
    }
}

// MARK: - EditorScrollHost (NSView wrapping scroll + find bar)

final class EditorScrollHost: NSView {
    let scrollView = NSScrollView()
    var findBar: FindBar?
    private let findBarHeight: CGFloat = 36

    override init(frame: NSRect) {
        super.init(frame: frame)
        autoresizesSubviews = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setSearchVisible(_ visible: Bool) {
        findBar?.isHidden = !visible
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let barHeight = (findBar?.isHidden ?? true) ? 0 : findBarHeight
        findBar?.frame = NSRect(x: 0, y: bounds.height - barHeight, width: bounds.width, height: findBarHeight)
        scrollView.frame = NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height - barHeight)
    }
}

// MARK: - FindBar

final class FindBar: NSView {
    var theme: CodeEditorTheme {
        didSet { applyTheme() }
    }

    var onFind: ((String, Bool) -> Void)?
    var onFindNext: (() -> Void)?
    var onFindPrev: (() -> Void)?
    var onClose: (() -> Void)?

    private let searchField = NSSearchField()
    private let caseButton = NSButton()
    private let prevButton = NSButton()
    private let nextButton = NSButton()
    private let closeButton = NSButton()
    private let matchLabel = NSTextField(labelWithString: "")

    private var caseSensitive = false

    init(theme: CodeEditorTheme) {
        self.theme = theme
        super.init(frame: .zero)
        setupViews()
        applyTheme()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setupViews() {
        wantsLayer = true

        searchField.placeholderString = "Find…"
        searchField.sendsSearchStringImmediately = true
        searchField.target = self
        searchField.action = #selector(searchChanged)
        searchField.translatesAutoresizingMaskIntoConstraints = false
        addSubview(searchField)

        caseButton.title = "Aa"
        caseButton.setButtonType(.toggle)
        caseButton.bezelStyle = .texturedRounded
        caseButton.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        caseButton.target = self
        caseButton.action = #selector(caseToggled)
        caseButton.toolTip = "Case sensitive"
        caseButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(caseButton)

        prevButton.image = NSImage(systemSymbolName: "chevron.up", accessibilityDescription: "Previous")
        prevButton.bezelStyle = .texturedRounded
        prevButton.target = self
        prevButton.action = #selector(prevTapped)
        prevButton.toolTip = "Previous match (⌘⇧G)"
        prevButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(prevButton)

        nextButton.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: "Next")
        nextButton.bezelStyle = .texturedRounded
        nextButton.target = self
        nextButton.action = #selector(nextTapped)
        nextButton.toolTip = "Next match (⌘G)"
        nextButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(nextButton)

        matchLabel.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        matchLabel.alignment = .right
        matchLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(matchLabel)

        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")
        closeButton.bezelStyle = .texturedRounded
        closeButton.target = self
        closeButton.action = #selector(closeTapped)
        closeButton.toolTip = "Close (Esc)"
        closeButton.isBordered = false
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(closeButton)

        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            closeButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: 22),

            searchField.leadingAnchor.constraint(equalTo: closeButton.trailingAnchor, constant: 6),
            searchField.centerYAnchor.constraint(equalTo: centerYAnchor),
            searchField.widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
            searchField.widthAnchor.constraint(lessThanOrEqualToConstant: 320),

            caseButton.leadingAnchor.constraint(equalTo: searchField.trailingAnchor, constant: 6),
            caseButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            caseButton.widthAnchor.constraint(equalToConstant: 32),

            prevButton.leadingAnchor.constraint(equalTo: caseButton.trailingAnchor, constant: 4),
            prevButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            prevButton.widthAnchor.constraint(equalToConstant: 26),

            nextButton.leadingAnchor.constraint(equalTo: prevButton.trailingAnchor, constant: 2),
            nextButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            nextButton.widthAnchor.constraint(equalToConstant: 26),

            matchLabel.leadingAnchor.constraint(equalTo: nextButton.trailingAnchor, constant: 8),
            matchLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
            matchLabel.widthAnchor.constraint(equalToConstant: 80),
            matchLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
        ])
    }

    private func applyTheme() {
        layer?.backgroundColor = theme.gutterBackground.cgColor
        matchLabel.textColor = theme.comment
        closeButton.contentTintColor = theme.comment
        prevButton.contentTintColor = theme.comment
        nextButton.contentTintColor = theme.comment
    }

    func focusSearchField() {
        searchField.selectText(nil)
        window?.makeFirstResponder(searchField)
    }

    func updateMatchCount(_ count: Int, index: Int) {
        if count == 0 {
            matchLabel.stringValue = "No results"
        } else {
            matchLabel.stringValue = "\(index + 1) of \(count)"
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { // Escape
            closeTapped()
            return
        }
        if event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers == "g" {
            if event.modifierFlags.contains(.shift) {
                prevTapped()
            } else {
                nextTapped()
            }
            return
        }
        super.keyDown(with: event)
    }

    @objc private func searchChanged() {
        onFind?(searchField.stringValue, caseSensitive)
    }

    @objc private func caseToggled() {
        caseSensitive = caseButton.state == .on
        onFind?(searchField.stringValue, caseSensitive)
    }

    @objc private func prevTapped() {
        onFindPrev?()
    }

    @objc private func nextTapped() {
        onFindNext?()
    }

    @objc private func closeTapped() {
        onClose?()
    }
}

// MARK: - LineNumberRulerView

private final class LineNumberRulerView: NSRulerView {
    weak var textView: NSTextView?
    var theme: CodeEditorTheme

    init(textView: NSTextView, theme: CodeEditorTheme) {
        self.textView = textView
        self.theme = theme
        // scrollView is set on the enclosing scroll view after documentView assignment.
        super.init(scrollView: textView.enclosingScrollView, orientation: .verticalRuler)
        clientView = textView
        ruleThickness = 48
    }

    required init(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        theme.gutterBackground.setFill()
        rect.fill()
        guard let textView,
              let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return }
        let visible = textView.visibleRect
        guard visible.height > 0 else { return }
        let glyphRange = layoutManager.glyphRange(forBoundingRect: visible, in: textContainer)
        let text = textView.string as NSString
        var glyphIndex = glyphRange.location
        var scanIndex = 0
        var line = 1
        let labelAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: theme.comment,
        ]
        while glyphIndex < NSMaxRange(glyphRange) {
            var effective = NSRange()
            let fragmentRect = layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: &effective)
            guard effective.length > 0 else { break }
            let y = fragmentRect.minY + textView.textContainerOrigin.y - visible.minY + 1
            let characterIndex = layoutManager.characterIndexForGlyph(at: glyphIndex)
            advanceLineNumber(upTo: characterIndex, in: text, scanIndex: &scanIndex, line: &line)
            let label = "\(line)" as NSString
            let labelSize = label.size(withAttributes: labelAttrs)
            let x = ruleThickness - labelSize.width - 6
            label.draw(at: NSPoint(x: x, y: y), withAttributes: labelAttrs)
            glyphIndex = NSMaxRange(effective)
        }
    }

    private func advanceLineNumber(upTo characterIndex: Int, in text: NSString, scanIndex: inout Int, line: inout Int) {
        while scanIndex < characterIndex, scanIndex < text.length {
            if text.character(at: scanIndex) == 10 { line += 1 }
            scanIndex += 1
        }
    }
}
#endif
