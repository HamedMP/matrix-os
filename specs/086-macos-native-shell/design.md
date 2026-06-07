# Design System: Matrix OS macOS App — "OPERATOR"

**Artifact type**: UI design spec (not code). SwiftUI-translatable tokens + per-component guidance.
**Feature**: [086-macos-native-shell](./spec.md) · **Companion**: [plan.md](./plan.md)

## 1. Concept & Point of View

**OPERATOR** is a precision control surface for someone running many AI agents in parallel — a flight-deck for zellij sessions. The aesthetic fuses **terminal/CRT-phosphor heritage** with **aerospace instrument-panel restraint**: a near-black machined canvas where information is dense but calm, and the only saturated color in the room is *living signal* — a phosphor pulse that means "an agent is doing something right now."

This is deliberately **not** the generic SaaS kanban look (no white cards on grey, no purple gradients, no Inter). It is dark-first to sit beside the Matrix shell, monospace-led to honor the terminal, and quiet until something is alive.

**The one unforgettable thing**: live cards *breathe*. A running session emits a slow phosphor glow at the card's left edge — the board reads at a glance like a rack of blinking machines.

## 2. Color System (dark-first)

Semantic tokens (asset-catalog colors; values are P3-friendly hex). Light theme is a later phase; tokens are named, not hard-coded.

### Canvas & surfaces
| Token | Hex | Use |
|---|---|---|
| `canvas.void` | `#0A0B0D` | window background (machined near-black) |
| `canvas.grain` | overlay | 4% monochrome noise + faint 1px grid at 8% on void |
| `surface.rail` | `#101216` | column rails / sidebar |
| `surface.card` | `#15171C` | card body |
| `surface.cardRaised` | `#1B1E24` | hovered/dragging card |
| `surface.terminal` | `#0C0D10` | terminal panel (deeper than cards for "into the machine" depth) |
| `hairline` | `#000000 @ 60%` + `#FFFFFF @ 6%` | dual-tone 1px borders (dark line + top highlight = engraved edge) |

### Ink (text)
| Token | Hex | Use |
|---|---|---|
| `ink.primary` | `#E8EAED` | titles, terminal text |
| `ink.secondary` | `#9BA1AC` | metadata |
| `ink.tertiary` | `#5C636E` | timestamps, hints |
| `ink.disabled` | `#3A3F47` | — |

### Signal (the only saturated colors — reserved for state)
| Token | Hex | Meaning |
|---|---|---|
| `signal.live` | `#9EF01A` | **phosphor lime** — running / streaming (the breathing glow) |
| `signal.waiting` | `#FFB020` | amber — waiting on input/approval |
| `signal.blocked` | `#FF5C5C` | coral — blocked/error |
| `signal.done` | `#43C59E` | teal — complete |
| `signal.idle` | `#5C636E` | grey — todo/exited (no color = no life) |
| `signal.glow.live` | `signal.live @ 22%` radial | the edge bloom on active cards |

**Rule**: saturated signal color appears ONLY on status badges, the live edge-glow, and the active panel-switcher segment. Chrome, text, and structure stay monochrome. This keeps a 200-card board readable and makes one running agent pop instantly.

## 3. Typography

Bundle two characterful, licensable families (avoid SF/Inter/Roboto/Arial):

- **Display / chrome / titles** → **IBM Plex Sans** (humanist, engineered character; weights 400/500/600). Used for column headers, card titles, buttons.
- **Mono / data / terminal / badges** → **IBM Plex Mono** (or Berkeley Mono if licensed) for terminal, session names, status labels, counts, timestamps. The mono is the "voice of the machine."

Cohesive single-family option keeps the OS feel tight (Plex Sans + Plex Mono are designed to pair).

### Scale (pt; SwiftUI `Font.custom(...).weight`)
| Role | Family | Size / Weight / Tracking |
|---|---|---|
| Column header | Plex Mono 600 | 11 / uppercase / +0.12em |
| Card title | Plex Sans 500 | 14 / -0.01em |
| Card meta | Plex Mono 400 | 11 / +0.02em |
| Status badge | Plex Mono 600 | 10 / uppercase / +0.08em |
| Terminal | Plex Mono 400 | 12.5 / line-height 1.45 |
| Section/empty headline | Plex Sans 600 | 20 / -0.02em |
| Body/empty copy | Plex Sans 400 | 13 |

## 4. Spacing, Radius, Elevation

- **Grid**: 8pt base with 4pt sub-step. Tokens: `space.1=4, .2=8, .3=12, .4=16, .5=24, .6=32, .7=48`.
- **Radius**: `radius.card=10`, `radius.badge=5`, `radius.panel=14`, `radius.control=8`. Engraved, not pill-soft.
- **Elevation** = macOS material + shadow, not flat fills:
  - Resting card: `surface.card` + 1px engraved hairline, no shadow.
  - Hover card: lift to `surface.cardRaised`, `shadow(y:2, blur:10, #000@35%)`.
  - Dragging card: `.regularMaterial` ghost + `shadow(y:8, blur:28, #000@50%)`, scale 1.03.
  - Floating chrome (panel switcher, popovers, command bar): SwiftUI **`.ultraThinMaterial`** with vibrancy so the void/grain shows through — this is where the macOS-native feel lives.
  - Terminal panel: inset/recessed (inner top shadow) to read as "below" the card surface.

## 5. Motion (instrument-crisp, never bouncy-toy)

Timings (SwiftUI `Animation`):
| Interaction | Curve | Duration |
|---|---|---|
| Hover/tint | `.easeOut` | 120 ms |
| Panel toggle (term↔shell↔app) | `.spring(response:0.34, damping:0.86)` | ~340 ms |
| Card drag pickup/drop | `.spring(response:0.30, damping:0.80)` | — |
| Column reflow on drop | `.spring(response:0.40, damping:0.90)` | — |
| Card enter (new) | fade+rise 8pt, `.easeOut` | 180 ms, staggered 24 ms |
| Live edge-glow breathe | `.easeInOut` autoreverse | 2.4 s loop |
| Status change flash | `.easeOut` | 200 ms one-shot |

**Live breathe**: `signal.glow.live` opacity 0.12↔0.26 on a 2.4s autoreversing loop, applied as a left-edge radial; pauses when the card is offscreen (ties to the suspension/perf model — no animation cost for unsuspended-but-hidden cards).

**Panel switch uses `matchedGeometryEffect`** so the card frame morphs between Terminal/Shell/App with **no layout shift** (ux-guide rule): the panel content cross-fades inside a stable frame.

## 6. Per-Component Specs

### 6.1 Column (lifecycle lane)
- Header row: uppercase mono label + live count chip (`signal` dot if any card in column is live) + `+` add. Sticky on scroll.
- Body: `LazyVStack` for view recycling (perf: 200+ cards). 8pt gutters, `space.3` between cards.
- Subtle vertical hairline between columns; column background `surface.rail` a hair lighter than void.
- Drop target: when dragging, the target column's rail brightens 4% and shows an `signal.idle` insertion bar at the drop index (animated).
- Columns: `TODO · RUNNING · WAITING · BLOCKED · COMPLETE` (maps to task `status`). Order/priority within column via `order`.

### 6.2 Card
- Layout: left **signal edge** (3pt bar, color = status; glows if live) · title (Plex Sans 14) · meta row (mono: session name, tab count, worktree/branch if `linkedWorktreeId`, relative time).
- A card is a value-type SwiftUI view; mutations come diffable from workspace events — never rebuild the whole list.
- Footers (contextual, Conductor-style): live agent activity ticker (last line of session output, dimmed mono, truncated), PR/preview chips from `previewIds`.
- Hover: raise + reveal quick actions (open, new tab, archive) as a vibrancy overlay — **no layout shift** (actions overlay, don't push).
- Selected/open card: persistent `ink.primary` hairline + faint signal tint; remembered across reloads (spatial memory).

### 6.3 Status / live-session badges
- Badge = mono 10pt uppercase, `radius.badge`, on a 10%-tint of its signal color with a solid signal dot.
- States: `IDLE`(grey) · `RUNNING`(lime, dot pulses) · `WAITING`(amber) · `BLOCKED`(coral) · `COMPLETE`(teal) · `EXITED`(grey, hollow dot).
- **Live dot** = breathing `signal.live`; **exited** = hollow ring (the machine is off). This dot is the board's heartbeat.

### 6.4 Terminal panel
- `surface.terminal` (deeper than card), recessed inner shadow, `radius.panel`.
- SwiftTerm view; Plex Mono 12.5 / 1.45; phosphor selection tint (`signal.live @ 18%`); cursor is a solid block that dims (not blinks harshly) when unfocused.
- Top strip: zellij **tabs** (mono, underline-active in signal color), session name, status badge, detach/terminate. New-tab `+` → `createTab`.
- Scroll: momentum; a faint top fade where scrollback meets the live tail; a "● LIVE" affixed marker (lime) when pinned to bottom, turns grey + "↓ N new" when scrolled up.
- Connection states inline & calm: `reconnecting…` (amber, animated ellipsis), `session exited` (grey, with re-create/archive), never a raw error string.

### 6.5 Panel switcher (Terminal · Shell · App)
- Segmented control in `.ultraThinMaterial`, lives in the card/detail header. Active segment carries a thin signal underline + `ink.primary`; inactive `ink.tertiary`.
- **Toggle consistency**: clicking the active segment is a no-op highlight; switching morphs via `matchedGeometryEffect` (no resize). App mode adds a small app-icon affordance to pick which Matrix app.
- Light-dismiss for any popover it spawns; `Esc` closes; same gesture re-closes what it opened.

### 6.6 Empty states (onboarding-as-empty-state)
- **No VPS**: centered — engraved Matrix glyph, headline "No Matrix computer yet" (Plex Sans 20), one line of copy, primary CTA "Create your Matrix OS" → platform flow. Calm, not an error.
- **Empty column**: ghosted dashed insertion zone + "Drop a task here or ⌘N".
- **Board loading**: skeleton cards in `surface.card` with a single sweeping `signal.idle` shimmer (one orchestrated load, staggered 24ms), not per-card spinners.
- **Disconnected**: top inset bar `reconnecting to <handle>…` in amber vibrancy; board goes read-only with a faint desaturation, last-known cards still visible (view-only, never persisted).

## 7. macOS-native details that sell it
- True window vibrancy: titlebar-transparent, content under a unified toolbar; the grain/grid void shows faintly through floating chrome.
- `NSVisualEffectView`/SwiftUI `Material` for all transient surfaces; respect Reduce Transparency & Reduce Motion (breathe → static glow; springs → cross-fade).
- Full keyboard model: `⌘N` new card, `⌘[`/`⌘]` move card across columns, `⌘T` new terminal tab, `⌘1/2/3` panel switch, `Esc` light-dismiss, arrow nav between cards. Operator-grade.
- Custom I-beam stays in terminal; elsewhere a crisp arrow; drag uses a grabbing cursor.

## 8. Accessibility & honoring ux-guide
- Contrast: ink.primary on surfaces ≥ 7:1; signal colors paired with shape (dot fill vs ring) so state never relies on color alone.
- ux-guide compliance: **toggle consistency** (§6.5), **no layout shift** (overlays + matchedGeometry), **spatial memory** (selected/positions persist across reload), **progressive disclosure** (quick actions on hover), **empty-states-as-onboarding** (§6.6), **light dismiss + Esc** everywhere.

## 9. Token quick-reference (for implementation)
Define as an asset catalog + a `DesignTokens.swift` enum: `Color.canvasVoid`, `…surfaceCard`, `…signalLive`, etc.; `Font.plexSans(_:weight:)`, `Font.plexMono(_:weight:)`; `Spacing.x`, `Radius.x`, `Motion.panelSwitch`. All component code references tokens only — no inline hex/sizes — so the OPERATOR look stays cohesive and themeable for the later light mode.
