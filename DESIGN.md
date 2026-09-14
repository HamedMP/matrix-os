---
version: "1.0.0"
name: "Matrix OS"
wordmark: "Matrix OS"
tagline: "Technology that understands you."
brandSource:
  kind: "figma"
  fileKey: "xPG2FeYRtC9owCKSVXCqWA"
  nodeId: "1:846"
  url: "https://www.figma.com/design/xPG2FeYRtC9owCKSVXCqWA/brand?node-id=1-846"
  capturedAt: "2026-08-30"

brand:
  teal: "#0E3422"
  coral: "#D06E53"
  gold: "#F1C379"
  green: "#BED77B"
  blue: "#C5D6E2"
  ink: "#1F2D1D"
  paper: "#FCFCF8"
  canvas: "#F4F7ED"

colorScales:
  green:
    50: "#F4F7ED"
    100: "#E4EDD4"
    200: "#CEE0AE"
    300: "#BED77B"
    400: "#9AC059"
    500: "#748E59"
    600: "#62783A"
    700: "#475926"
    800: "#2B3715"
    900: "#171F0A"
  teal:
    50: "#EEF7F2"
    100: "#C9E8D9"
    200: "#97D8B9"
    300: "#5EC996"
    400: "#34B275"
    500: "#288A5B"
    600: "#1B6541"
    700: "#13492F"
    800: "#0E3422"
    900: "#061810"
  coral:
    50: "#FAEEEB"
    100: "#F2D6CF"
    200: "#E6B5A8"
    300: "#DA9481"
    400: "#D06E53"
    500: "#BA5236"
    600: "#8F432D"
    700: "#6B3324"
    800: "#442118"
    900: "#25130E"
  gold:
    50: "#FCF5E8"
    100: "#FAEAD1"
    200: "#F6DAAC"
    300: "#F1C379"
    400: "#E0AA52"
    500: "#D2932D"
    600: "#A37429"
    700: "#775622"
    800: "#4D3919"
    900: "#251C0E"
  blue:
    50: "#EDF3F7"
    100: "#C5D6E2"
    200: "#9DBFD7"
    300: "#71A9D0"
    400: "#5CA0D1"
    500: "#3B85BA"
    600: "#306991"
    700: "#254D6A"
    800: "#193143"
    900: "#0F1B24"
  neutral:
    50: "#FFFFFF"
    100: "#F3F2F2"
    200: "#E1E0E0"
    300: "#C8C6C6"
    400: "#A8A4A4"
    500: "#827D7D"
    600: "#635F5F"
    700: "#413E3E"
    800: "#242323"
    900: "#0D0C0C"

semanticColors:
  background: "#F4F7ED"
  foreground: "#1F2D1D"
  surface: "#FCFCF8"
  surfaceElevated: "#FFFFFF"
  border: "#E0E1CA"
  primary: "#0E3422"
  primaryForeground: "#FCFCF8"
  accent: "#D06E53"
  focus: "#F1C379"
  success: "#288A5B"
  warning: "#D2932D"
  danger: "#BA5236"
  info: "#3B85BA"
  muted: "#F3F2F2"
  mutedForeground: "#635F5F"

typography:
  display:
    fontFamily: "Bricolage Grotesque"
    fontSize: "72px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  h1:
    fontFamily: "Bricolage Grotesque"
    fontSize: "48px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  h2:
    fontFamily: "Bricolage Grotesque"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.005em"
  h3:
    fontFamily: "Bricolage Grotesque"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.25
  subtitle:
    fontFamily: "Bricolage Grotesque"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.4
  bodyLarge:
    fontFamily: "Geist"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Geist"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0.005em"
  bodySmall:
    fontFamily: "Geist"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0.01em"
  caption:
    fontFamily: "Geist"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.015em"
  label:
    fontFamily: "Geist"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "3px"
    textTransform: "uppercase"
  machine:
    fontFamily: "Geist Mono"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5

spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
  3xl: "64px"
  4xl: "96px"

rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "24px"
  full: "9999px"

shadows:
  xs: "0 1px 2px rgba(31, 45, 29, 0.05)"
  sm: "0 2px 8px rgba(31, 45, 29, 0.07)"
  md: "0 4px 24px rgba(31, 45, 29, 0.08)"
  lg: "0 12px 36px rgba(31, 45, 29, 0.12)"
  xl: "0 24px 64px rgba(31, 45, 29, 0.16)"
---

# Matrix OS brand and interface guidelines

This document is the repository contract for the Matrix OS identity. The
[approved Figma brand frame](https://www.figma.com/design/xPG2FeYRtC9owCKSVXCqWA/brand?node-id=1-846)
is the upstream visual source. This file translates that work into stable,
reviewable rules for product design and implementation.

If Figma and this document disagree, reconcile the difference in a dedicated
brand PR before changing product UI. Product code must consume the canonical
tokens rather than creating a third interpretation.

## Identity

### Product name and wordmark

- The product and wordmark are written **Matrix OS**.
- Never collapse the name to “MatrixOS”.
- Keep the capitalization shown in the approved lockup; do not force the
  wordmark to all caps or all lowercase.
- Repository names, package names, domains, and URL slugs may use `matrix-os`.

### Mark

The canonical mark is the dotted rabbit/growth glyph shown in the Figma brand
card and implemented by `rabbitMarkSvg()` in `@matrix-os/brand`.

- Primary app tile: Green `#BED77B` mark on Teal `#0E3422`.
- Monochrome use is allowed when the mark inherits the surrounding text color.
- Preserve the original proportions. Never redraw, stretch, rotate, outline,
  or add effects to the glyph.
- Use the mark without the wordmark where space is constrained; otherwise pair
  it with the title-case Matrix OS wordmark.

## Character

Matrix OS should feel capable, optimistic, tactile, and composed. It is a
powerful computer without the coldness or visual noise associated with typical
developer tooling.

1. **Expressive, not ornamental.** Use personality in type and color, not
   decoration without purpose.
2. **Calm, not empty.** Preserve focus with clear hierarchy and generous space.
3. **Organic, not rustic.** Rounded geometry and living colors should still
   feel precise.
4. **Technical, not intimidating.** Machine information is legible and direct.
5. **Bright, not childish.** Supporting colors are signals, not confetti.

## Color

### Core palette

| Name | Hex | Primary role |
| --- | --- | --- |
| Teal | `#0E3422` | Identity, primary actions, navigation, strong text |
| Coral | `#D06E53` | Attention, warmth, destructive emphasis |
| Gold | `#F1C379` | Focus, selected highlights, optimistic emphasis |
| Green | `#BED77B` | Brand mark, success, active and ready states |
| Blue | `#C5D6E2` | Informational and passive supporting surfaces |

Teal is the anchor. The other four colors create rhythm and communicate state.
Do not give every color equal weight in one view.

### Surfaces and text

- Default canvas: Green 50 `#F4F7ED`.
- Brand paper/card: `#FCFCF8`.
- Elevated neutral surface: Neutral 50 `#FFFFFF`.
- Primary ink: `#1F2D1D`.
- Default border: `#E0E1CA`.
- Muted text: Neutral 600 `#635F5F`.
- Default focus ring: Gold `#F1C379` with a visible offset.

### Accessibility

| Combination | Contrast | Guidance |
| --- | ---: | --- |
| Teal on paper | 13.32:1 | AAA for text and controls |
| Ink on paper | 14.07:1 | AAA for body text |
| Ink on Green | 9.09:1 | AAA for dark text on positive fills |
| Teal on Blue | 9.19:1 | AAA for informational surfaces |
| Coral on paper | 3.38:1 | Large text and non-text emphasis only |

Coral is not a default text color or a small-button text/background pair. Use
Teal for primary actions and reserve Coral for accents or pair it with a dark
foreground after checking the exact contrast.

## Typography

### Families

| Role | Family | Use |
| --- | --- | --- |
| Display and headings | Bricolage Grotesque | Wordmark, hero text, product headings |
| Body and UI | Geist | Navigation, controls, forms, prose, labels |
| Code and machine voice | Geist Mono | Terminal, commands, paths, IDs, technical state |

Bricolage Grotesque supplies the recognizable voice. Geist supplies quiet,
high-legibility interface copy. Geist Mono identifies content produced by or
addressed to the machine. Do not substitute another family per platform.

### Scale

| Style | Family | Size | Weight | Line height | Tracking |
| --- | --- | ---: | ---: | ---: | ---: |
| Display | Bricolage Grotesque | 72px | 800 | 110% | -2% |
| Heading 1 | Bricolage Grotesque | 48px | 700 | 115% | -1% |
| Heading 2 | Bricolage Grotesque | 36px | 600 | 120% | -0.5% |
| Heading 3 | Bricolage Grotesque | 28px | 500 | 125% | 0 |
| Subtitle | Bricolage Grotesque | 22px | 500 | 140% | 0 |
| Body large | Geist | 18px | 400 | 155% | 0 |
| Body | Geist | 16px | 400 | 160% | 0.5% |
| Body small | Geist | 14px | 400 | 160% | 1% |
| Caption | Geist | 12px | 400 | 150% | 1.5% |
| Overline / label | Geist | 11px | 700 | 130% | 3px |
| Machine | Geist Mono | 14px | 400 | 150% | 0 |

Scale display styles down fluidly on compact screens; do not reduce body text
below 14px or touch targets below 44px. Labels may use uppercase only when they
remain short.

## Layout and shape

- Use a 4px spacing grid. Prefer 8, 16, 24, 32, 48, and 64px intervals.
- Default component radius is 12px; brand cards use 16px; swatches and compact
  controls use 8px; pills use the full radius.
- Use whitespace before dividers, and dividers before additional containers.
- Keep onboarding and other focused tasks within a narrow, single-purpose
  composition. Do not borrow full Settings chrome for one decision.
- Desktop, web, and mobile may arrange content differently, but hierarchy,
  tokens, copy, and interaction outcomes remain equivalent.

## Components

### Buttons

- Primary: Teal background, paper foreground, 12px radius.
- Secondary: paper or transparent background, Teal text, subtle border.
- Quiet: transparent with no persistent container.
- Destructive: use a Coral-scale semantic color only for destructive actions.
- Focus: Gold ring, never color-only state indication.
- Keep one dominant primary action per region.

### Cards and panels

- Default card: paper surface, subtle border, 16px radius, small or medium
  ink-tinted shadow.
- Nested content should usually use spacing or Green/Blue 50 surfaces rather
  than another elevated card.
- Glass and blur are reserved for transient overlays where seeing the spatial
  context underneath helps the user.

### Inputs

- Use Geist at 14–16px.
- Use paper surfaces, an 8–12px radius, and a clearly visible Gold focus ring.
- Labels remain visible; placeholders explain format, never replace labels.
- Errors use text and an icon in addition to color.

### Status and semantic color

- Green/Teal: ready, connected, successful.
- Gold: pending, selected, needs attention without failure.
- Coral: failed, destructive, urgent.
- Blue: informational, syncing, neutral progress.
- Never encode state by color alone.

### Window controls

Matrix-owned window controls use Coral, Gold, and Green. They should not copy
platform traffic-light values when Matrix chrome is being rendered. Native
system chrome remains native.

## Motion

- Use 120–240ms transitions for local interface changes.
- Prefer opacity and short translations; avoid gratuitous scale and parallax.
- Loading animation should communicate progress without preventing work.
- Respect reduced-motion settings on every platform.

## Cross-platform implementation status

This document defines the target brand contract. Cross-platform implementation
parity is tracked separately across web, Electron desktop, native desktop, and
mobile. Until that work lands:

- Figma and this document outrank existing product CSS or platform-local tokens.
- `@matrix-os/brand` is the intended shared implementation boundary.
- Existing legacy values may remain temporarily, but new UI must not copy them.
- A parity PR should migrate implementations and tests without redefining the
  brand in platform-specific terms.

## Review checklist

- [ ] Uses Matrix OS capitalization and the canonical mark.
- [ ] Uses Bricolage Grotesque, Geist, and Geist Mono in their defined roles.
- [ ] Uses semantic tokens backed by the approved palette rather than ad-hoc hex.
- [ ] Meets WCAG AA for text, controls, focus, and non-text state indicators.
- [ ] Preserves equivalent hierarchy and outcomes across form factors.
- [ ] Keeps decoration subordinate to content and action.
- [ ] Includes reduced-motion and keyboard/focus behavior.
