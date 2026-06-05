// OPERATOR design system tokens for the Matrix OS macOS app.
//
// These tokens are the single source of truth for the "OPERATOR" look defined in
// specs/086-macos-native-shell/design.md (§2 color, §3 typography, §4 spacing/radius,
// §5 motion). Component code MUST reference these tokens only — never inline hex,
// sizes, or animation timings — so the look stays cohesive and themeable for the
// later light mode.

import SwiftUI

// MARK: - Hex helper

extension Color {
    /// Creates a `Color` from a 24-bit RGB hex value (e.g. `0x9EF01A`) with optional opacity.
    /// Tokens are P3-friendly; SwiftUI resolves them in the display's working color space.
    init(hex: UInt32, opacity: Double = 1.0) {
        let red = Double((hex >> 16) & 0xFF) / 255.0
        let green = Double((hex >> 8) & 0xFF) / 255.0
        let blue = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: opacity)
    }
}

// MARK: - §2 Color system (dark-first)

extension Color {
    // Canvas & surfaces
    /// `canvas.void` — window background (machined near-black). `#0A0B0D`
    public static let canvasVoid = Color(hex: 0x0A0B0D)
    /// `surface.rail` — column rails / sidebar. `#101216`
    public static let surfaceRail = Color(hex: 0x101216)
    /// `surface.card` — card body. `#15171C`
    public static let surfaceCard = Color(hex: 0x15171C)
    /// `surface.cardRaised` — hovered/dragging card. `#1B1E24`
    public static let surfaceCardRaised = Color(hex: 0x1B1E24)
    /// `surface.terminal` — terminal panel (deeper than cards). `#0C0D10`
    public static let surfaceTerminal = Color(hex: 0x0C0D10)

    // Hairline (dual-tone engraved 1px borders, §2)
    /// Dark line of the engraved hairline: `#000000 @ 60%`.
    public static let hairlineDark = Color(hex: 0x000000, opacity: 0.60)
    /// Top highlight of the engraved hairline: `#FFFFFF @ 6%`.
    public static let hairlineHighlight = Color(hex: 0xFFFFFF, opacity: 0.06)

    // Ink (text)
    /// `ink.primary` — titles, terminal text. `#E8EAED`
    public static let inkPrimary = Color(hex: 0xE8EAED)
    /// `ink.secondary` — metadata. `#9BA1AC`
    public static let inkSecondary = Color(hex: 0x9BA1AC)
    /// `ink.tertiary` — timestamps, hints. `#5C636E`
    public static let inkTertiary = Color(hex: 0x5C636E)
    /// `ink.disabled`. `#3A3F47`
    public static let inkDisabled = Color(hex: 0x3A3F47)

    // Signal (the only saturated colors — reserved for state, §2)
    /// `signal.live` — phosphor lime, running/streaming (the breathing glow). `#9EF01A`
    public static let signalLive = Color(hex: 0x9EF01A)
    /// `signal.waiting` — amber, waiting on input/approval. `#FFB020`
    public static let signalWaiting = Color(hex: 0xFFB020)
    /// `signal.blocked` — coral, blocked/error. `#FF5C5C`
    public static let signalBlocked = Color(hex: 0xFF5C5C)
    /// `signal.done` — teal, complete. `#43C59E`
    public static let signalDone = Color(hex: 0x43C59E)
    /// `signal.idle` — grey, todo/exited (no color = no life). `#5C636E`
    public static let signalIdle = Color(hex: 0x5C636E)
    /// `signal.glow.live` — edge bloom on active cards: `signal.live @ 22%`.
    public static let signalGlowLive = Color(hex: 0x9EF01A, opacity: 0.22)
}

// MARK: - §4 Spacing (8pt base with 4pt sub-step)

/// Spacing scale. `space.1=4 … space.7=48` (design.md §4).
public enum Spacing {
    /// 4 pt
    public static let x1: CGFloat = 4
    /// 8 pt
    public static let x2: CGFloat = 8
    /// 12 pt
    public static let x3: CGFloat = 12
    /// 16 pt
    public static let x4: CGFloat = 16
    /// 24 pt
    public static let x5: CGFloat = 24
    /// 32 pt
    public static let x6: CGFloat = 32
    /// 48 pt
    public static let x7: CGFloat = 48
}

// MARK: - §4 Radius (engraved, not pill-soft)

/// Corner radius scale (design.md §4).
public enum Radius {
    /// Card corner radius. `radius.card=10`
    public static let card: CGFloat = 10
    /// Badge corner radius. `radius.badge=5`
    public static let badge: CGFloat = 5
    /// Panel corner radius. `radius.panel=14`
    public static let panel: CGFloat = 14
    /// Control corner radius. `radius.control=8`
    public static let control: CGFloat = 8
}

// MARK: - §5 Motion (instrument-crisp, never bouncy-toy)

/// Animation timings (design.md §5). Component code references these — never inline
/// `.spring`/`.easeOut` literals — so motion stays consistent and Reduce-Motion-aware.
public enum Motion {
    /// Hover/tint: `.easeOut`, 120 ms.
    public static let hover = Animation.easeOut(duration: 0.12)
    /// Panel toggle (term↔shell↔app): `.spring(response: 0.34, damping: 0.86)`.
    public static let panelSwitch = Animation.spring(response: 0.34, dampingFraction: 0.86)
    /// Card drag pickup/drop: `.spring(response: 0.30, damping: 0.80)`.
    public static let cardDrag = Animation.spring(response: 0.30, dampingFraction: 0.80)
    /// Column reflow on drop: `.spring(response: 0.40, damping: 0.90)`.
    public static let columnReflow = Animation.spring(response: 0.40, dampingFraction: 0.90)
    /// Card enter (new): fade+rise, `.easeOut`, 180 ms (stagger 24 ms applied per-card).
    public static let cardEnter = Animation.easeOut(duration: 0.18)
    /// Per-card stagger for orchestrated enters/loads (24 ms).
    public static let cardEnterStagger: Double = 0.024
    /// Live edge-glow breathe: `.easeInOut` autoreverse, 2.4 s loop.
    public static let liveBreathe = Animation.easeInOut(duration: 2.4).repeatForever(autoreverses: true)
    /// Status change flash: `.easeOut`, 200 ms one-shot.
    public static let statusFlash = Animation.easeOut(duration: 0.20)
}

// MARK: - §3 Typography helpers

extension Font {
    /// Internal font-family names for IBM Plex once the bundled binaries are present.
    /// Until the fonts ship (see Resources/Fonts/README.md), the helpers fall back to a
    /// monospaced system font so the build never blocks on missing binaries.
    enum PlexFamily {
        static let sans = "IBMPlexSans"
        static let mono = "IBMPlexMono"
    }

    /// Returns whether a custom font family is registered/available by name.
    private static func isAvailable(_ familyName: String) -> Bool {
        #if canImport(AppKit)
        return NSFontManager.shared.availableFontFamilies.contains(familyName)
            || NSFont(name: familyName, size: 12) != nil
        #else
        return false
        #endif
    }

    /// IBM Plex Sans — display/chrome/titles (design.md §3).
    /// TODO(086): ships the IBM Plex Sans binaries per Resources/Fonts/README.md.
    /// Falls back to a humanist-leaning system font until then.
    public static func plexSans(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        if isAvailable(PlexFamily.sans) {
            return .custom(PlexFamily.sans, size: size).weight(weight)
        }
        return .system(size: size, weight: weight, design: .default)
    }

    /// IBM Plex Mono — mono/data/terminal/badges, "the voice of the machine" (design.md §3).
    /// TODO(086): ships the IBM Plex Mono binaries per Resources/Fonts/README.md.
    /// Falls back to a monospaced system font until then.
    public static func plexMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        if isAvailable(PlexFamily.mono) {
            return .custom(PlexFamily.mono, size: size).weight(weight)
        }
        return .system(size: size, weight: weight, design: .monospaced)
    }
}
