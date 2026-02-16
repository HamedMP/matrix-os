# 031: Desktop Customization Tasks

## T1000: Gateway endpoints for desktop/theme/wallpaper settings
- [x] GET/PUT /api/settings/desktop
- [x] GET/PUT /api/settings/theme
- [x] GET /api/settings/wallpapers
- [x] POST /api/settings/wallpaper (base64 upload)
- [x] DELETE /api/settings/wallpaper/:name
- [x] Binary file serving for images in /files/*
- [x] Tests: tests/gateway/settings-desktop.test.ts (~11 tests)

## T1001: Theme presets + saveTheme
- [x] shell/src/lib/theme-presets.ts (6 presets)
- [x] Export Theme type from useTheme.ts
- [x] Add saveTheme() to useTheme.ts
- [x] Fix home/system/theme.json color keys
- [x] Tests: tests/shell/theme-presets.test.ts (~5 tests)

## T1002: Desktop config store + hook
- [x] shell/src/stores/desktop-config.ts (zustand dock store)
- [x] shell/src/hooks/useDesktopConfig.ts (fetch, watch, apply background)
- [x] Remove hardcoded SVG background from globals.css
- [x] Call useDesktopConfig() in page.tsx
- [x] home/system/desktop.json template
- [x] home/system/wallpapers/.gitkeep
- [x] Tests: tests/shell/desktop-config.test.ts, tests/shell/dock-config.test.ts (~11 tests)

## T1003: shadcn UI primitives
- [x] shell/src/components/ui/slider.tsx
- [x] shell/src/components/ui/switch.tsx
- [x] Install @radix-ui/react-slider, @radix-ui/react-switch

## T1004: Appearance settings UI
- [x] ColorPicker component
- [x] ThemeEditor (preset gallery, color grid, font selects, radius slider)
- [x] BackgroundEditor (type selector, wallpaper gallery/upload, solid/gradient)
- [x] DockEditor (position, size, icon size, auto-hide, preview)
- [x] AppearanceSection (tabs container)
- [x] Add Appearance as first section in Settings.tsx

## T1005: Dock customization in Desktop.tsx
- [x] Read dock config from store
- [x] Dynamic position (left/right/bottom)
- [x] Dynamic size and icon size
- [x] Auto-hide behavior
- [x] Tooltip side based on position

## T1006: Chat-driven customization knowledge file
- [x] home/agents/knowledge/desktop-customization.md
- [x] Delete old theme-system.md

## T1007: Spec document + appearance tests
- [x] specs/031-desktop-customization/spec.md
- [x] specs/031-desktop-customization/tasks.md
- [x] tests/shell/appearance-settings.test.ts (~11 tests)
