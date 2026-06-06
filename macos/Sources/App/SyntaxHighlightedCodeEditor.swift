#if os(macOS)
import SwiftUI
import AppKit
import DesignSystem

enum CodeEditorTheme: String, CaseIterable, Identifiable {
    case matrixLight = "Matrix Light"
    case xcodeLight = "Xcode"
    case terminalDark = "Terminal"

    var id: String { rawValue }

    var background: NSColor {
        switch self {
        case .matrixLight: return NSColor.matrixHex(0xFFFFFF)
        case .xcodeLight: return NSColor(calibratedWhite: 0.99, alpha: 1)
        case .terminalDark: return NSColor.matrixHex(0x0C0D10)
        }
    }

    var foreground: NSColor {
        switch self {
        case .matrixLight, .xcodeLight: return NSColor.matrixHex(0x32352E)
        case .terminalDark: return NSColor.matrixHex(0xE8EAED)
        }
    }

    var keyword: NSColor {
        switch self {
        case .matrixLight: return NSColor(Color.signalLive)
        case .xcodeLight: return NSColor(calibratedRed: 0.58, green: 0.16, blue: 0.66, alpha: 1)
        case .terminalDark: return NSColor(calibratedRed: 0.67, green: 0.82, blue: 1.0, alpha: 1)
        }
    }

    var string: NSColor {
        switch self {
        case .matrixLight: return NSColor(calibratedRed: 0.62, green: 0.31, blue: 0.12, alpha: 1)
        case .xcodeLight: return NSColor(calibratedRed: 0.74, green: 0.25, blue: 0.12, alpha: 1)
        case .terminalDark: return NSColor(calibratedRed: 0.84, green: 0.70, blue: 0.45, alpha: 1)
        }
    }

    var comment: NSColor {
        switch self {
        case .matrixLight, .xcodeLight: return NSColor.matrixHex(0x7A7768)
        case .terminalDark: return NSColor.matrixHex(0x9BA1AC)
        }
    }

    var gutterBackground: NSColor {
        switch self {
        case .matrixLight: return NSColor.matrixHex(0xF0EDE4)
        case .xcodeLight: return NSColor(calibratedWhite: 0.95, alpha: 1)
        case .terminalDark: return NSColor(calibratedWhite: 0.08, alpha: 1)
        }
    }
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

struct SyntaxHighlightedCodeEditor: NSViewRepresentable {
    @Binding var text: String
    let filePath: String?
    let theme: CodeEditorTheme

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
        textView.drawsBackground = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.allowsUndo = true
        textView.delegate = context.coordinator
        textView.textContainerInset = NSSize(width: 14, height: 14)
        textView.textContainer?.lineFragmentPadding = 0
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: scrollView.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true

        scrollView.documentView = textView
        scrollView.verticalRulerView = LineNumberRulerView(textView: textView, theme: theme)
        scrollView.hasVerticalRuler = true
        scrollView.rulersVisible = true
        context.coordinator.textView = textView
        context.coordinator.theme = theme
        context.coordinator.filePath = filePath
        context.coordinator.applyHighlight {
            apply(text: text, to: textView, theme: theme, filePath: filePath)
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if let ruler = scrollView.verticalRulerView as? LineNumberRulerView {
            ruler.theme = theme
            ruler.needsDisplay = true
        }
        if textView.string != text || context.coordinator.needsHighlight || context.coordinator.theme != theme || context.coordinator.filePath != filePath {
            context.coordinator.theme = theme
            context.coordinator.filePath = filePath
            context.coordinator.needsHighlight = false
            context.coordinator.applyHighlight {
                apply(text: text, to: textView, theme: theme, filePath: filePath)
            }
        }
    }

    private func apply(text: String, to textView: NSTextView, theme: CodeEditorTheme, filePath: String?) {
        let selected = textView.selectedRange()
        textView.backgroundColor = theme.background
        textView.insertionPointColor = theme.foreground
        textView.textColor = theme.foreground
        textView.font = Self.editorFont(size: 13)
        textView.textStorage?.setAttributedString(Self.highlighted(text, filePath: filePath, theme: theme))
        textView.setSelectedRange(NSRange(location: min(selected.location, (text as NSString).length), length: 0))
        textView.needsDisplay = true
        textView.layoutManager?.ensureLayout(for: textView.textContainer!)
    }

    private static func editorFont(size: CGFloat) -> NSFont {
        for name in ["JetBrainsMono Nerd Font Mono", "JetBrains Mono", "SFMono-Regular", "Menlo"] {
            if let font = NSFont(name: name, size: size) { return font }
        }
        return NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    private static func highlighted(_ text: String, filePath: String?, theme: CodeEditorTheme) -> NSAttributedString {
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        let output = NSMutableAttributedString(
            string: text,
            attributes: [.font: editorFont(size: 13), .foregroundColor: theme.foreground]
        )
        apply(pattern: #""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"#, color: theme.string, to: output, range: fullRange)
        apply(pattern: #"(?m)(//.*$|#.*$)"#, color: theme.comment, to: output, range: fullRange)
        apply(pattern: #"\b(import|export|from|func|function|let|const|var|struct|class|enum|protocol|extension|public|private|return|if|else|switch|case|for|while|guard|try|await|async|throws|type|interface|extends|implements|new|in|of)\b"#, color: theme.keyword, to: output, range: fullRange)
        return output
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
        var filePath: String?
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
        var line = 1
        var index = 0
        while index < glyphRange.location, index < text.length {
            if text.character(at: index) == 10 { line += 1 }
            index += 1
        }
        var glyphIndex = glyphRange.location
        while glyphIndex < NSMaxRange(glyphRange) {
            var effective = NSRange()
            let rect = layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: &effective)
            let y = rect.minY + textView.textContainerOrigin.y - visible.minY + 1
            let label = "\(line)" as NSString
            label.draw(
                at: NSPoint(x: 8, y: y),
                withAttributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
                    .foregroundColor: theme.comment,
                ]
            )
            glyphIndex = NSMaxRange(effective)
            line += 1
        }
    }
}
#endif
