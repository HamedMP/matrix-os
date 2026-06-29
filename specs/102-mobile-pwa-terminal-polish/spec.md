# Spec 102 — Mobile PWA Polish + Terminal Refinement (Web Shell)

**Status:** Draft (design approved, not yet implemented)
**Branch:** `102-mobile-pwa-terminal-polish` (forked off `fix/www-onboarding-flow`)
**Surface:** `shell/` (Next.js web shell PWA) only
**Approach:** adapt best-in-class mobile-terminal-PWA *techniques*, keep the Matrix OS brand.

---

## 1. Goal

Make the Matrix OS **web shell PWA** look and feel polished on mobile, and refine the existing
xterm.js terminal — without changing the terminal engine or the agent layer.

Two independent workstreams, sequenced **B (terminal) → A (mobile)** so the lowest-risk, highest-visibility
win (WebGL renderer) lands first, then the broader restyle.

## 2. Scope

**In scope (web shell `shell/` only):**
- A. Mobile PWA restyle: shell chrome, app switcher + transitions, built-in app interiors, toasts + drawers/sheets, PWA meta/manifest polish.
- B. xterm terminal polish: enable WebGL renderer, refine mobile keyboard handling, restyle key bar + paste UX, font/theme token alignment.

**Explicitly OUT of scope (do not touch in this spec):**
- ❌ Swapping xterm.js for Ghostty / `ghostty-web`. (Engine stays xterm.)
- ❌ Swapping the Claude Agent SDK for the Vercel AI SDK. (Agent layer unchanged.)
- ❌ Any Hermes changes (messaging/capability/automation layer).
- ❌ The Expo native app (`apps/mobile/`) — it is a separate first-class client with its own UI; this spec does not modify it. Visual *parity ideas* may be shared later but are not part of this work.
- ❌ Desktop shell (`Desktop.tsx`) behavior — must remain functionally unchanged (shared components must not regress desktop).

## 3. Current State (findings)

### Mobile shell
- Lives in **3 files**: `shell/src/components/mobile/MobileShell.tsx` (~24KB; contains the app-switcher logic inline), `MobileLauncher.tsx`, `MobileAppSurface.tsx`.
- Single-app-fullscreen model; `useMobileViewport()` (≤767px) branches `ShellHome.tsx` → `MobileShell` vs `Desktop`.
- **App swaps are instant** — `framer-motion` is *not* used anywhere under `components/mobile/` (it is a repo dependency, so it's available).
- Launcher = 2-col grid of letter-tile cards; app-switcher close buttons are basic inline-styled circles; no micro-interactions, no skeletons.
- `MobileAppSurface` header = home button + title with `pt-[env(safe-area-inset-top)]`.

### Terminal
- `shell/src/components/terminal/TerminalPane.tsx` — one **~1,300-line lifecycle effect** owning xterm creation, WS attach, addons, caching, keybindings, OSC handlers, resize.
- xterm v6 runs on the **default DOM renderer**. `@xterm/addon-webgl@^0.19.0` is **installed but never instantiated** — `webglAddon` appears only in cache/cleanup plumbing (`terminal-cache.ts`, `TerminalPane.tsx`).
- Active addons: Fit, Search, Image (sixel/iTerm2), Serialize. OSC-52 clipboard via `parser.registerOscHandler(52, …)`. Custom keys via `attachCustomKeyEventHandler`. Block-marks (A/B/C/D) + seq-based replay buffer for Zellij reattach.
- **`visualViewport` handling already exists** in `shell/src/components/terminal/TerminalKeyBar.tsx` — partial; to be extended/hardened.
- I/O protocol is clean JSON over WS: `{type:"input"|"resize"|"detach"|"ping"}` up, `{type:"output"|"attached"|"block-mark"|"replay-start/end"|"exit"|"error"}` down. **Unchanged by this spec.**

### Shared infra
- Tailwind **v4** via `@tailwindcss/postcss`; tokens are CSS variables in `shell/src/app/globals.css`. No `tailwind.config.ts`.
- Brand: forest `#434E3F`, cream `#E0E1CA`, ember `#D06F25`, deep `#32352E`; accent lichen `#9AA48C`. Fonts: Orbitron (display/brand only), Inter (UI), JetBrains Mono (code). See `DESIGN.md`.
- **No `vaul`, no `sonner`** in `shell/` today — both are new (small) additions.
- PWA: `shell/public/manifest.json` exists (theme-color `#3f4a3a`, 192/512/maskable icons, Terminal/Chat/Files shortcuts).
- Playwright screenshot tests exist for the shell.

### ⚠️ Possible overlap to check before implementing
Several in-flight worktrees/branches touch the same area. Reconcile before starting to avoid conflicts:
- `fix-mobile-terminal-ui`
- `fix-pwa-icon-safe-area`
- `mobile-workspace-stores` (worktree `matrix-os-mobile-refresh`)
- Recent commit `ff3dbe23c feat(shell): unify terminal window chrome across Desktop, Canvas, and mobile`

## 4. Design Principles

1. **Adapt techniques, keep the brand.** No new design language; reuse forest/cream/ember + existing CSS-var tokens. Port proven *methods* (glass surfaces, motion, drawers, viewport handling), never another product's palette.
2. **Surgical, not a rewrite.** Do **not** rewrite the `TerminalPane` monolith. Insert the WebGL addon and extend viewport handling in place; only extract a component when it already has a seam (the key bar is already its own file).
3. **Reusable primitives.** Add a small shared layer — motion variants, a glass-surface utility, a `useVisualViewport` hook — so mobile and terminal share one implementation.
4. **Desktop must not regress.** Any shared component change is verified against `Desktop.tsx`.
5. **Respect `prefers-reduced-motion`.** All transitions degrade to instant.
6. **Performance on real phones.** Animate transform/opacity only; lazy-load heavy bits; keep WebGL fallback robust (Safari drops GL contexts).

---

## 5. Workstream A — Mobile PWA Restyle

### A1. Design tokens & primitives (`globals.css` + small utils)
- Add semantic **surface/elevation/glass** tokens layered on existing brand vars: e.g. `--surface-glass` (brand bg @ ~80% + `backdrop-blur`), elevation shadow scale, iOS-style spring easing token `--ease-emphasized: cubic-bezier(0.32, 0.72, 0, 1)`.
- Add safe-area helper classes and a `100dvh` root convention (verify shell root uses `dvh`, not `vh`).
- New: `shell/src/lib/motion.ts` — shared `framer-motion` variants (app-enter/exit, sheet, fade-up) honoring reduced-motion.

### A2. Shell chrome (`MobileAppSurface.tsx`, `MobileShell.tsx`)
- Glass-morphism header (`--surface-glass` + blur), refined safe-area padding (top inset + comfortable touch height ~44px).
- Consistent header layout: leading home/back, centered title, trailing slot for app actions.

### A3. Launcher polish (`MobileLauncher.tsx`)
- Refine grid: spacing rhythm, card press states (scale-on-tap), entrance stagger animation, optional real app icons/colors instead of letter tiles.
- Loading skeletons for app list.

### A4. App switcher + transitions (`MobileShell.tsx`)
- Replace instant app swaps with `framer-motion` `AnimatePresence` slide/fade using A1 variants.
- Polish recent-apps switcher: card depth, animated close buttons with hit-area ≥44px, swipe affordance.
- Consider extracting switcher into `MobileAppSwitcher.tsx` to shrink the 24KB `MobileShell.tsx` (only if it lowers risk).

### A5. Built-in app interiors (Chat / Files / Settings)
- Apply token + spacing pass inside the built-in app surfaces (not just OS chrome): consistent headers, list rows, empty states, touch targets.
- Keep changes presentational; no behavior/data-flow changes.

### A6. Toasts + drawers/sheets (new deps)
- Add `sonner` for toasts; position above the bottom safe-area inset and theme to brand.
- Add `vaul` for mobile bottom-sheets (menus/dialogs) with drag handle; use for at least one real surface (e.g. app actions / a settings menu) to establish the pattern.

### A7. PWA meta/manifest polish
- Audit `shell/` document head: `viewport-fit=cover`, `interactive-widget=resizes-content`, light/dark `theme-color`, `apple-mobile-web-app-*`, `apple-touch-icon`.
- Verify `manifest.json` icons/maskable + shortcuts render correctly when installed. (Coordinate with `fix-pwa-icon-safe-area` if still open.)

## 6. Workstream B — Terminal Polish

### B1. Enable WebGL renderer  ⟵ ship first
- Instantiate `WebglAddon` after `xterm.open()` and `fit()`, load it, and wire `onContextLoss` → dispose + fall back to DOM renderer (and attempt one re-create).
- Reuse the existing `webglAddon` cache slot in `terminal-cache.ts`; ensure proper dispose on unmount (context-lost handler already partially present).
- Verify interplay with `ImageAddon` (sixel) under WebGL.

### B2. Mobile keyboard handling (`TerminalKeyBar.tsx` + new `useVisualViewport`)
- Extract a reusable `shell/src/hooks/useVisualViewport.ts` (height, offsetTop, keyboard-open) and hook it into terminal layout: pin terminal viewport to `visualViewport.height`, translate by `offsetTop`, re-`fit()` on change so the prompt isn't hidden behind the keyboard.
- Publish a `--terminal-keyboard-height` CSS var for the key bar / toasts to offset against.

### B3. Key bar restyle + paste UX (`TerminalKeyBar.tsx`)
- Replace raw inline styles with brand tokens; proper pressed/active states; ≥44px targets; scrollable extra-keys row.
- Add long-press / explicit **Paste** affordance (clipboard read with `<input>` fallback for iOS; no trailing Enter — user reviews before sending).

### B4. Font + theme alignment
- Align terminal theme tokens (the 3 themes: `light`, `matrix-dark`, `matrix`) with brand palette; ensure JetBrains Mono stack.
- iOS anti-zoom: ensure any terminal-adjacent `<input>` is ≥16px.

---

## 7. Risks & Mitigations
- **WebGL context loss on mobile Safari** → robust DOM fallback + single re-create attempt; never leave a blank pane.
- **Shared-component regressions on desktop** → test `Desktop.tsx` paths; gate mobile-only changes behind `useMobileViewport`.
- **Branch overlap** (§3 ⚠️) → diff against the listed worktrees before coding; rebase as needed.
- **Motion jank on low-end devices** → transform/opacity only; respect reduced-motion; cap durations.
- **New deps (`sonner`, `vaul`)** → small, tree-shakeable; confirm SSR/Next 16 compatibility.

## 8. Testing
- Extend Playwright shell screenshot tests with **mobile-viewport** captures: launcher, app switcher mid-transition, built-in app, terminal (WebGL on), terminal with keyboard open.
- Manual device checklist: installed PWA on iOS Safari + Android Chrome — safe areas, keyboard, app-switch transitions, toasts/sheets, terminal render + paste.
- Regression: desktop shell unaffected; terminal reattach/replay still works after WebGL enable.

## 9. Sequencing
1. **B1** (WebGL) — isolated, immediate visible win.
2. **A1** (tokens/primitives) — unblocks the rest.
3. **B2–B4** (terminal mobile polish).
4. **A2–A4** (chrome, launcher, transitions).
5. **A6** (toasts/sheets), **A5** (app interiors), **A7** (PWA meta).

## 10. Open Questions
- Real app icons for the launcher, or keep letter tiles styled up? (A3)
- Adopt `vaul`/`sonner`, or build minimal in-house equivalents to avoid deps? (A6)
- Is `ff3dbe23c` (terminal chrome unification) the canonical base for the key bar work, or superseded? (§3)
