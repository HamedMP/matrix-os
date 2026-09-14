---
name: matrix-design-system
description: The Matrix OS visual language — colors, typography, icons, animations, and component patterns. Apply this every time you build, redesign, or polish any Matrix OS surface.
version: 2.1.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
metadata:
  agent:
    tags: [Matrix OS, design, UI, brand, theme, colors, typography, icons, animations]
    related_skills: [matrix-app-builder]
---

# Matrix OS Design System

## When to Use

Apply this for ALL visual work on Matrix OS: building apps, redesigning the shell, creating landing pages, generating icons, or polishing UI. This is the single source of truth.

## Brand

"Technology that understands you." Matrix OS is a personal cloud computer — warm, calm, crafted. The visual language draws from natural materials (forest, sand, ember).

## Color Palette

Four brand colors + warm sand shades for gradient depth:

| Name       | Hex       | CSS Variable    | Role                                        |
|------------|-----------|-----------------|---------------------------------------------|
| Forest     | `#434E3F` | `--primary`     | Primary brand, headers, buttons, structure   |
| Cream      | `#E0E1CA` | `--secondary`   | Warm surfaces, hover states, secondary fills |
| Ember      | `#D06F25` | `--accent`      | CTAs, highlights — ONE per view max          |
| Deep       | `#32352E` | `--foreground`  | Primary text, depth, grounding               |
| Sand Light | `#F7F1E7` | `--sand-light`  | Gradient backgrounds                         |
| Sand Mid   | `#F3EAE0` | `--sand-mid`    | Gradient backgrounds                         |
| Sand Warm  | `#D6AB8B` | `--sand-warm`   | Warm accents, gradient endpoints             |

### UI Tokens

```css
:root {
  --app-bg: var(--matrix-bg, #FAFAF9);
  --app-fg: var(--matrix-fg, #32352E);
  --app-card: var(--matrix-card, #FCFCF8);
  --app-primary: var(--matrix-primary, #434E3F);
  --app-primary-fg: var(--matrix-primary-fg, #FAFAF5);
  --app-accent: var(--matrix-accent, #D06F25);
  --app-accent-fg: var(--matrix-accent-fg, #FAFAF5);
  --app-muted: var(--matrix-muted, #E1E1D0);
  --app-muted-fg: var(--matrix-muted-fg, #747668);
  --app-border: var(--matrix-border, #D8D6C7);
  --app-success: var(--matrix-success, #3A7D44);
  --app-warning: var(--matrix-warning, #E0A12E);
  --app-danger: var(--matrix-destructive, #D74A3A);
}
```

Use `--matrix-*` directly or define `--app-*` aliases from them. Do not replace inherited tokens with app-local blue, green, purple, or novelty palettes unless the user explicitly asks for branded customization.

### Color Rules

1. **One Ember per view.** Multiple uses = visual noise.
2. **Forest is structural.** Headers, primary buttons, nav active states.
3. **Cream is warmth.** Secondary fills, hover states.
4. **Deep is text.** Never use pure black `#000000`.
5. **Backgrounds inherit the active theme.** Quiet solid surfaces are the default for content. Use gradients only when the chosen art direction calls for depth; do not hardcode a light wash over dark mode.
6. **Shadows always use Deep-tinted** `rgba(50,53,46,X)`, never pure black.

### Optional depth

Use token-derived shadows and surfaces to explain hierarchy. Glass, gradients, and
texture are optional treatments for a specific purpose, never a required app backdrop.

## Typography

Inherit `var(--matrix-font-sans, system-ui, sans-serif)` for UI and
`var(--matrix-font-mono, monospace)` for code. Do not load remote fonts or force a display
font on app headings. Create hierarchy through size, weight, leading, and spacing.
Use tabular numerals for aligned data; constrain prose measure for comfortable reading.

### Type Scale

| Level      | Font     | Size      | Weight |
|------------|----------|-----------|--------|
| Display    | Inherited | 3rem+     | 700-800|
| H1         | Inherited | 2.25rem   | 600    |
| H2         | Inherited | 1.75rem   | 600    |
| H3         | Inherited | 1.25rem   | 600    |
| H4         | Inherited | 1.125rem  | 600    |
| Body       | Inherited | 1rem      | 400    |
| Small      | Inherited | 0.875rem  | 400    |
| Caption    | Inherited | 0.75rem   | 400    |
| Label      | Inherited | 0.65rem   | 600    |

Keep labels readable at normal text sizes; use uppercase and tracking sparingly for short section labels.

## Shapes

| Element   | Border Radius | Notes                        |
|-----------|---------------|------------------------------|
| Buttons   | 6-12px        | Match control density; pills optional |
| Inputs    | 6-12px        | Keep forms compact and legible |
| Cards     | 22px          | Soft rounded                 |
| Inner UI  | 14-16px       | Nested elements              |
| Badges    | 9999px        | Perfect pill                 |
| Icons bg  | 14px          | Icon containers in stat cards|

Choose a coherent radius scale for the app. Dense tables and editors may use square regions; cards and dialogs can be softer.

### Shadows

| Level | Value                                    | Use For                |
|-------|------------------------------------------|------------------------|
| sm    | `0 2px 4px rgba(50,53,46,0.06)`         | Cards at rest          |
| md    | `0 4px 12px rgba(50,53,46,0.08)`        | Hover, dropdowns       |
| lg    | `0 8px 24px rgba(50,53,46,0.10)`        | Floating panels        |

### Glass-morphism

```css
background: rgba(255, 255, 255, 0.55);
backdrop-filter: blur(12px);
border: 1px solid rgba(214, 211, 200, 0.35);
```

## Icons

Use inline SVG or bundled local icon assets only. Do not load icon scripts, CDNs, remote fonts, or third-party JavaScript from generated apps.

Generated launcher icons use the gateway/kernel icon style. The default comes from `system/desktop.json` when present, otherwise the Matrix OS style: light premium iOS/macOS skeuomorphic artwork, warm off-white or pale pastel background, forest/cream/ember/deep accents, one large tactile object, no text/logos/watermarks, no transparent or black dock backgrounds, no empty padding. The Matrix shell owns the final corner radius, so do not bake a visible frame into the artwork.

Usage: inline an accessible SVG with `aria-hidden="true"` for decorative icons, or pair the icon button with an `aria-label`.

| Purpose          | Set            | Prefix           | Examples                             |
|------------------|----------------|------------------|--------------------------------------|
| UI controls      | Lucide         | `lucide:`        | `lucide:search`, `lucide:plus`, `lucide:x` |
| Weather          | Meteocons      | `meteocons:`     | `meteocons:clear-day-fill`           |
| Loading/spinners | SVG Spinners   | `svg-spinners:`  | `svg-spinners:ring-resize`           |
| Brand logos      | Simple Icons   | `simple-icons:`  | `simple-icons:gmail`                 |
| File types       | Catppuccin     | `catppuccin:`    | `catppuccin:typescript`              |
| Flags            | Circle Flags   | `circle-flags:`  | `circle-flags:se`                    |
| Decorative       | Fluent Emoji   | `fluent-emoji:`  | `fluent-emoji:waving-hand`           |

Default to simple line-style SVGs for all UI. Only use specialist bundled assets when the context is obvious.

**NEVER use text characters as icons.** No `+`, `×`, `→`, `✓`. Use inline SVG or a bundled local asset; text characters have unpredictable baselines and never center properly.

## Animations

Read the installed `emil-design-eng` and `apple-design` skills; see the builder’s
`references/app-craft.md` for the shared process. Motion serves feedback, continuity,
or a spatial relationship. Frequency comes first: keep typing, keyboard actions, and
repeated navigation immediate. Do not stagger all content on page mount.

Use short ease-out transitions for occasional entry/exit, anchored to the trigger for
popovers. Prefer transform/opacity; never `transition: all`. Springs are for continuous,
interruptible gestures. Avoid decorative bounce and hover lift on every control.

```css
.action { transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1); }
.action:active { transform: scale(0.97); }
@media (prefers-reduced-motion: reduce) {
  .action { transition: none; }
  .action:active { transform: none; }
}
```

Preserve visible focus and immediate non-motion feedback. Gate hover treatments behind
`(hover: hover) and (pointer: fine)`. Use stable placeholders for loading, announce status
accessibly, and never delay ready content to finish a shimmer or entrance. Render true
progress rather than animating invented progress from zero on mount.

## Component Patterns

Use shadcn-style primitives for app interiors whenever the repo already exposes
them: Button, Card, Input, Select, Tabs, Tooltip, Badge, Dialog, and related
unstyled composition helpers. Skin those primitives with Matrix tokens instead
of inventing one-off controls.


### Buttons

```css
.btn { padding: 10px 24px; border-radius: 50px; font-family: 'Inter'; font-size: 0.875rem; font-weight: 500; transition: all 0.2s; }
```

| Variant   | Background  | Text          |
|-----------|-------------|---------------|
| Primary   | `--primary` | `--primary-fg`|
| Accent    | `--accent`  | white         |
| Secondary | transparent | `--fg`        |
| Ghost     | transparent | `--fg`        |
| Cream     | `--secondary`| `--fg`       |

### Cards

```css
.card { background: rgba(255,255,255,0.55); backdrop-filter: blur(12px); border: 1px solid rgba(214,211,200,0.35); border-radius: 22px; padding: 20px; }
```

**Stat cards use horizontal layout** — icon container (46px, gradient bg, 14px radius) + text (label, value, subtitle) side by side. Never stack vertically with empty whitespace.

### Inputs

```css
.input { background: rgba(255,255,255,0.8); border: 1.5px solid rgba(214,211,200,0.6); border-radius: 50px; padding: 13px 22px; }
.input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(67,78,63,0.06); background: rgba(255,255,255,0.95); }
```

## Common Pitfalls (non-negotiable)

**Never use text characters as icons.** `+`, `×`, `→`, `✓` will never center. Use inline SVG or bundled local assets.

**Always center icon buttons with flexbox.** `display:flex; align-items:center; justify-content:center`.

**Components must fill space intentionally.** No cards with 80% empty whitespace and tiny text in one corner. Use horizontal layouts for compact cards.

**Touch targets: minimum 36×36px.** Even if the icon is 16px.

**Text overflow.** Use `overflow:hidden; text-overflow:ellipsis; white-space:nowrap` on single-line text in constrained containers.

**All inputs need visible focus states.** Never just `outline:none`.

**All buttons need hover + active states.** No flat state-free buttons.

**Don't mix border-radius values** on adjacent elements.

## Verification

- No horizontal overflow in small windows
- No text characters used as icons (search for `>×</`, `>+</`)
- All icon buttons visually centered
- No components with excessive empty whitespace
- Theme-aware surfaces and task-appropriate control shapes
- Purposeful, interruptible motion with reduced-motion support
- All inputs have focus states, all buttons have hover states
- Inherited fonts with clear hierarchy and legible labels
- One Ember accent maximum per view
