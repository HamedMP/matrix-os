---
title: Navigation
description: Dock, tabs, and navigation patterns.
status: stable
tokens:
  - colors.primary
  - colors.card
  - colors.border
  - colors.muted
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
| Background  | `--card` @ 40% with backdrop blur        |
| Border      | 1px `--border` @ 40% on the right edge   |
| Icon size   | 40×40px with `xl` radius                 |
| Gap         | `sm` (8px) between icons                 |

### Dock Icon States

| State    | Visual                                         |
|----------|-------------------------------------------------|
| Default  | `--card` background, `--border` border, `shadow-sm` |
| Hover    | `shadow-md`, scale 1.05                          |
| Active   | Running indicator dot below (6px, `--primary`)   |
| Selected | `--primary` background, white icon               |

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
| Radius     | `lg` (14px) for tab container     |
| Active bg  | `--card` with `shadow-sm`         |
| Inactive   | transparent, `--muted-foreground` |
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

- Separator: `/` in `--muted-foreground`
- Links: `--foreground`, underline on hover
- Current: `--muted-foreground`, no underline
- Font: Body small
