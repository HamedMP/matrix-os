// Matrix OS native design system tokens.
//
// These tokens bridge the Matrix OS landing-page design contract (`DESIGN.md`) with
// the macOS native shell. The app shell is light-first: warm off-white canvas,
// forest/cream navigation, ember accents, and deep text. Terminal surfaces remain
// dark because terminal legibility and ANSI rendering need a high-contrast console.

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

// MARK: - Color system (Matrix OS light-first, DESIGN.md)

extension Color {
    // Canvas & surfaces
    /// `background` — warm off-white app canvas. `#FAFAF5`
    public static let canvasVoid = Color(hex: 0xFAFAF5)
    /// `muted` — sand/cream rail and sidebar surface. `#F0EDE4`
    public static let surfaceRail = Color(hex: 0xF0EDE4)
    /// `--card` — white card/panel surface. `#FFFFFF`
    public static let surfaceCard = Color(hex: 0xFFFFFF)
    /// Raised/hover surface: sand-light. `#F7F1E7`
    public static let surfaceCardRaised = Color(hex: 0xF7F1E7)
    /// Terminal panel remains dark. `#0C0D10`
    public static let surfaceTerminal = Color(hex: 0x0C0D10)

    // Hairline / border
    /// `border` — warm neutral. `#D6D3C8`
    public static let hairlineDark = Color(hex: 0xD6D3C8)
    /// Subtle card highlight edge.
    public static let hairlineHighlight = Color(hex: 0xFFFFFF, opacity: 0.75)

    // Ink (text)
    /// `foreground` / Deep. `#32352E`
    public static let inkPrimary = Color(hex: 0x32352E)
    /// Forest secondary text/emphasis. `#434E3F`
    public static let inkSecondary = Color(hex: 0x434E3F)
    /// `muted-foreground`. `#7A7768`
    public static let inkTertiary = Color(hex: 0x7A7768)
    /// Disabled/border neutral. `#D6D3C8`
    public static let inkDisabled = Color(hex: 0xD6D3C8)
    /// Terminal foreground, separate from app-shell ink.
    public static let terminalInk = Color(hex: 0xE8EAED)
    /// Terminal muted foreground.
    public static let terminalMutedInk = Color(hex: 0x9BA1AC)

    // Signal / semantic colors from DESIGN.md
    /// `primary` / Forest. `#434E3F`
    public static let signalLive = Color(hex: 0x434E3F)
    /// `warning`. `#D49B2A`
    public static let signalWaiting = Color(hex: 0xD49B2A)
    /// `destructive`. `#C4342D`
    public static let signalBlocked = Color(hex: 0xC4342D)
    /// `success`. `#3A7D44`
    public static let signalDone = Color(hex: 0x3A7D44)
    /// Muted status gray. `#7A7768`
    public static let signalIdle = Color(hex: 0x7A7768)
    /// Ember glow, `rgba(208, 111, 37, 0.16)`.
    public static let signalGlowLive = Color(hex: 0xD06F25, opacity: 0.16)
}

// MARK: - §4 Spacing (8pt base with 4pt sub-step)

/// Spacing scale. `xs=4 … 2xl=48` (DESIGN.md).
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

/// Corner radius scale adapted from DESIGN.md.
public enum Radius {
    /// Card corner radius. `rounded.md=10`
    public static let card: CGFloat = 10
    /// Badge corner radius, compact native adaptation.
    public static let badge: CGFloat = 6
    /// Panel corner radius. `rounded.lg=14`
    public static let panel: CGFloat = 14
    /// Control corner radius, between `rounded.sm` and `rounded.md`.
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

    /// Inter-ish UI/body fallback for display/chrome/titles (DESIGN.md typography).
    /// TODO(086): ships the IBM Plex Sans binaries per Resources/Fonts/README.md.
    /// Falls back to a humanist-leaning system font until then.
    public static func plexSans(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        if isAvailable(PlexFamily.sans) {
            return .custom(PlexFamily.sans, size: size).weight(weight)
        }
        return .system(size: size, weight: weight, design: .default)
    }

    /// JetBrains Mono-ish mono/data/terminal/badges (DESIGN.md typography).
    /// TODO(086): ships the IBM Plex Mono binaries per Resources/Fonts/README.md.
    /// Falls back to a monospaced system font until then.
    public static func plexMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        if isAvailable(PlexFamily.mono) {
            return .custom(PlexFamily.mono, size: size).weight(weight)
        }
        return .system(size: size, weight: weight, design: .monospaced)
    }
}
