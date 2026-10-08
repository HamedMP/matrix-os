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
productSource:
  kind: "figma"
  fileKey: "DaaEbN79NQHN4HXa5Upgg5"
  url: "https://www.figma.com/design/DaaEbN79NQHN4HXa5Upgg5/Mobile-app"
  capturedAt: "2026-10-08"

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
  background: "#FFFEFC"
  foreground: "#242323"
  surface: "#FAF9F7"
  surfaceElevated: "#FFFEFC"
  border: "#F3F2F2"
  borderStrong: "#C8C6C6"
  primary: "#171717"
  primaryForeground: "#FAFAFA"
  accent: "#D06E53"
  focus: "#F1C379"
  success: "#288A5B"
  warning: "#E0AA52"
  danger: "#BA5236"
  info: "#3B85BA"
  muted: "#F3F2F2"
  mutedForeground: "#635F5F"
  tertiaryForeground: "#8A8686"
  scrim: "rgba(0, 0, 0, 0.3)"

# Brand and marketing scale, plus the machine style used on every surface.
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

# Product interface scale, including screen titles and headings.
interfaceTypography:
  fontFamily: "Geist"
  letterSpacing: "0"
  weights:
    regular: 400
    medium: 500
    semibold: 600
  scale:
    title:
      fontSize: "30px"
      lineHeight: "41px"
      fontWeights: [600]
    heading:
      fontSize: "24px"
      lineHeight: "34px"
      fontWeights: [600]
    subheading:
      fontSize: "18px"
      lineHeight: "25px"
      fontWeights: [600]
    headline:
      fontSize: "17px"
      lineHeight: "25px"
      fontWeights: [400, 600]
    body:
      fontSize: "16px"
      lineHeight: "22px"
      fontWeights: [400, 500, 600]
    callout:
      fontSize: "15px"
      lineHeight: "22px"
      fontWeights: [400, 600]
    label:
      fontSize: "14px"
      lineHeight: "20px"
      fontWeights: [400, 500]
    caption:
      fontSize: "13px"
      lineHeight: "18px"
      fontWeights: [400, 500]
    footnote:
      fontSize: "12px"
      lineHeight: "17px"
      fontWeights: [400, 500]
    micro:
      fontSize: "11px"
      lineHeight: "15px"
      fontWeights: [500, 600]
  sectionLabel:
    fontSize: "12px"
    lineHeight: "17px"
    fontWeight: 500
    letterSpacing: "0"
    textTransform: "none"

# Page-level and marketing spacing scale.
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
  3xl: "64px"
  4xl: "96px"

# Product interface spacing steps.
interfaceSpacing:
  2: "2px"
  4: "4px"
  6: "6px"
  8: "8px"
  10: "10px"
  12: "12px"
  14: "14px"
  16: "16px"
  18: "18px"
  20: "20px"
  24: "24px"
  screenMargin: "20px"

# Brand and page-level radius scale.
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "24px"
  full: "9999px"

# Product interface radii.
interfaceRounded:
  6: "6px"
  8: "8px"
  10: "10px"
  12: "12px"
  14: "14px"
  16: "16px"
  18: "18px"
  20: "20px"
  22: "22px"
  24: "24px"
  full: "9999px"

borderWidths:
  hairline: "1px"
  emphasis: "1.5px"

# Shadow scale for window chrome and marketing surfaces.
shadows:
  xs: "0 1px 2px rgba(31, 45, 29, 0.05)"
  sm: "0 2px 8px rgba(31, 45, 29, 0.07)"
  md: "0 4px 24px rgba(31, 45, 29, 0.08)"
  lg: "0 12px 36px rgba(31, 45, 29, 0.12)"
  xl: "0 24px 64px rgba(31, 45, 29, 0.16)"

# Product interface shadows: only the composer and the side panel cast one.
interfaceShadows:
  composer: "0 4px 16px rgba(0, 0, 0, 0.06)"
  panel: "8px 0 24px rgba(0, 0, 0, 0.12)"

components:
  button:
    height: "44px"
    heightLarge: "48px"
    rounded: "10px"
    fontFamily: "Geist"
    fontSize: "14px"
    lineHeight: "20px"
    fontWeight: 500
    shadow: "none"
    filled:
      background: "#171717"
      foreground: "#FAFAFA"
    outline:
      background: "#FFFFFF"
      border: "#E5E5E5"
      borderWidth: "1px"
      foreground: "#0A0A0A"
    secondary:
      background: "#F5F5F5"
      foreground: "#171717"
    text:
      foreground: "#0A0A0A"
  chip:
    rounded: "9999px"
    selected:
      background: "#0D0D0D"
      foreground: "#FFFFFF"
    unselected:
      background: "#F2F2F0"
      foreground: "#242323"
---

# Matrix OS brand and interface guidelines

This document is the repository contract for the Matrix OS identity. The
[approved Figma brand frame](https://www.figma.com/design/xPG2FeYRtC9owCKSVXCqWA/brand?node-id=1-846)
is the upstream visual source for the identity: the mark, wordmark, palette,
and brand type. The
[product design file](https://www.figma.com/design/DaaEbN79NQHN4HXa5Upgg5/Mobile-app)
is the upstream visual source for the product interface: surfaces, text,
controls, type scale, shape, and spacing. This file translates that work into
stable, reviewable rules for product design and implementation.

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
| Teal | `#0E3422` | Identity, the mark's app tile, brand and marketing surfaces |
| Coral | `#D06E53` | Attention, warmth, destructive emphasis |
| Gold | `#F1C379` | Focus, waiting and needs-attention states, optimistic emphasis |
| Green | `#BED77B` | Brand mark, success, active and ready states |
| Blue | `#C5D6E2` | Informational and passive supporting surfaces |

Teal is the anchor. The other four colors create rhythm and communicate state.
Do not give every color equal weight in one view. In the product interface the
palette carries identity and state; surfaces, text, and buttons use the neutral
values below.

### Surfaces and text

- Default canvas: `#FFFEFC`. Sheets, the side panel, the composer, and the tab
  bar share it.
- Fill for fields, cards, and tiles: `#FAF9F7`.
- Primary text: Neutral 800 `#242323`.
- Secondary text: Neutral 600 `#635F5F`.
- Tertiary text for placeholders, section labels, and times: `#8A8686`.
- Default border: Neutral 100 `#F3F2F2`. Screens that draw outlines may use the
  stronger Neutral 300 `#C8C6C6`.
- Scrim behind sheets, side panels, and alerts: `rgba(0, 0, 0, 0.3)`.
- Default focus ring: Gold `#F1C379` with a visible offset.

Brand and marketing surfaces such as the brand card use brand paper `#FCFCF8`,
brand canvas Green 50 `#F4F7ED`, and brand ink `#1F2D1D`.

These are light values. Until dark designs exist, dark mode mirrors each role
from the neutral ramp: Neutral 900 canvas, Neutral 800 fills, Neutral 100
primary text, Neutral 400 secondary text, Neutral 500 tertiary text, and
Neutral 700 borders.

### Accessibility

| Combination | Contrast | Guidance |
| --- | ---: | --- |
| Teal on paper | 13.32:1 | AAA for text and controls |
| Ink on paper | 14.07:1 | AAA for body text |
| Ink on Green | 9.09:1 | AAA for dark text on positive fills |
| Teal on Blue | 9.19:1 | AAA for informational surfaces |
| Coral on paper | 3.38:1 | Large text and non-text emphasis only |
| Primary text on canvas | 15.55:1 | AAA for body text |
| Secondary text on canvas | 6.25:1 | AA for supporting text |
| Tertiary text on canvas | 3.57:1 | Below AA for small text; placeholders, section labels, and times only |
| Coral 500 on canvas | 4.79:1 | AA for destructive text |
| Filled button label on fill | 17.18:1 | AAA for controls |

Coral `#D06E53` is not a default text color or a small-button text/background
pair. Reserve it for accents or pair it with a dark foreground after checking
the exact contrast. Destructive text uses Coral 500 `#BA5236`.

## Typography

### Families

| Role | Family | Use |
| --- | --- | --- |
| Display and marketing headings | Bricolage Grotesque | Wordmark, hero text, display and marketing headings |
| Product interface and body | Geist | Screen titles, headings, navigation, controls, forms, prose, labels |
| Code and machine voice | Geist Mono | Terminal, commands, paths, IDs, technical state |

Bricolage Grotesque supplies the recognizable voice of the wordmark and of
display and marketing headings. Geist sets all product interface text,
including screen titles and headings, as quiet, high-legibility copy. Geist
Mono identifies content produced by or addressed to the machine. Do not
substitute another family per platform.

### Display and marketing scale

Use this scale for the wordmark, display text, and marketing pages.

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

### Product interface scale

Use this scale for all product interface text, including screen titles and
headings. Every style is Geist with no letter-spacing, in Regular 400, Medium
500, or SemiBold 600.

| Style | Size | Line height | Weights | Use |
| --- | ---: | ---: | --- | --- |
| Title | 30px | 41px | 600 | Tab-level screen titles |
| Heading | 24px | 34px | 600 | Greetings, panel titles, page headings |
| Subheading | 18px | 25px | 600 | Names in sheet headers |
| Headline | 17px | 25px | 400, 600 | Sheet and alert titles, text field values |
| Body | 16px | 22px | 400, 500, 600 | Top bar titles, row titles, composer and menu text |
| Callout | 15px | 22px | 400, 600 | Message text, search fields, card and banner titles |
| Label | 14px | 20px | 400, 500 | Button labels, row values, helper text |
| Caption | 13px | 18px | 400, 500 | Chip labels, second lines, status text |
| Footnote | 12px | 17px | 400, 500 | Section labels, times, subtitles |
| Micro | 11px | 15px | 500, 600 | Tab labels and badges |

Section labels are 12px Medium, typed in capitals rather than transformed, with
no tracking. Machine text uses the Geist Mono machine style on every surface.

## Layout and shape

- The product interface uses the spacing steps 2, 4, 6, 8, 10, 12, 14, 16, 18,
  20, and 24px. Screen and sheet margins are 20px. Page-level and marketing
  layout uses the named scale: 4, 8, 16, 24, 32, 48, 64, and 96px.
- Product interface radii by role: 6px tags; 8px label badges and the active
  tab; 10px buttons and compact controls; 12px icon tiles and filled rows; 14px
  fields and cards; 16px approval cards and brand cards; 18px message bubbles;
  20px alerts; 22px the composer; 24px sheets and banners; full radius for
  chips, round buttons, and count badges. Brand and marketing surfaces use the
  named radius scale.
- Use whitespace before dividers, and dividers before additional containers.
- Keep onboarding and other focused tasks within a narrow, single-purpose
  composition. Do not borrow full Settings chrome for one decision.
- Desktop, web, and mobile may arrange content differently, but hierarchy,
  tokens, copy, and interaction outcomes remain equivalent.

## Components

### Buttons

- All styles: 10px radius, 44px high, Geist Medium 14px/20px label, no shadow.
  The one dominant full-width action in a view is 48px high.
- Filled: `#171717` background, `#FAFAFA` label.
- Outline: white background, 1px `#E5E5E5` border, `#0A0A0A` label.
- Secondary: `#F5F5F5` background, `#171717` label, optional leading icon.
- Text-only: no container, `#0A0A0A` label.
- Destructive: there is no destructive fill. Destructive actions are text in
  Coral 500 `#BA5236`.
- Focus: Gold ring, never color-only state indication.
- Keep one dominant primary action per region.

### Chips

- Full radius.
- Selected: `#0D0D0D` background, white label.
- Unselected: `#F2F2F0` background, primary-text label.

### Cards and panels

- Default card: `#FAF9F7` fill, or the canvas with a 1px default border; 14px
  radius; no shadow.
- Nested content should usually use spacing or the `#FAF9F7` fill rather than
  another bordered card.
- Product interface elements are flat. Only the composer
  (`0 4px 16px rgba(0, 0, 0, 0.06)`) and the side panel
  (`8px 0 24px rgba(0, 0, 0, 0.12)`) cast a shadow. The named shadow scale
  applies to window chrome and marketing surfaces.
- Sheets, side panels, and alerts sit on the scrim. Do not use glass or blur.

### Inputs

- Use Geist at 15–17px.
- Use the `#FAF9F7` fill and a 14px radius. A focused text field draws a 1.5px
  primary-text border.
- Labels remain visible; placeholders explain format, never replace labels.
- Errors use text and an icon in addition to color.

### Status and semantic color

- Green/Teal: active, connected, done. Status indicators use Teal 500
  `#288A5B`.
- Gold: waiting, needs attention without failure. Status indicators use Gold
  400 `#E0AA52`.
- Coral: failed, destructive, urgent. Destructive text uses Coral 500
  `#BA5236`.
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
- [ ] Uses the semantic tokens defined here rather than ad-hoc hex.
- [ ] Meets WCAG AA for text, controls, focus, and non-text state indicators.
- [ ] Preserves equivalent hierarchy and outcomes across form factors.
- [ ] Keeps decoration subordinate to content and action.
- [ ] Includes reduced-motion and keyboard/focus behavior.
