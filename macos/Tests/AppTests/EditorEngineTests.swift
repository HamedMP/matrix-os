#if os(macOS)
import XCTest
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
        XCTAssertFalse(preferences.wrapsLines)
    }
}
#endif
