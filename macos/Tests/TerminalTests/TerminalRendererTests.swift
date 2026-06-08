import XCTest
@testable import MatrixTerminal

final class TerminalRendererTests: XCTestCase {
    func testSwiftTermIsTheDefaultLaunchSafeRenderer() {
        let config = TerminalRendererConfiguration.default

        XCTAssertEqual(config.kind, .swiftTerm)
        XCTAssertEqual(config.displayName, "SwiftTerm")
        XCTAssertTrue(config.isLaunchSafe)
        XCTAssertFalse(config.isExperimental)
    }

    func testGhosttyRendererIsExperimentalUntilSpikeGatesPass() {
        let config = TerminalRendererConfiguration(kind: .ghostty)

        XCTAssertEqual(config.kind, .ghostty)
        XCTAssertEqual(config.displayName, "Ghostty")
        XCTAssertFalse(config.isLaunchSafe)
        XCTAssertTrue(config.isExperimental)
    }

    func testTerminalPanelReportsSwiftTermRendererMetadata() {
        XCTAssertEqual(TerminalPanelView.rendererConfiguration.kind, .swiftTerm)
    }

    func testTerminalFocusUsesRetryPolicyAfterWindowAttachment() {
        XCTAssertEqual(TerminalFocusPolicy.initialFocusRetryDelays, [0, 0.05, 0.15, 0.35])
    }

    func testExperimentalRenderersAreHiddenUnlessExplicitlyAllowed() {
        XCTAssertEqual(
            TerminalRendererConfiguration.available().map(\.kind),
            [.swiftTerm]
        )
        XCTAssertEqual(
            TerminalRendererConfiguration.available(includeExperimental: true).map(\.kind),
            [.swiftTerm, .ghostty, .xtermWebView]
        )
    }
}
