---
status: active
---
# Default apps: one sculpted design family

Goal: apply the approved soft sculpted icon family to Matrix-owned core and bundled apps, with distinct semantic artwork and app colors. Align internal surfaces, typography, controls, spacing and touch targets with the gallery while retaining purpose-specific layouts and all existing workflows. Preview the real Electron Desktop client against the disposable gallery runtime.

No changes to user data, permissions, integrations, third-party logos, or intentionally retro apps. Existing customized icons must remain owned by the user. No production rollout or merge in this task.

## Implementation units

### U1 — Icon identity and shared rendering (root)
Goal: core and bundled apps resolve distinct sculpted icons across Electron Desktop, Web Desktop, Web Canvas and mobile where supported.
Files: home/system/icons/**; home/apps/games/**/matrix.json; shell/src/components/MissionControl.tsx; shell/src/lib/app-launch.ts; desktop/src/renderer/src/features/desktop-shell/SurfaceIcon.tsx; desktop/src/renderer/src/features/apps/app-icons.ts; related focused tests; this spec.
Approach: reuse approved semantic artwork already shipped; fix game manifests that point to the controller; produce missing icon assets and use image fallback without discarding custom icons. Preserve third-party branding.
Execution note: tests first for resolver and manifest behavior; visual inspection for artwork.
Patterns: existing icon resolver, asset inventory and first-party manifest conventions.
Test scenarios: correct app identity, all assets exist, safe icon slug validation, custom icon precedence, broken-image fallback.
Verification: focused tests pass; launcher has distinct icons in Electron Desktop and shared paths use the same asset family.

### U2 — Utility app interiors (worker)
Goal: polished shared app interiors, retaining distinct identity colors.
Files: home/apps/_shared/gallery-family.css; home/apps/notes/src/styles.css; home/apps/calculator/src/styles.css; home/apps/clock/src/styles.css; home/apps/expense-tracker/src/styles.css; home/apps/todo/src/styles.css; home/apps/task-manager/src/styles.css; home/apps/weather/src/styles.css; home/apps/whiteboard/src/styles.css. No manifests or icons.
Approach: improve typography, restrained surfaces, consistent toolbar and form treatment, cards, focus states, safe-area and narrow layouts. Inspect existing gallery family imports. Keep behavior and user-selected themes intact.
Execution note: CSS-only; preserve existing behavioral coverage, test-first if any behavior change proves necessary.
Patterns: home/apps/_shared/app-foundation.css and gallery-family.css.
Test scenarios: wide and narrow screens, dark theme, readable controls, keyboard focus, reduced motion.
Verification: utility builds succeed; no overflow or hidden primary actions at mobile widths.

### U3 — Game and monitor interiors (worker)
Goal: matching surfaces and controls around purpose-specific games and resource monitoring.
Files: home/apps/_shared/game-refresh.css; home/apps/games/src/**; home/apps/games/{2048,backgammon,chess,minesweeper,snake,solitaire,tetris}/src/styles.css; home/apps/resource-manager/src/styles.css. No manifests or icons or gallery-family.css.
Approach: improve game chrome, consistent typography, controls, neutral cards and app accent; retain board colors and contrast. Do not change game mechanics or data access.
Execution note: CSS-only; tests first if changing behavior.
Patterns: existing game-refresh.css and app-foundation.css.
Test scenarios: readable symbols in light/dark, touch-sized controls, mobile boards fit viewport, selected host themes respected.
Verification: builds succeed; existing game rules coverage retained.

### U4 — Electron preview and review (root, after U1–U3)
Goal: show actual Electron gallery and default app review, complete scoped checks, create reviewable PR layers and public documentation update in FinnaAI/matrix-os-site.
Files: spec evidence; targeted tests if needed; separate site docs repository.
Approach: build source Electron client, open disposable pr-2269 runtime; package requested icon/style changes into review branches without touching production. Record exact source and screenshots. Inspect runtime/app build integration before claiming hosted changes live.
Test scenarios: native gallery loads, source identity verified, app launcher uses artwork, utility and game build smoke, no data changes.
Verification: Electron screenshot evidence and PR links; clearly distinguish local changes from hosted deployment.

## Parallel safety
U2 and U3 have disjoint file ownership; root U1 does not edit their CSS. Shared-directory workers must not stage, commit, or run project suites. Root integrates and validates after both finish.

## Security and persistence
No new routes or data writes. Existing auth, app sandbox and ownership checks remain authoritative. Image URLs use existing bounded icon slug validation; no external hotlinks. Template migration must preserve owner-customized icons and app files.
