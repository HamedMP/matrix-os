# 031: Fully Customizable Desktop Experience

## Status: Complete

## Overview

Enable full desktop customization through Settings UI and natural language chat. Users can change theme colors, background, dock layout, and more. All config follows "Everything Is a File": `~/system/theme.json` (existing, enhanced) and `~/system/desktop.json` (new).

## Task Range: T1000-T1010

## Architecture

```
~/system/theme.json       -- colors, fonts, radius (existing, enhanced)
~/system/desktop.json     -- NEW: background + dock config
~/system/wallpapers/      -- NEW: uploaded wallpaper images

Shell hooks:
  useTheme.ts             -- MODIFIED: export Theme type, add saveTheme()
  useDesktopConfig.ts     -- NEW: load desktop.json, apply background, update dock store

Shell stores:
  desktop-config.ts       -- NEW: zustand store for dock config (read by Desktop.tsx)

Shell settings UI:
  AppearanceSection.tsx   -- NEW: tabs container (Theme / Background / Dock)
  ThemeEditor.tsx         -- NEW: preset gallery, color pickers, font/radius controls
  BackgroundEditor.tsx    -- NEW: type selector, wallpaper gallery + upload, solid/gradient
  DockEditor.tsx          -- NEW: position, size, icon size, auto-hide
  ColorPicker.tsx         -- NEW: hex color input with swatch preview

Kernel:
  desktop-customization.md -- NEW knowledge file (replaces theme-system.md)
```

## Data Schemas

### theme.json

```json
{
  "name": "default",
  "colors": {
    "background": "#ece5f0",
    "foreground": "#1c1917",
    "card": "#ffffff",
    "card-foreground": "#1c1917",
    "popover": "#ffffff",
    "popover-foreground": "#1c1917",
    "primary": "#c2703a",
    "primary-foreground": "#ffffff",
    "secondary": "#f0eaf4",
    "secondary-foreground": "#44403c",
    "muted": "#f0eaf4",
    "muted-foreground": "#78716c",
    "accent": "#f0eaf4",
    "accent-foreground": "#44403c",
    "destructive": "#ef4444",
    "success": "#22c55e",
    "warning": "#eab308",
    "border": "#d8d0de",
    "input": "#d8d0de",
    "ring": "#c2703a"
  },
  "fonts": {
    "mono": "JetBrains Mono, monospace",
    "sans": "Inter, system-ui, sans-serif"
  },
  "radius": "0.75rem"
}
```

### desktop.json

```json
{
  "background": {
    "type": "pattern"
  },
  "dock": {
    "position": "left",
    "size": 56,
    "iconSize": 40,
    "autoHide": false
  }
}
```

Background types:
- `{ type: "pattern" }` - Built-in SVG waves pattern
- `{ type: "solid", color: "#hex" }` - Solid color
- `{ type: "gradient", from: "#hex", to: "#hex", angle?: number }` - Linear gradient
- `{ type: "wallpaper", name: "filename.jpg" }` - Uploaded wallpaper from ~/system/wallpapers/

## Theme Presets

| Preset | Background | Primary | Description |
|--------|-----------|---------|-------------|
| default | #ece5f0 | #c2703a | Lavender canvas, terracotta accent |
| dark | #0a0a0a | #3b82f6 | True dark, blue accent |
| nord | #2e3440 | #88c0d0 | Arctic blue-gray, frost accent |
| dracula | #282a36 | #bd93f9 | Dark purple, purple accent |
| solarized-light | #fdf6e3 | #268bd2 | Warm cream, blue accent |
| solarized-dark | #002b36 | #268bd2 | Dark teal, blue accent |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/settings/desktop | Read desktop.json (fallback to defaults) |
| PUT | /api/settings/desktop | Validate + write desktop.json |
| GET | /api/settings/theme | Read theme.json |
| PUT | /api/settings/theme | Write theme.json |
| GET | /api/settings/wallpapers | List files in ~/system/wallpapers/ |
| POST | /api/settings/wallpaper | Upload wallpaper (base64 body: {name, data}) |
| DELETE | /api/settings/wallpaper/:name | Remove wallpaper file |

Binary file serving added to `/files/*` for image MIME types (png, jpg, gif, webp, svg).

## New Files (17)

| File | Purpose |
|------|---------|
| `shell/src/lib/theme-presets.ts` | 6 preset themes |
| `shell/src/hooks/useDesktopConfig.ts` | Hook: fetch desktop.json, apply background, update dock store |
| `shell/src/stores/desktop-config.ts` | Zustand store for dock config |
| `shell/src/components/settings/sections/AppearanceSection.tsx` | Tabbed container: Theme / Background / Dock |
| `shell/src/components/settings/ThemeEditor.tsx` | Preset gallery + color grid + font selects + radius slider |
| `shell/src/components/settings/BackgroundEditor.tsx` | Type selector, wallpaper gallery/upload, solid/gradient pickers |
| `shell/src/components/settings/DockEditor.tsx` | Position select, size/icon sliders, auto-hide toggle, mini preview |
| `shell/src/components/settings/ColorPicker.tsx` | Swatch + native color input |
| `shell/src/components/ui/slider.tsx` | shadcn Slider component |
| `shell/src/components/ui/switch.tsx` | shadcn Switch component |
| `home/system/desktop.json` | Default desktop config template |
| `home/system/wallpapers/.gitkeep` | Wallpapers directory |
| `home/agents/knowledge/desktop-customization.md` | AI knowledge for chat-driven customization |
| `tests/gateway/settings-desktop.test.ts` | Gateway endpoint tests (~11 tests) |
| `tests/shell/theme-presets.test.ts` | Preset validation tests (~5 tests) |
| `tests/shell/desktop-config.test.ts` | Desktop config hook/store tests (~6 tests) |
| `tests/shell/dock-config.test.ts` | Dock configuration tests (~5 tests) |

## Modified Files (8)

| File | Changes |
|------|---------|
| `packages/gateway/src/routes/settings.ts` | Desktop/theme/wallpaper endpoints |
| `packages/gateway/src/server.ts` | Image MIME types + binary file serving |
| `shell/src/hooks/useTheme.ts` | Export Theme type, add saveTheme() |
| `shell/src/app/globals.css` | Remove hardcoded SVG background |
| `shell/src/components/Settings.tsx` | Add Appearance section (first in list) |
| `shell/src/components/Desktop.tsx` | Dynamic dock position/size/auto-hide |
| `shell/src/app/page.tsx` | Call useDesktopConfig() |
| `home/system/theme.json` | Fix color keys to match CSS variables |

## Implementation Steps

### Step 1: Gateway endpoints + binary file serving (TDD)
- Add settings/desktop, settings/theme, wallpaper CRUD endpoints to routes/settings.ts
- Add image MIME types + binary serving to server.ts /files/* handler
- Tests in tests/gateway/settings-desktop.test.ts

### Step 2: Theme presets + saveTheme
- Create theme-presets.ts with 6 complete presets
- Export Theme type and saveTheme() from useTheme.ts
- Fix home/system/theme.json color keys
- Create home/system/desktop.json and wallpapers/.gitkeep
- Tests in tests/shell/theme-presets.test.ts

### Step 3: Desktop config hook + store + background
- Create zustand store for dock config
- Create useDesktopConfig hook (fetch, watch, apply background, update dock)
- Remove hardcoded SVG background from globals.css
- Call useDesktopConfig() in page.tsx
- Tests in tests/shell/desktop-config.test.ts and dock-config.test.ts

### Step 4: shadcn UI primitives
- Add Slider and Switch components (radix-ui)

### Step 5: Appearance settings section + editors
- ColorPicker, ThemeEditor, BackgroundEditor, DockEditor, AppearanceSection
- Add Appearance as first section in Settings.tsx

### Step 6: Dock customization in Desktop.tsx
- Dynamic position/size/iconSize/autoHide from store
- Responsive layout changes for left/right/bottom positions

### Step 7: Chat-driven customization
- Knowledge file documenting theme.json, desktop.json, presets, and common commands
- Replaces old theme-system.md

## Verification Checklist

1. `bun run test` -- all existing + ~27 new tests pass
2. Settings > Appearance > Theme: click preset swatches, live theme change
3. Theme > modify individual colors with picker, save, hot-reload
4. Background > switch between solid/gradient/wallpaper/pattern, live update
5. Background > upload wallpaper, appears in gallery and applies
6. Dock > change position to right/bottom, dock moves
7. Dock > toggle auto-hide, dock hides/shows on hover
8. Chat: "make it dark" -> theme changes to dark preset
9. Chat: "move dock to the bottom" -> dock position changes
10. Chat: "set background to blue" -> solid blue background

## Dependencies

- Step 3 depends on Step 1 (gateway endpoints for fetch)
- Step 5 depends on Steps 1-4
- Step 6 depends on Step 3
- Steps 1, 2, 4, 7 are independent
