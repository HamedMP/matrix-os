# Desktop Coding-Agent Experience — Design Audit

**Date**: 2026-08-03 · **Branch reviewed**: `origin/desktop-files-finder` @ `5973a3b02` (PRs #1097–#1108)
**Method**: built the Electron app, ran the Playwright `_electron` e2e suite against the stub gateway
(`tests/e2e/desktop/operator.e2e.test.ts`, 34 screenshots at 2560×1640, 1280×720, and 820×720),
plus a full read of the renderer styling architecture (`desktop/src/renderer/src/`).
**Benchmark**: T3 Code as a quality bar. Matrix identity (forest + cream, calm chrome) is preserved.

---

## 1. The 10 highest-impact problems, by severity

### 1. The chat hero surface loses to the inspector at default width
At 1280×720 — a very common window size — the inspector takes 34% and its chrome breaks:
the thread status pill is clipped under the collapse toggle, "New chat" wraps to two lines,
and all five inspector tabs truncate to `C…  T…  P…  A…`. The conversation — the product's hero —
is squeezed between a 240px rail and a broken inspector. First impression: broken, not premium.
*Evidence: [annotated 05](assets/audit-2026-08-03/05-project-chats-composer.png) callouts 1–3.*

### 2. No app-wide zoom (user-requested, accessibility gap)
There is no way to zoom the UI — menus, text, terminals. Every comparable desktop app
(VS Code, Slack, T3 Code, browsers) supports Cmd+= / Cmd+- / Cmd+0. For a remote-first
product used on varied displays this is a baseline accessibility and comfort feature.
*Design in §4.7 — planned as part of this work.*

### 3. System events render as message-sized cards and dominate the transcript
"Thread created", "Terminal bound", "Thread completed" render as large white cards with
timestamps — visually louder than the assistant's actual answer ("Done – all tests pass"
is small plain text between them). The information hierarchy is inverted: chrome > content.
*Evidence: [annotated 05](assets/audit-2026-08-03/05-project-chats-composer.png) callout 4.*

### 4. Responsive behavior at ~820px stacks instead of reflowing
At 820px the sidebar keeps its full 240px (29% of the window), and the inspector stacks
*below* the conversation, so both halves are half-height and cramped; the follow-up hint
bar is clipped mid-sentence; tab labels truncate further (`Chan…`, `Termi…`).
Nothing collapses, overlays, or reprioritizes. *Evidence: [annotated 04e](assets/audit-2026-08-03/04e-chats-changes-inspector-narrow.png).*

### 5. Token drift: four undefined CSS variables and an unwired type scale
`--bg-primary`, `--bg-secondary`, `--bg-elevated`, `--bg-tertiary` are used in 10+ places
(`AgentConversationInspector`, `RuntimeComputerMenu`, `ProjectChatsView`, …) but defined
nowhere — backgrounds silently fall back to transparent/inherited, a half-finished rename
of the `--bg-app/surface/raised/sunken` scale. Meanwhile `@theme inline` maps colors/radii/fonts
but **not** the type scale, so `text-sm`/`text-xs` resolve to Tailwind rem defaults instead of
the 11–13px token scale, and `text-md` (8 uses) matches nothing at all. Result: invisible
backgrounds, inconsistent density, dead classes.

### 6. Competing component idioms for the same patterns
Four+ hand-rolled segmented controls with different recipes (`ProjectViewSwitch`, files
`ViewSwitcher`, git `TabButton`, inspector tablist); two hover systems (JS `onMouseEnter`
style mutation vs Tailwind `hover:` — sometimes in one component); two chat bubble
implementations (`features/threads/ThreadView` duplicating `features/chat/elements` with
different geometry, plus a dead `prose-invert` class — no typography plugin installed).
This is the main source of "almost but not quite the same" polish debt.

### 7. Inspector tab bar is unusable below ~1400px
The `repeat(N, minmax(0,1fr))` grid truncates every label as soon as the inspector is
narrower than ~360px — which is its *default* width. Icon-first tabs with count badges
and tooltips would stay legible at any width. *Evidence: annotated 05 callout 3.*

### 8. Git DAG is sparse, low-contrast, and theme-blind
Monochrome gray lanes, low-contrast ref pills, misaligned sha/author/time meta, and content
hugging the top-left of a vast empty canvas. `LANE_COLORS` is 11 hardcoded Tailwind hexes —
in dark themes the lanes are not re-themed. *Evidence: [annotated 03b](assets/audit-2026-08-03/03b-git-dag.png).*

### 9. Terminal presentation fights the calm chrome
Task terminals and the Terminals workspace render a heavy black frame around the xterm
surface, with content unfitted (tiny text in a corner of a large blank area). `TerminalView`
hardcodes `#0d1017`, ignoring the active theme. Against the light forest chrome this reads
as a foreign object, not part of one product. *Evidence: [annotated 06](assets/audit-2026-08-03/06-terminal-workspace.png).*

### 10. Flat spots: placeholder icons, inconsistent heroes, unverified blank states
Connect cards on the Chat hero show gray placeholder squares (missing icons); the Chat-tab
hero ("What should we build in Matrix OS?") and the project draft hero ("What should we work
on?") use different type treatments; the Home tab can render a totally blank canvas with no
empty state (seen in the stub run — the Apps tab at least shows "Retry sign-in").
*Evidence: [annotated 17](assets/audit-2026-08-03/17-chat-unified-rail.png), [annotated 01](assets/audit-2026-08-03/01-home.png).*

**Honorable mentions**: add-project dialog captured translucent mid-animation with Cancel
overlapping content ([annotated 05d](assets/audit-2026-08-03/05d-add-project.png) — verify open
animation); files list truncates `workspac…` with free space available and nests card-in-card
([annotated 05g](assets/audit-2026-08-03/05g-files-list.png)); "Refresh" is a filled pill in
Providers but plain text in Integrations/Plugins; scrollbar thumbs and dialog overlay use
light-palette hardcodes in both themes; task panel-strip icons are unlabeled.

---

## 2. Proposed visual-system direction

Keep the identity — forest `#434e3f` + cream, Instrument Sans, calm low-contrast chrome —
and tighten the system around it.

**Typography** — one scale, wired into Tailwind `@theme` so utilities and tokens can't drift:
11 / 12 / 13 / 14 / 16 / 20 / 28px. UI: Instrument Sans; code/path/meta: JetBrains Mono.
Body default 13px, section headers 20px semibold tracking-tight, page headlines 28px.
Meta text never below 11px. One hero recipe reused by Chat tab, project draft, and empty states.
**Accessibility fix**: `--text-tertiary #8a8576` on white is ~3.7:1 — fails AA for normal text.
Darken tertiary to ≈ `#73705f` (4.6:1) for text use; keep the lighter value for decorative glyphs only.

**Spacing** — 4px grid; three density tiers: rails (px-2/py-1.5), content (px-4/py-3),
heroes (py-16+). No ad-hoc fractional paddings outside the tiers.

**Color & layers** — complete the background scale and delete the drift:
`app → sunken → surface → raised → overlay`, plus interaction alphas
(`hover/active/selected`). Semantic hues stay as-is (they're good); status tokens keep
reusing them. Dark theme gets the same layer discipline (it mostly has it).

**Elevation** — keep the 3-shadow scale. Transient surfaces (menus, popovers, dialogs) get
overlay + shadow-3 + backdrop dim; persistent surfaces stay opaque with hairline borders,
no shadows (per the UX guide's material distinction).

**Radii** — tokens only: 6 (chips, small buttons), 8 (cards, inputs), 12 (panels, dialogs),
16 (composer, hero cards). Replace bare `rounded` and off-token `rounded-2xl` (24px).

**Icons** — Lucide only; 14px default, 12px inline/meta, 16px nav rows, 20–28px empty states,
34px file glyphs. Stroke consistent; no gray placeholder squares — every icon slot has a glyph
or an initial tile.

**Motion** — 120ms micro, 160ms small, add 240ms for panel collapse/resize; ease-out enter,
ease-in exit; `prefers-reduced-motion` honored (already in global CSS).

**Component states — one recipe**: rest → hover `var(--bg-hover)` → active `var(--bg-active)`
→ selected `var(--bg-selected)` (+ medium-weight label) → focus-visible `var(--focus-ring)`
→ disabled 50% opacity, no hover. Implemented in CSS, not JS mouse handlers.

**Primitive library strategy (deliberate, not mixed)** — the app is Radix today and vendored
shadcn-style chat elements already exist. Proposal: formalize a `design/ui/` shadcn-style
component folder *on Radix* now (SegmentedControl, Tabs, Select, Menu, Tooltip), migrate the
four ad-hoc implementations onto it, and defer any Base UI adoption to a dedicated spike that
swaps the underlying primitive *behind the same component API* — the app never imports Radix
or Base UI directly outside `design/ui/`, so a later migration is one file per component.

---

## 3. Surface-by-surface redesign proposal

### 3.1 Project rail, navigation, Board/Chats, command palette
- Rail is fundamentally good (clear sections, attention badges). Keep anatomy; switch NavRow
  hover from JS to the CSS state recipe; collapse to a 56px icon rail below ~1100px.
- `ProjectViewSwitch` → shared `SegmentedControl` (same recipe as files ViewSwitcher).
- Command palette: solid `cmdk` base; polish group headings to the type scale, unify item
  hover/selected with the state recipe, add zoom-aware min widths.
- Home tab: guarantee a designed empty/offline state (icon + headline + description + CTA)
  instead of a blank canvas.

### 3.2 Draft chat / hero / chips / composer
- Already the strongest surface ([05a](assets/audit-2026-08-03/05a-draft-chat.png)). Unify the two hero
  recipes, replace suggestion-chip styling with the chip token set (radius 6→full is fine here,
  keep pill), hide the inspector entirely in draft state (it shows tools for a thread that
  doesn't exist), and keep type-to-start.
- Composer: `rounded-2xl` → `var(--radius-xl)`; remove dead `text-md`; keep provider/mode
  pickers but restyle to the shared Select primitive.

### 3.3 Active conversation
- Compact system events into single-line timeline rows (icon + text + time, 32px tall,
  no card) — assistant prose becomes the loudest element again.
- Fix the header: status pill never clipped (reserve space before the inspector toggle).
- Keep tool-run chips and "Worked for Xs" receipts — they're the right anatomy; align them
  to the type scale and state recipe.
- Keep the vendored `Conversation` scroller, redaction, approval cards — untouched.

### 3.4 Resizable inspector
- Icon-first tabs (14px glyph + count badge, tooltip with label+shortcut); labels only when
  the pane is wide enough. No truncation ever.
- Header: "Conversation tools" becomes an icon-only action row; "New chat" never wraps
  (fixed-height 28px button, `whitespace-nowrap`).
- Default open ≥1400px, default collapsed below; below ~900px the inspector becomes an
  overlay panel (slides over, light-dismiss + Escape) instead of squeezing the chat.
- Reduce card-in-card nesting inside Changes/Preview (one bordered level max).

### 3.5 Git commit DAG
- Re-theme lanes from tokens (derive from chart/status palette per theme, no hardcoded hex);
  raise ref-pill contrast (border + tinted bg at AA); column-align sha/author/time;
  row height 36px; add a designed empty state and a subtle horizon grid so the canvas
  doesn't read as void.

### 3.6 Providers & integrations settings
- Keep the two-pane layout and section kit — it works. Unify "Refresh" into one IconButton
  recipe; align provider row anatomy (glyph tile, name, status line, action right);
  consistent Connect/Disconnect button hierarchy (primary = Connect, subtle = Disconnect).

### 3.7 Add-project flows
- Keep the three-mode stepper. Verify/fix the dialog open animation (translucency + Cancel
  overlap seen mid-flight); dialog content uses `var(--bg-overlay)` solid + shadow-3; ModeCards
  adopt the shared selected-state recipe.

### 3.8 Plugins Hub
- Keep layout. Skills rows gain hover actions (view source, reveal in files) using the
  state recipe; consistent section headers with Settings (share the section kit header);
  MCP empty state gets the standard empty-state anatomy (it nearly has it).

### 3.9 Finder-style file browser
- Fix column sizing so `workspaces` never truncates with free space (name column flex,
  size/modified fixed); drop one container level (browser and preview are panes with a
  hairline divider, not two cards); grid tiles keep 96px columns; selection/hover per state
  recipe. Keep the excellent keyboard nav.

### 3.10 Responsive & keyboard/accessibility
- Breakpoints: ≥1400px full three-column; 1100–1400px icon rail; 900–1100px icon rail +
  collapsed inspector; <900px inspector overlays, composer stays bottom-anchored.
- Full keyboard pass: every panel passes the UX-guide checklist (toggle/light-dismiss/Escape,
  focus return, focus-visible rings). Zoom (below) is the headline a11y addition.

---

## 4. What should remain unchanged

- All store contracts, IPC channels, thread lifecycle, snapshots, live-event streams, and
  remote-execution semantics (PRs #1097–#1108 behavior).
- Approval and input-request cards and the bounded payload rendering — the safety boundary.
- Credential redaction at display time; transcripts stay off disk.
- The vendored chat anatomy (`Conversation` scroller, `PromptInput`, markdown pipeline).
- The 13-theme engine architecture, layout/tab/spatial persistence, keyboard shortcut map.
- The Matrix forest + cream identity, Instrument Sans / JetBrains Mono pairing.

## 4.7 App-wide zoom (user-requested feature)

**Design**: Cmd+= zoom in, Cmd+- zoom out, Cmd+0 reset (Ctrl equivalents on other platforms).
Range 50%–200% in 10% steps. Everything scales — menus, text, terminal, dialogs.

**Implementation**: main-process `webContents.setZoomFactor()` (Chromium-native, scales all
rendered content including xterm and canvas). Exposed through the existing validated IPC
bridge as a new `app:set-zoom`/`app:get-zoom` invoke channel (Zod-clamped), driven by the
renderer appearance store so the value persists per machine via the existing `state:set`
persistence and is applied at window creation. Discoverability: View-menu items
(Zoom In / Zoom Out / Actual Size with accelerators) + a stepper control with percentage
readout and Reset in Settings → Appearance, next to Mode/Theme. Transient toast shows the
current percentage on change. Terminal fit addon re-fits on zoom change.

---

## 5. Phased implementation plan

### Phase 0 — Quick wins (this review's implementation branch; low risk, high visible impact)
1. **Token repairs**: define/alias the four undefined bg vars onto the layer scale; wire the
   type scale into `@theme`; replace dead `text-md` (8 uses); fix `#eaeceA` typo.
2. **App zoom**: IPC channel + appearance-store persistence + shortcuts + Appearance stepper.
3. **Conversation chrome fixes**: unclipped status pill, no-wrap New chat, compact system-event
   timeline rows, icon-first inspector tabs with tooltips, inspector hidden in draft state.
4. **DAG polish**: token-based lane colors, higher-contrast ref pills, aligned meta columns.
5. **Files truncation fix** (name column flex) + de-nest one card level in Files workspace.
6. **Consistency passes**: one Refresh IconButton recipe; connect-card icons instead of gray
   squares; `rounded-2xl`→`--radius-xl` on composer; dark-aware scrollbar/overlay colors.
7. Regression tests: token-definition test (no undefined `var(--…)` referenced in renderer),
   zoom clamp/persist unit tests, updated e2e screenshot coverage for the changed surfaces.

### Phase 1 — Component system
`design/ui/` shadcn-style primitives on Radix: `SegmentedControl`, `Tabs`, `Select`, `Menu`,
`Tooltip`. Migrate the four segmented controls, inspector tablist, provider/mode pickers;
retire JS hover handlers; unify thread-rail row anatomy; single hero component.

### Phase 2 — Interaction changes
Responsive reflow (icon rail <1100px, overlay inspector <900px), collapsible-inspector
defaults per viewport, draft→thread transition motion, palette polish, follow-up queue
affordance, Base UI evaluation spike behind the `design/ui` API.

### Phase 3 — Larger bets
Chat-first layout exploration (T3-caliber single-column focus mode), transcript
virtualization, DAG interactions (checkout, context menu), preview pane upgrades.

**Validation per phase**: `bun run typecheck`, desktop vitest, the `_electron` e2e screenshot
suite re-run with new captures as PR evidence, and react-doctor on changed React files.
