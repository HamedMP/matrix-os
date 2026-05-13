---
title: Elevation & Depth
description: Matrix OS shadow system, glass-morphism, and z-index layering.
status: stable
---

# Elevation & Depth

## Shadow Scale

Shadow color is always derived from Deep (`#32352E`), never pure black.

| Level | Value                                    | Use For                      |
|-------|------------------------------------------|------------------------------|
| xs    | `0 1px 2px rgba(50, 53, 46, 0.04)`     | Inputs, subtle lift          |
| sm    | `0 2px 4px rgba(50, 53, 46, 0.06)`     | Cards at rest                |
| md    | `0 4px 12px rgba(50, 53, 46, 0.08)`    | Cards on hover, dropdowns    |
| lg    | `0 8px 24px rgba(50, 53, 46, 0.10)`    | Floating panels, modals      |
| xl    | `0 16px 48px rgba(50, 53, 46, 0.12)`   | Windows, full dialogs        |

## Glass-morphism

Transient/floating elements use frosted glass to maintain visual connection
with the content behind them.

| Variant  | Background               | Blur    | Use For                    |
|----------|--------------------------|---------|----------------------------|
| Light    | `rgba(255,255,255,0.70)` | 12px    | Tooltips, light overlays   |
| Standard | `rgba(255,255,255,0.80)` | 12px    | Panels, sidebars, popovers|
| Heavy    | `rgba(255,255,255,0.90)` | 16px    | Input bars, dialogs        |

Always pair glass surfaces with `border: 1px solid var(--border)` for a
visible edge.

## Z-Index Layers

| Layer             | z-index | Elements                             |
|-------------------|---------|--------------------------------------|
| Base              | 0       | Desktop canvas, app content          |
| App windows       | 10-99   | Managed by window manager (stacking) |
| Dock              | 100     | Left/bottom dock                     |
| Bottom panel      | 110     | Terminal, modules, activity          |
| Input bar         | 120     | Command input, always accessible     |
| Floating panels   | 130     | Chat sidebar, response overlay       |
| Dropdowns         | 140     | Selects, context menus, popovers     |
| Mission Control   | 150     | Full-screen overlay                  |
| Modals/Dialogs    | 160     | Blocking dialogs, confirmations      |
| Toasts            | 170     | Notifications, alerts                |

## Material Rules

From the UX Guide — material type determines visual treatment:

- **Persistent surfaces** (windows, sidebars, bottom panel): opaque `--card`
  background, `sm` or `md` shadow
- **Transient surfaces** (popovers, tooltips, drawers): glass-morphism with
  backdrop blur, `lg` shadow
- **Overlays** (mission control, modal backdrops): `rgba(50, 53, 46, 0.40)`
  with `backdrop-filter: blur(8px)`
