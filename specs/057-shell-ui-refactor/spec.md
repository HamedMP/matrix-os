# 057: Shell UI Refactor

## Status: Complete

## Overview

Overhaul the shell's visual design, theming, and window management. Introduces a neumorphic/retro theme style, mesh gradient backgrounds with configurable tokens, canvas window title bars with macOS and Win98 styles, minimized-window dock icons with animations, and a consolidated Appearance settings section. Also includes code quality improvements: shared utilities, efficient store selectors, and mandatory fetch timeouts.

## Task Range: T1100-T1112

## Architecture

```
Shell theme pipeline:
  globals.css               -- MODIFIED: sage-green palette, neumorphic overrides,
                               gradient tokens, dock/minimap animations
  lib/theme-presets.ts      -- MODIFIED: added RETRO_THEME preset
  hooks/useTheme.ts         -- MODIFIED: apply data-theme-style attr, gradient tokens
  hooks/useDesktopConfig.ts -- MODIFIED: buildMeshGradient() using CSS vars

Window management:
  hooks/useWindowManager.ts -- MODIFIED: createWindowRecord() helper, getFocusedWindow(),
                               restoreAndFocusWindow(), openWindowExclusive(),
                               fixed debouncedSave equality check
  components/Desktop.tsx    -- MODIFIED: minimized dock icons, dock separator,
                               animate-minimize, focused-window commands
  components/MissionControl -- MODIFIED: removed handleClose wrapper, use nameToSlug

Canvas windows:
  canvas/CanvasWindow.tsx   -- MODIFIED: macOS + Win98 title bars, scalar isFocused
  canvas/CanvasMinimap.tsx  -- MODIFIED: dimension-stable canvas, group outlines
  canvas/CanvasToolbar.tsx  -- MODIFIED: cascade windows command
  canvas/CanvasRenderer.tsx -- MODIFIED: grid rendering adjustments

Settings:
  settings/AppearanceSection -- MODIFIED: consolidated theme/background/dock editors,
                                wallpaper upload/delete, gradient color pickers,
                                preset gallery, fetch timeouts
  components/Settings.tsx    -- MODIFIED: updated section routing

Shared utilities:
  lib/utils.ts              -- MODIFIED: added nameToSlug()
  stores/commands.ts        -- MODIFIED: GROUP_ORDER for command palette
  stores/desktop-config.ts  -- MODIFIED: DockConfig type alignment

Gateway:
  routes/settings.ts        -- MODIFIED: wallpaper upload size validation
  server.ts                 -- MODIFIED: settings route registration
```

## Key Design Decisions

### Neumorphic Theme System
- CSS attribute `data-theme-style="neumorphic"` on `:root` activates neumorphic overrides
- Neumorphic CSS rules use `[data-theme-style="neumorphic"]` selectors in globals.css
- Tokens `--neu-shadow-light`, `--neu-shadow-dark`, `--neu-distance`, `--neu-blur` control depth
- `CanvasWindow` reads theme style via `MutationObserver` on `:root` for render-path isolation

### Mesh Gradient Backgrounds
- Four CSS custom properties: `--gradient-deep`, `--gradient-mid`, `--gradient-light`, `--gradient-accent`
- `buildMeshGradient()` composes 5 radial gradients using these tokens
- Gradient colors editable in Appearance settings via color pickers

### Window Management
- `createWindowRecord()` shared helper eliminates duplication between `openWindow` and `openWindowExclusive`
- `getFocusedWindow()` on the store replaces 4 inline filter+sort patterns
- `restoreAndFocusWindow()` atomically restores + raises z-index
- Minimized windows render as animated dock icons; clicking restores without affecting other windows
- `debouncedSave` subscriber equality check includes `apps` to prevent stale layout writes

### Canvas Title Bars
- Two styles: macOS glass pill (default) and Win98 raised bevel (neumorphic)
- `isFocused` uses scalar `maxZ` selector to avoid O(n) work per window per store tick
- Win98 bevel borders extracted to `win98Bevel` const (was repeated 4x)

## Data Schemas

### theme.json (extended)

```json
{
  "name": "retro",
  "style": "neumorphic",
  "colors": { "...standard color keys..." },
  "fonts": { "mono": "...", "sans": "..." },
  "radius": "0.5rem",
  "gradientColors": {
    "deep": "#323D2E",
    "mid": "#9AA48C",
    "light": "#8CC7BE",
    "accent": "#6a8a7a"
  }
}
```

New fields: `style` (optional, `"flat" | "neumorphic"`), `gradientColors` (optional).

## New Files

| File | Purpose |
|------|---------|
| `specs/057-shell-ui-refactor/spec.md` | This specification |
| `specs/057-shell-ui-refactor/tasks.md` | Task breakdown |

## Modified Files

| File | Changes |
|------|---------|
| `shell/src/app/globals.css` | Sage-green palette, neumorphic CSS overrides, gradient tokens, dock/minimap animations |
| `shell/src/app/page.tsx` | Chat window integration, desktop mode handling |
| `shell/src/lib/theme-presets.ts` | Added RETRO_THEME preset |
| `shell/src/lib/utils.ts` | Added shared `nameToSlug()` |
| `shell/src/hooks/useTheme.ts` | Theme style attribute, gradient token application |
| `shell/src/hooks/useDesktopConfig.ts` | `buildMeshGradient()`, narrowed effect deps |
| `shell/src/hooks/useWindowManager.ts` | `createWindowRecord()`, `getFocusedWindow()`, `restoreAndFocusWindow()`, fixed subscriber equality |
| `shell/src/components/Desktop.tsx` | Minimized dock icons, animate-minimize, focused-window commands, nameToSlug import |
| `shell/src/components/MissionControl.tsx` | Removed handleClose wrapper, nameToSlug import |
| `shell/src/components/CommandPalette.tsx` | Dynamic GROUP_ORDER rendering |
| `shell/src/components/AppTile.tsx` | Icon rendering adjustments |
| `shell/src/components/Settings.tsx` | Section routing update |
| `shell/src/components/canvas/CanvasWindow.tsx` | macOS + Win98 title bars, scalar isFocused, win98Bevel const |
| `shell/src/components/canvas/CanvasMinimap.tsx` | Stable canvas dimensions, group outlines |
| `shell/src/components/canvas/CanvasToolbar.tsx` | Cascade windows command |
| `shell/src/components/canvas/CanvasRenderer.tsx` | Grid rendering adjustments |
| `shell/src/components/settings/sections/AppearanceSection.tsx` | Consolidated settings UI, fetch timeouts, removed redundant dock state |
| `shell/src/components/settings/sections/SkillsSection.tsx` | nameToSlug import |
| `shell/src/stores/commands.ts` | GROUP_ORDER constant |
| `shell/src/stores/desktop-config.ts` | DockConfig type |
| `packages/gateway/src/routes/settings.ts` | Wallpaper upload validation |
| `packages/gateway/src/server.ts` | Settings route registration |
| `home/system/theme.json` | Updated to sage-green/retro defaults |
| `home/system/desktop.json` | Updated background config |

## Verification Checklist

1. `npx tsc --noEmit` — no type errors
2. Theme presets apply correctly (default sage-green, retro neumorphic)
3. Neumorphic mode: cards/buttons/inputs have raised/inset shadows
4. Mesh gradient background renders with 5 radial layers
5. Gradient color pickers update background live
6. Minimized window appears as animated dock icon
7. Clicking minimized dock icon restores ONLY that window
8. Canvas windows show macOS title bar (default) or Win98 (neumorphic)
9. Canvas minimap doesn't flicker during drag operations
10. Command palette groups render in correct order
