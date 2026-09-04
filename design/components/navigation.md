---
title: Navigation
description: Dock, tabs, and navigation patterns.
status: stable
tokens:
  - semanticColors.primary
  - semanticColors.surface
  - semanticColors.border
  - semanticColors.muted
  - rounded.xl
  - rounded.full
---

# Navigation

## Dock

The dock is the primary launcher and task indicator.

### Properties

| Property    | Value                                    |
|-------------|------------------------------------------|
| Position    | Left side (desktop), bottom (mobile)     |
| Width       | 56px (desktop), full width (mobile)      |
| Background  | Paper at 40% with backdrop blur          |
| Border      | 1px `semanticColors.border` at 40%       |
| Icon size   | 40×40px with `xl` radius                 |
| Gap         | `sm` (8px) between icons                 |

### Dock Icon States

| State    | Visual                                         |
|----------|-------------------------------------------------|
| Default  | Surface background, semantic border, `shadow-sm`    |
| Hover    | `shadow-md`, scale 1.05                          |
| Active   | Running indicator dot below (6px, Green 300)      |
| Selected | Teal 800 background, Paper icon                   |

### Behavior

- Click icon: open app / bring to front
- Click active icon: bring window to front (if behind others)
- Running apps show a small dot indicator
- Items do not reflow when added/removed — animate in/out

## Tabs

Used in bottom panel and within apps.

### Properties

| Property   | Value                             |
|------------|-----------------------------------|
| Height     | 36px                              |
| Font       | Body small (0.875rem), weight 500 |
| Radius     | `rounded.lg` (12px) for tab container |
| Active bg  | `semanticColors.surface` with `shadow-sm` |
| Inactive   | transparent, `semanticColors.mutedForeground` |
| Gap        | `xs` (4px) between tabs           |

### Toggle Behavior

From the UX Guide — tabs that control panels must toggle:
- Panel closed + click tab → open with that tab
- Panel open + click different tab → switch tab
- Panel open + click active tab → close panel

## Breadcrumbs

For nested navigation within apps.

```
Home  /  Settings  /  Appearance
 ↑        ↑            ↑
 link     link         current (not linked)
```

- Separator: `/` in `semanticColors.mutedForeground`
- Links: `semanticColors.foreground`, underline on hover
- Current: `semanticColors.mutedForeground`, no underline
- Font: Body small
