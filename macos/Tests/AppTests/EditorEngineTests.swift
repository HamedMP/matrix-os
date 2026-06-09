#if os(macOS)
import XCTest
import AppKit
import SwiftUI
@testable import MatrixOS

final class EditorEngineTests: XCTestCase {
    func testCodeEditSourceEditorIsTheDefaultCurrentEditorEngine() {
        let config = EditorEngineConfiguration.default

        XCTAssertEqual(config.kind, .codeEditSourceEditor)
        XCTAssertEqual(config.displayName, "CodeEditSourceEditor")
        XCTAssertTrue(config.isLaunchSafe)
        XCTAssertFalse(config.isLightweight)
        XCTAssertFalse(config.isVSCodeClassTarget)
    }

    func testCodeMirrorRemainsLightweightPreviewOption() {
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

    func testSyntaxHighlightedCodeEditorReportsCodeEditSourceEditorMetadata() {
        XCTAssertEqual(SyntaxHighlightedCodeEditor.engineConfiguration.kind, .codeEditSourceEditor)
    }

    func testNativeEditorHasAwardGradeThemeChoicesAndPreferences() {
        XCTAssertTrue(CodeEditorTheme.allCases.contains(.xcodeDark))
        XCTAssertTrue(CodeEditorTheme.allCases.contains(.solarizedLight))
        XCTAssertTrue(CodeEditorTheme.allCases.contains(.solarizedDark))
        XCTAssertTrue(CodeEditorTheme.allCases.contains(.oneDark))
        XCTAssertTrue(CodeEditorTheme.xcodeDark.isDark)
        XCTAssertFalse(CodeEditorTheme.solarizedLight.isDark)
        XCTAssertTrue(CodeEditorTheme.solarizedDark.isDark)

        let preferences = CodeEditorPreferences.default
        XCTAssertEqual(preferences.fontSize, 13)
        XCTAssertEqual(preferences.tabWidth, 4)
        XCTAssertTrue(preferences.wrapsLines)
    }

    @MainActor
    func testCodeEditSourceEditorLanguageDetectionUsesFilePath() {
        XCTAssertEqual(SyntaxHighlightedCodeEditor.languageName(for: "package.json"), "json")
        XCTAssertEqual(SyntaxHighlightedCodeEditor.languageName(for: "Sources/App.swift"), "swift")
        XCTAssertEqual(SyntaxHighlightedCodeEditor.languageName(for: "home/templates/sqlite-client.js"), "javascript")
        XCTAssertEqual(SyntaxHighlightedCodeEditor.languageName(for: "shell/eslint.config.mjs"), "javascript")
        XCTAssertEqual(SyntaxHighlightedCodeEditor.languageName(for: "scripts/build.cjs"), "javascript")
        XCTAssertEqual(SyntaxHighlightedCodeEditor.languageName(for: "shell/src/app/page.tsx"), "typescript")
        XCTAssertEqual(SyntaxHighlightedCodeEditor.languageName(for: "README.md"), "markdown")
        XCTAssertEqual(SyntaxHighlightedCodeEditor.languageName(for: "docker-compose.yml"), "yaml")
    }

    func testWorkspaceFileSearchRanksNameMatchesBeforePathMatches() {
        let results = WorkspaceFileSearchItem.filtered(
            paths: [
                "projects/matrix-os/home/templates/sqlite-client.js",
                "projects/matrix-os/shell/src/lib/platform-session.ts",
                "projects/matrix-os/packages/sql/client.ts",
            ],
            query: "sqlite"
        )

        XCTAssertEqual(results.first?.path, "projects/matrix-os/home/templates/sqlite-client.js")
        XCTAssertEqual(results.map(\.path), [
            "projects/matrix-os/home/templates/sqlite-client.js",
        ])
    }

    func testWorkspaceFileSearchReturnsStableTopResultsForEmptyQuery() {
        let results = WorkspaceFileSearchItem.filtered(
            paths: [
                "projects/matrix-os/zeta.swift",
                "projects/matrix-os/App.swift",
                "projects/matrix-os/README.md",
            ],
            query: "",
            limit: 2
        )

        XCTAssertEqual(results.map(\.name), ["App.swift", "README.md"])
    }

    @MainActor
    func testCodeEditSourceEditorThemeMapsPlainTextAndSyntaxColors() {
        let theme = CodeEditorTheme.solarizedDark.sourceEditorTheme

        XCTAssertEqual(theme.background, CodeEditorTheme.solarizedDark.background)
        XCTAssertEqual(theme.text.color, CodeEditorTheme.solarizedDark.foreground)
        XCTAssertEqual(theme.keywords.color, CodeEditorTheme.solarizedDark.keyword)
        XCTAssertEqual(theme.strings.color, CodeEditorTheme.solarizedDark.string)
        XCTAssertEqual(theme.comments.color, CodeEditorTheme.solarizedDark.comment)
    }

    @MainActor
    func testCodeEditSourceEditorWrapperInstantiatesForLoadedJSON() {
        let source = """
        {
          "name": "matrix-os",
          "scripts": {
            "test": "vitest"
          }
        }
        """
        let view = NSHostingView(rootView: SyntaxHighlightedCodeEditor(
            text: .constant(source),
            filePath: "package.json",
            theme: .xcodeDark,
            preferences: .default
        ))
        view.frame = NSRect(x: 0, y: 0, width: 720, height: 360)
        view.layoutSubtreeIfNeeded()

        XCTAssertEqual(view.frame.size.width, 720)
        XCTAssertEqual(view.frame.size.height, 360)
        XCTAssertFalse(view.subviews.isEmpty)
    }
}
#endif
