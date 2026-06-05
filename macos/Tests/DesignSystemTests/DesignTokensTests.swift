import SwiftUI
import XCTest

@testable import DesignSystem

/// Proves the OPERATOR token values from design.md §2–§5/§9 resolve exactly, and that the
/// DesignSystem target compiles and tests run (Phase 1 gate). Color components are compared
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

    // MARK: §2 Signal colors (the load-bearing semantic tokens)

    func testSignalLiveIsPhosphorLime() {
        assertColor(.signalLive, hex: 0x9EF01A, "signal.live")
    }

    func testSignalWaitingIsAmber() {
        assertColor(.signalWaiting, hex: 0xFFB020, "signal.waiting")
    }

    func testSignalBlockedIsCoral() {
        assertColor(.signalBlocked, hex: 0xFF5C5C, "signal.blocked")
    }

    func testSignalDoneIsTeal() {
        assertColor(.signalDone, hex: 0x43C59E, "signal.done")
    }

    func testSignalIdleIsGrey() {
        assertColor(.signalIdle, hex: 0x5C636E, "signal.idle")
    }

    func testSignalGlowLiveIsLimeAt22Percent() {
        assertColor(.signalGlowLive, hex: 0x9EF01A, opacity: 0.22, "signal.glow.live")
    }

    // MARK: §2 Canvas & surfaces

    func testCanvasAndSurfaceTokens() {
        assertColor(.canvasVoid, hex: 0x0A0B0D, "canvas.void")
        assertColor(.surfaceRail, hex: 0x101216, "surface.rail")
        assertColor(.surfaceCard, hex: 0x15171C, "surface.card")
        assertColor(.surfaceCardRaised, hex: 0x1B1E24, "surface.cardRaised")
        assertColor(.surfaceTerminal, hex: 0x0C0D10, "surface.terminal")
    }

    // MARK: §2 Ink

    func testInkTokens() {
        assertColor(.inkPrimary, hex: 0xE8EAED, "ink.primary")
        assertColor(.inkSecondary, hex: 0x9BA1AC, "ink.secondary")
        assertColor(.inkTertiary, hex: 0x5C636E, "ink.tertiary")
        assertColor(.inkDisabled, hex: 0x3A3F47, "ink.disabled")
    }

    // MARK: §2 Hairline (dual-tone)

    func testHairlineTokens() {
        assertColor(.hairlineDark, hex: 0x000000, opacity: 0.60, "hairline.dark")
        assertColor(.hairlineHighlight, hex: 0xFFFFFF, opacity: 0.06, "hairline.highlight")
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
        XCTAssertEqual(Radius.badge, 5)
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
