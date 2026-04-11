# 057: Shell UI Refactor Tasks

**Spec**: spec.md
**Task range**: T1100-T1112

---

## Phase A: Theme System (T1100-T1102)

### T1100: Sage-green palette + neumorphic CSS foundation
- [x] globals.css: replace lavender palette with sage-green/teal defaults
- [x] globals.css: add neumorphic CSS tokens (`--neu-shadow-light/dark`, `--neu-distance`, `--neu-blur`)
- [x] globals.css: add `[data-theme-style="neumorphic"]` override rules for cards, buttons, inputs, switches, selects, dialogs
- [x] globals.css: add gradient tokens (`--gradient-deep/mid/light/accent`)

### T1101: Theme style + gradient token application
- [x] useTheme.ts: set `data-theme-style` attribute on `:root` from `theme.style`
- [x] useTheme.ts: apply `--gradient-*` CSS vars from `theme.gradientColors`
- [x] lib/theme-presets.ts: add `RETRO_THEME` preset with neumorphic style
- [x] home/system/theme.json: update to sage-green defaults

### T1102: Mesh gradient backgrounds
- [x] useDesktopConfig.ts: `buildMeshGradient()` using `--gradient-*` CSS vars
- [x] useDesktopConfig.ts: narrow `applyBackground` effect dep to `config.background`
- [x] home/system/desktop.json: update background config

---

## Phase B: Window Management (T1103-T1106)

### T1103: Window manager store improvements
- [x] useWindowManager.ts: extract `createWindowRecord()` shared helper
- [x] useWindowManager.ts: add `getFocusedWindow()` method
- [x] useWindowManager.ts: add `restoreAndFocusWindow()` action
- [x] useWindowManager.ts: add `openWindowExclusive()` action
- [x] useWindowManager.ts: fix `debouncedSave` subscriber equality check (include `apps`)

### T1104: Minimized window dock icons
- [x] Desktop.tsx: render minimized windows as dock icons with separator
- [x] globals.css: add `dock-icon-in` and `dock-sep-in` keyframe animations
- [x] Desktop.tsx: clicking minimized dock icon calls `restoreAndFocusWindow` (not minimize others)

### T1105: Canvas window title bars
- [x] CanvasWindow.tsx: macOS glass pill title bar with traffic lights
- [x] CanvasWindow.tsx: Win98 raised bevel title bar for neumorphic theme
- [x] CanvasWindow.tsx: `useThemeStyle()` hook via MutationObserver
- [x] CanvasWindow.tsx: scalar `maxZ` selector for `isFocused` (perf fix)
- [x] CanvasWindow.tsx: extract `win98Bevel` const (was repeated 4x)

### T1106: Canvas minimap improvements
- [x] CanvasMinimap.tsx: set canvas dimensions once on mount (not every draw)
- [x] CanvasMinimap.tsx: draw group outlines from canvas-groups store
- [x] CanvasMinimap.tsx: expand/collapse on pointer enter/leave

---

## Phase C: Settings & UI Polish (T1107-T1109)

### T1107: Consolidated Appearance section
- [x] AppearanceSection.tsx: merge ThemeEditor, BackgroundEditor, DockEditor into single component
- [x] AppearanceSection.tsx: theme preset gallery with live preview
- [x] AppearanceSection.tsx: gradient color pickers for mesh background
- [x] AppearanceSection.tsx: wallpaper upload/delete with gallery
- [x] AppearanceSection.tsx: dock position/size/icon-size/auto-hide controls
- [x] AppearanceSection.tsx: remove redundant `dock` local state (derive from `config.dock`)
- [x] AppearanceSection.tsx: add `AbortSignal.timeout` to all fetch calls
- [x] Settings.tsx: update section routing

### T1108: Command palette refactor
- [x] CommandPalette.tsx: dynamic GROUP_ORDER-based rendering
- [x] stores/commands.ts: GROUP_ORDER constant
- [x] Desktop.tsx: use `getFocusedWindow()` for close/minimize/reload/fullscreen commands

### T1109: Page + integration
- [x] page.tsx: chat window integration, desktop mode handling
- [x] AppTile.tsx: icon rendering adjustments

---

## Phase D: Code Quality (T1110-T1112)

### T1110: Shared utilities
- [x] lib/utils.ts: add `nameToSlug()` function
- [x] Desktop.tsx: import from `@/lib/utils` (remove local definition)
- [x] MissionControl.tsx: import from `@/lib/utils` (remove inline regex)
- [x] SkillsSection.tsx: import from `@/lib/utils` (remove inline regex)

### T1111: MissionControl cleanup
- [x] MissionControl.tsx: remove no-op `handleClose` wrapper, use `onClose` directly
- [x] MissionControl.tsx: remove unused `useCallback` import

### T1112: Gateway adjustments
- [x] routes/settings.ts: wallpaper upload size validation
- [x] server.ts: settings route registration update

---

## Checkpoint

1. [x] `npx tsc --noEmit` passes with no errors
2. [x] Theme presets apply live (default + retro/neumorphic)
3. [x] Neumorphic cards/buttons render with raised/inset shadows
4. [x] Mesh gradient background uses CSS var tokens
5. [x] Minimized windows appear as animated dock icons
6. [x] Clicking minimized icon restores only that window
7. [x] Canvas title bars switch between macOS and Win98 styles
8. [x] Canvas minimap doesn't reset dimensions on every draw
9. [x] All fetch calls in AppearanceSection have timeouts
10. [x] `nameToSlug` used from shared utils (no duplicates)
