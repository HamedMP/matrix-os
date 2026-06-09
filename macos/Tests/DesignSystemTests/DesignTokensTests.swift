import SwiftUI
import XCTest

@testable import DesignSystem

/// Proves the Matrix OS native token values from DESIGN.md resolve exactly, and that the
/// DesignSystem target compiles and tests run. Color components are compared
/// in sRGB with a small tolerance for floating-point division.
final class DesignTokensTests: XCTestCase {

    private let tolerance: CGFloat = 0.5 / 255.0

    /// Resolve a SwiftUI `Color` to sRGB 0–255 components via AppKit.
    private func rgba(_ color: Color) -> (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) {
        let ns = NSColor(color).usingColorSpace(.sRGB) ?? NSColor(color)
        return (ns.redComponent, ns.greenComponent, ns.blueComponent, ns.alphaComponent)
    }

    private func assertColor(
        _ color: Color,
        hex: UInt32,
        opacity: CGFloat = 1.0,
        _ message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let expectedR = CGFloat((hex >> 16) & 0xFF) / 255.0
        let expectedG = CGFloat((hex >> 8) & 0xFF) / 255.0
        let expectedB = CGFloat(hex & 0xFF) / 255.0
        let actual = rgba(color)
        XCTAssertEqual(actual.r, expectedR, accuracy: tolerance, "\(message) red", file: file, line: line)
        XCTAssertEqual(actual.g, expectedG, accuracy: tolerance, "\(message) green", file: file, line: line)
        XCTAssertEqual(actual.b, expectedB, accuracy: tolerance, "\(message) blue", file: file, line: line)
        XCTAssertEqual(actual.a, opacity, accuracy: tolerance, "\(message) alpha", file: file, line: line)
    }

    // MARK: Signal colors (the load-bearing semantic tokens)

    func testSignalLiveIsForestPrimary() {
        assertColor(.signalLive, hex: 0x434E3F, "signal.live")
    }

    func testSignalWaitingIsWarmWarning() {
        assertColor(.signalWaiting, hex: 0xD49B2A, "signal.waiting")
    }

    func testSignalBlockedIsWarmDestructive() {
        assertColor(.signalBlocked, hex: 0xC4342D, "signal.blocked")
    }

    func testSignalDoneIsWarmSuccessGreen() {
        assertColor(.signalDone, hex: 0x3A7D44, "signal.done")
    }

    func testSignalIdleIsWarmMutedGrey() {
        assertColor(.signalIdle, hex: 0x7A7768, "signal.idle")
    }

    func testSignalGlowLiveIsEmberAt16Percent() {
        assertColor(.signalGlowLive, hex: 0xD06F25, opacity: 0.16, "signal.glow.live")
    }

    // MARK: Canvas & surfaces

    func testCanvasAndSurfaceTokens() {
        assertColor(.canvasVoid, hex: 0xFAFAF5, "canvas.void")
        assertColor(.surfaceRail, hex: 0xF0EDE4, "surface.rail")
        assertColor(.surfaceCard, hex: 0xFFFFFF, "surface.card")
        assertColor(.surfaceCardRaised, hex: 0xF7F1E7, "surface.cardRaised")
        assertColor(.surfaceTerminal, hex: 0x0C0D10, "surface.terminal")
    }

    // MARK: Ink

    func testInkTokens() {
        assertColor(.inkPrimary, hex: 0x32352E, "ink.primary")
        assertColor(.inkSecondary, hex: 0x434E3F, "ink.secondary")
        assertColor(.inkTertiary, hex: 0x7A7768, "ink.tertiary")
        assertColor(.inkDisabled, hex: 0xD6D3C8, "ink.disabled")
        assertColor(.terminalInk, hex: 0xE8EAED, "terminal.ink")
        assertColor(.terminalMutedInk, hex: 0x9BA1AC, "terminal.mutedInk")
    }

    // MARK: Hairline

    func testHairlineTokens() {
        assertColor(.hairlineDark, hex: 0xD6D3C8, "hairline.dark")
        assertColor(.hairlineHighlight, hex: 0xFFFFFF, opacity: 0.75, "hairline.highlight")
    }

    // MARK: §4 Spacing scale (4/8/12/16/24/32/48)

    func testSpacingScale() {
        XCTAssertEqual(Spacing.x1, 4)
        XCTAssertEqual(Spacing.x2, 8)
        XCTAssertEqual(Spacing.x3, 12)
        XCTAssertEqual(Spacing.x4, 16)
        XCTAssertEqual(Spacing.x5, 24)
        XCTAssertEqual(Spacing.x6, 32)
        XCTAssertEqual(Spacing.x7, 48)
    }

    // MARK: §4 Radius scale

    func testRadiusScale() {
        XCTAssertEqual(Radius.card, 10)
        XCTAssertEqual(Radius.badge, 6)
        XCTAssertEqual(Radius.panel, 14)
        XCTAssertEqual(Radius.control, 8)
    }

    // MARK: §5 Motion tokens exist (timings are opaque to runtime introspection;
    // we assert the derived stagger constant which is comparable).

    func testMotionStaggerConstant() {
        XCTAssertEqual(Motion.cardEnterStagger, 0.024, accuracy: 0.0001)
    }

    // MARK: §3 Typography helpers never crash and return a usable font.

    func testTypographyHelpersResolve() {
        // Until IBM Plex binaries ship, these fall back to system fonts; the call must
        // not crash and must return a non-nil Font (compile + runtime smoke).
        _ = Font.plexSans(14, weight: .medium)
        _ = Font.plexMono(12.5, weight: .regular)
    }
}
