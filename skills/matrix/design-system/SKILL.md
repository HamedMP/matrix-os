---
name: matrix-design-system
description: Design polished Matrix OS apps using the Matrix theme, shadcn-style components, iframe-safe layouts, strong icon choices, and app-specific UX patterns.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Matrix OS, design, shadcn, UI, icons]
    related_skills: [matrix-app-builder]
---

# Matrix Design System

## When to Use

Use this when designing, redesigning, or polishing a Matrix OS app, built-in app, or app icon.

## Core Rules

- Apps run inside Matrix windows and iframes. Use `html, body, #root { width: 100%; height: 100%; margin: 0; }`.
- Do not build landing pages for apps. The first screen is the usable product.
- Prefer quiet, dense, work-focused UI for productivity apps.
- Use shadcn-style primitives: buttons, inputs, tabs, dialogs, sidebars, tables, menus, toggles, sliders.
- Use familiar icons in controls. Text-only buttons are for clear commands.
- Cards are for individual repeated items, modals, or framed tools. Do not nest cards inside cards.
- Avoid one-note palettes. Do not make the whole app only purple, blue, beige, brown, or slate.
- Do not use decorative gradient blobs, bokeh, or generic hero art.
- Text must fit at desktop and mobile window sizes.

## Theme Variables

Base app CSS should map Matrix variables into local app variables:

```css
:root {
  color-scheme: light;
  --app-bg: var(--matrix-bg, #f6f4f1);
  --app-fg: var(--matrix-fg, #1c1917);
  --app-card: var(--matrix-card, #ffffff);
  --app-muted: var(--matrix-muted, #eee9e3);
  --app-muted-fg: var(--matrix-muted-fg, #6f675f);
  --app-border: var(--matrix-border, #ded7ce);
  --app-primary: var(--accent, var(--matrix-primary, #c2703a));
  --app-primary-fg: var(--matrix-primary-fg, #ffffff);
  --app-success: var(--matrix-success, #22c55e);
  --app-warning: var(--matrix-warning, #eab308);
  --app-danger: var(--matrix-destructive, #ef4444);
  --app-radius: var(--matrix-radius, 12px);
  --app-font: var(--matrix-font-sans, ui-sans-serif, system-ui, sans-serif);
  --app-mono: var(--matrix-font-mono, ui-monospace, SFMono-Regular, monospace);
}
```

## Layout Pattern

Use a compact app shell:

```css
.matrix-app {
  min-height: 100%;
  padding: 16px;
  background: var(--app-bg);
  color: var(--app-fg);
}

.matrix-shell {
  height: calc(100vh - 32px);
  min-height: 420px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
}
```

## Built-In App Taste Bar

- Workspace: spatial, calm, minimal chrome, strong empty states, canvas actions as icons.
- Files: high-density list/grid, preview pane, breadcrumbs, clear modified dates and file types.
- Chat: conversation-first, compact message rhythm, clear streaming and tool states.
- Whiteboard: immediate canvas, light toolbar, shape/color controls, no marketing copy.
- Terminal: strong contrast, dense toolbar, session tabs, search, copy, reconnect states.

## Icon Rules

- Use a consistent app-icon grid, not random generated art.
- Prefer simple geometry, high contrast, and one clear metaphor.
- Icons should read at 32px and 128px.
- Avoid tiny text inside icons.
- Default app icons should be committed assets so every user sees the same initial icons.

## Verification

Check:

- No horizontal overflow in small windows.
- Buttons and controls keep stable dimensions.
- Empty, loading, error, and success states exist.
- Console has no app errors.
- Visual style feels like Matrix, not a generic template.
