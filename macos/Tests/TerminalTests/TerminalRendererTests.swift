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
        XCTAssertEqual(TerminalFocusPolicy.attachedFocusRetryDelays, [0, 0.05, 0.15])
    }

    func testInitialTerminalFocusDoesNotStealFromActiveControls() {
        XCTAssertTrue(TerminalFocusPolicy.shouldRequestInitialFocus(
            hasFirstResponder: false,
            firstResponderIsTerminal: false,
            firstResponderIsRootView: false
        ))
        XCTAssertTrue(TerminalFocusPolicy.shouldRequestInitialFocus(
            hasFirstResponder: true,
            firstResponderIsTerminal: true,
            firstResponderIsRootView: false
        ))
        XCTAssertTrue(TerminalFocusPolicy.shouldRequestInitialFocus(
            hasFirstResponder: true,
            firstResponderIsTerminal: false,
            firstResponderIsRootView: true
        ))
        XCTAssertTrue(TerminalFocusPolicy.shouldRequestInitialFocus(
            hasFirstResponder: true,
            firstResponderIsTerminal: false,
            firstResponderIsRootView: false,
            firstResponderIsWindow: true
        ))
        XCTAssertFalse(TerminalFocusPolicy.shouldRequestInitialFocus(
            hasFirstResponder: true,
            firstResponderIsTerminal: false,
            firstResponderIsRootView: false
        ))
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

    func testTerminalLiveOverlayOnlyShowsBeforeAttach() {
        XCTAssertTrue(TerminalConnectionOverlayPolicy.shouldShowOverlay(for: .connecting))
        XCTAssertTrue(TerminalConnectionOverlayPolicy.shouldShowOverlay(for: .reconnecting))
        XCTAssertFalse(TerminalConnectionOverlayPolicy.shouldShowOverlay(for: .attached))
        XCTAssertFalse(TerminalConnectionOverlayPolicy.shouldShowOverlay(for: .exited(code: 0)))
        XCTAssertFalse(TerminalConnectionOverlayPolicy.shouldShowOverlay(for: .error(code: "internal")))
    }

    func testTerminalOverlayStaysUpDuringStartupSettling() {
        XCTAssertTrue(TerminalConnectionOverlayPolicy.shouldShowOverlay(
            for: .attached,
            isStartupSettling: true
        ))
        XCTAssertFalse(TerminalConnectionOverlayPolicy.shouldShowOverlay(
            for: .attached,
            isStartupSettling: false
        ))
    }
}
