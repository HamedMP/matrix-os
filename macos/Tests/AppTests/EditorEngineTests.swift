#if os(macOS)
import XCTest
import AppKit
@testable import MatrixOS

final class EditorEngineTests: XCTestCase {
    func testNativeTextKitIsTheDefaultCurrentEditorEngine() {
        let config = EditorEngineConfiguration.default

        XCTAssertEqual(config.kind, .textKitNative)
        XCTAssertEqual(config.displayName, "Native TextKit")
        XCTAssertTrue(config.isLaunchSafe)
        XCTAssertFalse(config.isVSCodeClassTarget)
    }

    func testCodeMirrorIsLightweightPreviewAndEditingEngine() {
        let config = EditorEngineConfiguration(kind: .codeMirror)

        XCTAssertEqual(config.displayName, "CodeMirror")
        XCTAssertTrue(config.isLightweight)
        XCTAssertFalse(config.isVSCodeClassTarget)
    }

    func testMonacoIsTheVSCodeClassTargetEngine() {
        let config = EditorEngineConfiguration(kind: .monaco)

        XCTAssertEqual(config.displayName, "Monaco")
        XCTAssertFalse(config.isLaunchSafe)
        XCTAssertFalse(config.isLightweight)
        XCTAssertTrue(config.isVSCodeClassTarget)
    }

    func testSyntaxHighlightedCodeEditorReportsNativeEngineMetadata() {
        XCTAssertEqual(SyntaxHighlightedCodeEditor.engineConfiguration.kind, .textKitNative)
    }

    func testNativeEditorHasAwardGradeThemeChoicesAndPreferences() {
        XCTAssertTrue(CodeEditorTheme.allCases.contains(.xcodeDark))
        XCTAssertTrue(CodeEditorTheme.allCases.contains(.solarizedLight))
        XCTAssertTrue(CodeEditorTheme.allCases.contains(.oneDark))
        XCTAssertTrue(CodeEditorTheme.xcodeDark.isDark)
        XCTAssertFalse(CodeEditorTheme.solarizedLight.isDark)

        let preferences = CodeEditorPreferences.default
        XCTAssertEqual(preferences.fontSize, 13)
        XCTAssertEqual(preferences.tabWidth, 4)
        XCTAssertTrue(preferences.wrapsLines)
    }

    func testWrappedEditorNeverStartsWithZeroWidthTextContainer() {
        XCTAssertEqual(
            SyntaxHighlightedCodeEditor.resolvedTextContainerWidth(contentWidth: 0, boundsWidth: 0, wrapsLines: true),
            320
        )
        XCTAssertEqual(
            SyntaxHighlightedCodeEditor.resolvedTextContainerWidth(contentWidth: 180, boundsWidth: 260, wrapsLines: true),
            320
        )
        XCTAssertEqual(
            SyntaxHighlightedCodeEditor.resolvedTextContainerWidth(contentWidth: 900, boundsWidth: 700, wrapsLines: true),
            900
        )
        XCTAssertEqual(
            SyntaxHighlightedCodeEditor.resolvedTextContainerWidth(contentWidth: 0, boundsWidth: 0, wrapsLines: false),
            CGFloat.greatestFiniteMagnitude
        )
    }

    @MainActor
    func testPreviewSyntaxHighlighterColorsKeywordsAndStrings() {
        let highlighted = SyntaxHighlightedCodeEditor.highlightedText(
            #"let title = "Matrix""#,
            filePath: "App.swift",
            theme: .xcodeDark,
            preferences: .default
        )

        let nsText = highlighted.string as NSString
        let keywordRange = nsText.range(of: "let")
        let stringRange = nsText.range(of: "\"Matrix\"")

        XCTAssertNotNil(highlighted.attribute(.foregroundColor, at: keywordRange.location, effectiveRange: nil))
        XCTAssertNotNil(highlighted.attribute(.foregroundColor, at: stringRange.location, effectiveRange: nil))
    }
}
#endif
