---
title: App Chrome
description: Window chrome, title bar, and traffic lights for app windows.
status: stable
tokens:
  - semanticColors.surface
  - semanticColors.foreground
  - semanticColors.border
  - rounded.xl
  - shadows.xl
---

# App Chrome

The window frame surrounding every app in the Matrix OS desktop.

## Anatomy

```
┌──────────────────────────────────────────┐
│ ● ● ●   ─────── App Title ───────       │ ← Title bar (32px)
├──────────────────────────────────────────┤
│                                          │
│            App Content (iframe)          │
│                                          │
│                                          │
└──────────────────────────────────────────┘
```

## Title Bar

| Property     | Value                        |
|--------------|------------------------------|
| Height       | 32px                         |
| Background   | Paper `#FCFCF8`              |
| Border       | 1px bottom `semanticColors.border` |
| Title font   | Body small (0.875rem), 500   |
| Title align  | Center                       |
| Draggable    | Yes (except over controls)   |

## Traffic Lights

Matrix-owned window controls at the top-left of the title bar use the brand
palette. Native macOS or Windows chrome remains platform-native.

| Button   | Color        | Hex       |
|----------|--------------|-----------|
| Close    | Coral 500    | `#BA5236` |
| Minimize | Gold 300     | `#F1C379` |
| Maximize | Green 300    | `#BED77B` |

- Size: 12×12px (`rounded-full`)
- Gap: 8px between dots
- Left padding: 12px from window edge
- Hover: brighten slightly
- Inactive window: all three use `semanticColors.muted`

## Window Frame

| Property    | Value                   |
|-------------|-------------------------|
| Radius      | 16px                     |
| Shadow      | `xl`                    |
| Border      | 1px solid `semanticColors.border` |
| Background  | `semanticColors.surface` |
| Min size    | 320×200px               |
| Resize      | Bottom-right corner     |

## Behavior

- Click anywhere on window: bring to front
- Double-click title bar: maximize / restore
- Drag title bar: move window
- Drag corner: resize
- Close: remove window, save "closed" state
- Minimize: send to dock with indicator

## Mobile

On viewports below 768px, windows become full-screen:
- No traffic lights
- No resize handle
- Title bar becomes a nav header with back button
- `inset: 0` (full viewport)

## Apps Inside Windows

App content renders in an iframe. The OS injects theme CSS variables
via the bridge so apps can match the system theme. Apps should:
- Fill the full window space (no internal margin against window edges)
- Handle resize gracefully
- Use their own scroll container
- Never add internal title bars (the window chrome handles this)
