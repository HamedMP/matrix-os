---
name: matrix-design-system
description: The Matrix OS visual language — colors, typography, icons, animations, and component patterns. Apply this every time you build, redesign, or polish any Matrix OS surface.
version: 2.0.0
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
  --matrix-bg: #FAFAF5;
  --app-bg: #FAFAF5;
  --bg: #FAFAF5;
  --fg: #32352E;
  --primary: #434E3F;
  --primary-fg: #FAFAF5;
  --accent: #D06F25;
  --accent-fg: #FFFFFF;
  --secondary: #E0E1CA;
  --muted: #F0EDE4;
  --muted-fg: #7A7768;
  --card: #FFFFFF;
  --border: #D6D3C8;
  --sand-light: #F7F1E7;
  --sand-mid: #F3EAE0;
  --sand-warm: #D6AB8B;
  --destructive: #C4342D;
  --success: #3A7D44;
  --warning: #D49B2A;
}
```

### Color Rules

1. **One Ember per view.** Multiple uses = visual noise.
2. **Forest is structural.** Headers, primary buttons, nav active states.
3. **Cream is warmth.** Secondary fills, hover states.
4. **Deep is text.** Never use pure black `#000000`.
5. **Backgrounds are GRADIENT**, not flat — blend sand shades (`#F7F1E7`, `#F3EAE0`, `#D6AB8B`).
6. **Shadows always use Deep-tinted** `rgba(50,53,46,X)`, never pure black.

### Gradient Backgrounds

```css
/* App page background — warm sand wash */
background: linear-gradient(170deg, #F7F1E7 0%, #F3EAE0 30%, #F7F3ED 60%, #F7F1E7 100%);

/* Section with depth */
background: linear-gradient(165deg, #E0E1CA 0%, #FAFAF5 50%, rgba(208,111,37,0.05) 100%);

/* Dark section */
background: linear-gradient(135deg, #32352E 0%, #434E3F 40%, #D6AB8B 100%);
```

## Typography

| Role     | Font           | Usage                                                   |
|----------|----------------|---------------------------------------------------------|
| Display  | Orbitron       | H1/H2 only — page titles, hero headings, large stat numbers |
| UI/Body  | Inter          | Everything else — H3+ subtitles, body, buttons, labels, nav, card titles |
| Code     | JetBrains Mono | Terminal, code blocks, technical data                   |

**Orbitron is minimal.** Only H1/H2 display headings and large metric numbers. Never for subtitles (H3+), card titles, descriptions, button labels, or anything below 16px.

### Type Scale

| Level      | Font     | Size      | Weight |
|------------|----------|-----------|--------|
| Display    | Orbitron | 3rem+     | 700-800|
| H1         | Orbitron | 2.25rem   | 600    |
| H2         | Orbitron | 1.75rem   | 600    |
| H3         | Inter    | 1.25rem   | 600    |
| H4         | Inter    | 1.125rem  | 600    |
| Body       | Inter    | 1rem      | 400    |
| Small      | Inter    | 0.875rem  | 400    |
| Caption    | Inter    | 0.75rem   | 400    |
| Label      | Inter    | 0.65rem   | 600    |

Labels: `letter-spacing: 0.15-0.25em; text-transform: uppercase`.

## Shapes

| Element   | Border Radius | Notes                        |
|-----------|---------------|------------------------------|
| Buttons   | 50px          | Full capsule, always         |
| Inputs    | 50px          | Full capsule                 |
| Cards     | 22px          | Soft rounded                 |
| Inner UI  | 14-16px       | Nested elements              |
| Badges    | 9999px        | Perfect pill                 |
| Icons bg  | 14px          | Icon containers in stat cards|

No sharp corners anywhere in Matrix OS.

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

Load via Iconify CDN — one script tag for every icon set:

```html
<script src="https://code.iconify.design/iconify-icon/2.3.0/iconify-icon.min.js"></script>
```

Usage: `<iconify-icon icon="lucide:settings" width="20"></iconify-icon>`

| Purpose          | Set            | Prefix           | Examples                             |
|------------------|----------------|------------------|--------------------------------------|
| UI controls      | Lucide         | `lucide:`        | `lucide:search`, `lucide:plus`, `lucide:x` |
| Weather          | Meteocons      | `meteocons:`     | `meteocons:clear-day-fill`           |
| Loading/spinners | SVG Spinners   | `svg-spinners:`  | `svg-spinners:ring-resize`           |
| Brand logos      | Simple Icons   | `simple-icons:`  | `simple-icons:gmail`                 |
| File types       | Catppuccin     | `catppuccin:`    | `catppuccin:typescript`              |
| Flags            | Circle Flags   | `circle-flags:`  | `circle-flags:se`                    |
| Decorative       | Fluent Emoji   | `fluent-emoji:`  | `fluent-emoji:waving-hand`           |

Default to `lucide:` for all UI. Only use specialist sets when the context is obvious.

**NEVER use text characters as icons.** No `+`, `×`, `→`, `✓`. Always use Iconify — text characters have unpredictable baselines and never center properly.

## Animations

Clean and subtle — barely noticed but deeply felt.

### Page Mount — Staggered Fade Up

```css
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-in { animation: fadeUp 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) both; }
/* Stagger children: 60ms gap */
.stagger > :nth-child(1) { animation-delay: 0s; }
.stagger > :nth-child(2) { animation-delay: 0.06s; }
.stagger > :nth-child(3) { animation-delay: 0.12s; }
/* ...continue pattern */
```

### Hover — Lift

```css
.hoverable:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(50,53,46,0.08); }
.hoverable:active { transform: translateY(0); }
```

### Skeleton Loading — Warm Shimmer

```css
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.skeleton {
  background: linear-gradient(90deg, var(--muted) 25%, #F7F1E7 50%, var(--muted) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.8s ease-in-out infinite;
  border-radius: 10px;
}
```

### Progress Bars

Animate width from 0 to target on mount: `transition: width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)`.

### Rules

- Page load = one orchestrated wave (stagger all top-level elements)
- Hover lift on every clickable card and button
- Loading always uses warm-tinted skeletons, never blank space
- Spinners: `svg-spinners:ring-resize`, never custom
- Always respect `prefers-reduced-motion`

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

**Never use text characters as icons.** `+`, `×`, `→`, `✓` will never center. Always `<iconify-icon icon="lucide:plus">`.

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
- Gradient backgrounds, not flat colors
- Capsule-rounded buttons and inputs
- Stagger animation on page mount
- All inputs have focus states, all buttons have hover states
- Orbitron only on H1/H2, Inter everywhere else
- One Ember accent maximum per view
