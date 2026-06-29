# Tasks — Spec 102: Mobile PWA Polish + Terminal Refinement

Surface: `shell/` (web shell PWA) only. Out of scope: Ghostty, Agent SDK swap, Hermes, `apps/mobile` (Expo), desktop behavior.

Legend: `[ ]` todo · est. = rough size (S/M/L) · ⚠️ = check branch overlap first.

---

## Phase 0 — Setup & reconciliation
- [ ] **0.1** ⚠️ Diff this branch against in-flight worktrees touching the same area: `fix-mobile-terminal-ui`, `fix-pwa-icon-safe-area`, `mobile-workspace-stores`, and commit `ff3dbe23c` (terminal chrome unification). Decide canonical base / rebase. (S)
- [ ] **0.2** Confirm `framer-motion`, and add `sonner` + `vaul` to `shell/package.json`; verify Next 16 / React 19 SSR compatibility. (S)

## Phase 1 — Terminal: WebGL renderer (ship first)
- [ ] **1.1** In `TerminalPane.tsx`, instantiate + `loadAddon(WebglAddon)` after `xterm.open()` + initial `fit()`. (M)
- [ ] **1.2** Wire `WebglAddon.onContextLoss` → dispose, fall back to DOM renderer, attempt one re-create; never leave a blank pane. (M)
- [ ] **1.3** Reuse the `webglAddon` slot in `terminal-cache.ts`; ensure correct dispose on unmount and on cached reattach. (S)
- [ ] **1.4** Verify `ImageAddon` (sixel/iTerm2) still renders under WebGL; verify Serialize/Search unaffected. (S)
- [ ] **1.5** Regression: terminal reattach + seq replay + block-marks still work. (S)

## Phase 2 — Shared primitives
- [ ] **2.1** `globals.css`: add semantic tokens — `--surface-glass`, elevation shadow scale, `--ease-emphasized: cubic-bezier(0.32,0.72,0,1)`, safe-area helpers. (M)
- [ ] **2.2** Confirm shell root uses `100dvh` (not `vh`); fix if needed. (S)
- [ ] **2.3** `shell/src/lib/motion.ts`: shared framer-motion variants (app-enter/exit, sheet, fade-up) honoring `prefers-reduced-motion`. (S)
- [ ] **2.4** `shell/src/hooks/useVisualViewport.ts`: reusable hook (height, offsetTop, keyboardOpen) — used by terminal (Phase 3) and any keyboard-aware mobile UI. (M)

## Phase 3 — Terminal: mobile polish
- [ ] **3.1** Hook `useVisualViewport` into terminal layout: pin viewport to `visualViewport.height`, translate by `offsetTop`, re-`fit()` on change; publish `--terminal-keyboard-height`. (M)
- [ ] **3.2** `TerminalKeyBar.tsx`: replace inline styles with brand tokens; pressed/active states; ≥44px targets; scrollable extra-keys row. (M)
- [ ] **3.3** Add long-press / explicit **Paste** affordance (clipboard read + `<input>` fallback for iOS; no trailing Enter). (M)
- [ ] **3.4** Align terminal themes (`light`/`matrix-dark`/`matrix`) with brand palette; JetBrains Mono stack; ≥16px on terminal-adjacent inputs (iOS anti-zoom). (S)

## Phase 4 — Mobile chrome & launcher
- [ ] **4.1** `MobileAppSurface.tsx`: glass header, refined safe-area padding, consistent leading/title/trailing layout. (M)
- [ ] **4.2** `MobileLauncher.tsx`: grid rhythm, tap scale states, entrance stagger, loading skeletons; decide letter-tiles vs real icons (Open Q). (M)
- [ ] **4.3** `MobileShell.tsx`: app-switch transitions via `AnimatePresence` + motion variants (slide/fade). (L)
- [ ] **4.4** Polish recent-apps switcher: card depth, animated close buttons (≥44px hit area), swipe affordance. (M)
- [ ] **4.5** (Optional) Extract `MobileAppSwitcher.tsx` from `MobileShell.tsx` if it reduces risk/size. (M)

## Phase 5 — Surfaces, toasts, sheets, PWA meta
- [ ] **5.1** Integrate `sonner`: brand theme, position above bottom safe-area; replace ad-hoc notifications on mobile. (M)
- [ ] **5.2** Integrate `vaul` bottom-sheet (drag handle) for ≥1 real surface (app actions / settings menu) to establish the pattern. (M)
- [ ] **5.3** Built-in app interiors (Chat/Files/Settings): presentational token + spacing + touch-target pass; no behavior changes. (L)
- [ ] **5.4** ⚠️ PWA meta/manifest audit: `viewport-fit=cover`, `interactive-widget=resizes-content`, light/dark `theme-color`, `apple-mobile-web-app-*`, `apple-touch-icon`; verify maskable icons + shortcuts. Coordinate with `fix-pwa-icon-safe-area`. (M)

## Phase 6 — Testing & verification
- [ ] **6.1** Extend Playwright shell screenshots (mobile viewport): launcher, switcher mid-transition, built-in app, terminal WebGL-on, terminal keyboard-open. (M)
- [ ] **6.2** Manual device checklist: installed PWA on iOS Safari + Android Chrome (safe areas, keyboard, transitions, toasts/sheets, terminal render + paste). (M)
- [ ] **6.3** Desktop regression: `Desktop.tsx` + shared components unaffected. (S)

---

### Suggested order
`1.x` → `2.x` → `3.x` → `4.x` → `5.x` → `6.x`. Phases 1 and 2 can proceed in parallel; everything after depends on Phase 2 primitives.
