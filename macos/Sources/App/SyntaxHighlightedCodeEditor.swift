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

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = true

        let textView = NSTextView()
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
        applyLayoutPreferences(to: textView, in: scrollView, preferences: preferences)

        scrollView.documentView = textView
        scrollView.verticalRulerView = LineNumberRulerView(textView: textView, theme: theme)
        scrollView.hasVerticalRuler = true
        scrollView.rulersVisible = true
        context.coordinator.textView = textView
        context.coordinator.theme = theme
        context.coordinator.preferences = preferences
        context.coordinator.filePath = filePath
        context.coordinator.isEditable = isEditable
        context.coordinator.applyHighlight {
            apply(text: text, to: textView, theme: theme, filePath: filePath, preferences: preferences)
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if let ruler = scrollView.verticalRulerView as? LineNumberRulerView {
            ruler.theme = theme
            ruler.needsDisplay = true
        }
        applyLayoutPreferences(to: textView, in: scrollView, preferences: preferences)
        textView.isEditable = isEditable
        if textView.string != text || context.coordinator.needsHighlight || context.coordinator.theme != theme || context.coordinator.preferences != preferences || context.coordinator.filePath != filePath || context.coordinator.isEditable != isEditable {
            context.coordinator.theme = theme
            context.coordinator.preferences = preferences
            context.coordinator.filePath = filePath
            context.coordinator.isEditable = isEditable
            context.coordinator.needsHighlight = false
            context.coordinator.applyHighlight {
                apply(text: text, to: textView, theme: theme, filePath: filePath, preferences: preferences)
            }
        }
    }

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

    private func apply(text: String, to textView: NSTextView, theme: CodeEditorTheme, filePath: String?, preferences: CodeEditorPreferences) {
        let selected = textView.selectedRange()
        textView.backgroundColor = theme.background
        textView.insertionPointColor = theme.foreground
        textView.textColor = theme.foreground
        textView.font = Self.editorFont(size: preferences.fontSize)
        textView.defaultParagraphStyle = Self.paragraphStyle(tabWidth: preferences.tabWidth, fontSize: preferences.fontSize, wrapsLines: preferences.wrapsLines)
        textView.textStorage?.setAttributedString(Self.highlightedText(text, filePath: filePath, theme: theme, preferences: preferences))
        textView.setSelectedRange(NSRange(location: min(selected.location, (text as NSString).length), length: 0))
        textView.needsDisplay = true
        textView.layoutManager?.ensureLayout(for: textView.textContainer!)
    }

    private static func editorFont(size: Double) -> NSFont {
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
            apply(pattern: #" |\t"#, color: theme.comment.withAlphaComponent(0.55), to: output, range: fullRange)
        }
        apply(pattern: #""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"#, color: theme.string, to: output, range: fullRange)
        if language.supportsLineComments {
            apply(pattern: language.commentPattern, color: theme.comment, to: output, range: fullRange)
        }
        if language.supportsKeywords {
            apply(pattern: language.keywordPattern, color: theme.keyword, to: output, range: fullRange)
        }
        return output
    }

    private struct SyntaxLanguage {
        var supportsLineComments: Bool
        var supportsKeywords: Bool
        var commentPattern: String
        var keywordPattern: String
    }

    private static func syntaxLanguage(for filePath: String?) -> SyntaxLanguage {
        let fallback = SyntaxLanguage(
            supportsLineComments: true,
            supportsKeywords: true,
            commentPattern: #"(?m)(//.*$|#.*$)"#,
            keywordPattern: #"\b(import|export|from|func|function|let|const|var|struct|class|enum|protocol|extension|public|private|return|if|else|switch|case|for|while|guard|try|await|async|throws|type|interface|extends|implements|new|in|of)\b"#
        )
        guard let filePath, !filePath.isEmpty else { return fallback }
        let ext = URL(fileURLWithPath: filePath).pathExtension.lowercased()
        switch ext {
        case "json", "jsonc", "yaml", "yml", "toml", "xml", "html", "htm", "md", "markdown", "txt", "log", "csv":
            return SyntaxLanguage(
                supportsLineComments: false,
                supportsKeywords: false,
                commentPattern: fallback.commentPattern,
                keywordPattern: fallback.keywordPattern
            )
        case "py", "rb", "sh", "bash", "zsh":
            return SyntaxLanguage(
                supportsLineComments: true,
                supportsKeywords: true,
                commentPattern: #"(?m)#.*$"#,
                keywordPattern: fallback.keywordPattern
            )
        default:
            return fallback
        }
    }

    private static func apply(pattern: String, color: NSColor, to output: NSMutableAttributedString, range: NSRange) {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return }
        regex.enumerateMatches(in: output.string, range: range) { match, _, _ in
            guard let match else { return }
            output.addAttribute(.foregroundColor, value: color, range: match.range)
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        weak var textView: NSTextView?
        var theme: CodeEditorTheme?
        var preferences: CodeEditorPreferences?
        var filePath: String?
        var isEditable = true
        var needsHighlight = false
        private var isApplyingHighlight = false

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
    }
}

private final class LineNumberRulerView: NSRulerView {
    weak var textView: NSTextView?
    var theme: CodeEditorTheme

    init(textView: NSTextView, theme: CodeEditorTheme) {
        self.textView = textView
        self.theme = theme
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
        guard let textView, let layoutManager = textView.layoutManager, let textContainer = textView.textContainer else { return }
        let visible = textView.visibleRect
        let glyphRange = layoutManager.glyphRange(forBoundingRect: visible, in: textContainer)
        let text = textView.string as NSString
        var glyphIndex = glyphRange.location
        var scanIndex = 0
        var line = 1
        while glyphIndex < NSMaxRange(glyphRange) {
            var effective = NSRange()
            let rect = layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: &effective)
            let y = rect.minY + textView.textContainerOrigin.y - visible.minY + 1
            let characterIndex = layoutManager.characterIndexForGlyph(at: glyphIndex)
            advanceLineNumber(upTo: characterIndex, in: text, scanIndex: &scanIndex, line: &line)
            let label = "\(line)" as NSString
            label.draw(
                at: NSPoint(x: 8, y: y),
                withAttributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
                    .foregroundColor: theme.comment,
                ]
            )
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
