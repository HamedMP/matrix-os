# Matrix OS Design System

Comprehensive design token reference for building apps, modules, and UI within Matrix OS. This is the single source of truth for visual language -- every app, game, and tool must follow these tokens and patterns.

Brand: "Technology that understands you." Warm, calm, personal. The visual language draws from natural materials (forest, sand, ember).

## CSS Variable Reference

The shell injects `--matrix-*` variables into app iframes via the bridge. Apps that use these variables automatically adapt to user theme changes.

### Core Colors

| Variable                | Default   | Description                                  |
| ----------------------- | --------- | -------------------------------------------- |
| `--matrix-bg`           | `#FAFAF5` | Page background (warm off-white)             |
| `--matrix-fg`           | `#32352E` | Primary text (Deep -- never pure black)      |
| `--matrix-card`         | `#FFFFFF` | Card/panel surfaces                          |
| `--matrix-card-fg`      | `#32352E` | Text on cards                                |
| `--matrix-primary`      | `#434E3F` | Primary brand (Forest). Buttons, structure   |
| `--matrix-primary-fg`   | `#FAFAF5` | Text on primary elements                     |
| `--matrix-secondary`    | `#E0E1CA` | Secondary surfaces (Cream). Warm fills       |
| `--matrix-secondary-fg` | `#32352E` | Text on secondary surfaces                   |
| `--matrix-muted`        | `#F0EDE4` | Muted backgrounds, disabled states           |
| `--matrix-muted-fg`     | `#7A7768` | De-emphasized text                           |
| `--matrix-border`       | `#D6D3C8` | Borders, dividers (warm gray)                |
| `--matrix-input`        | `#D6D3C8` | Input field borders                          |
| `--matrix-ring`         | `#434E3F` | Focus ring color (Forest)                    |
| `--matrix-accent`       | `#D06F25` | Accent / CTA (Ember). ONE per view max       |
| `--matrix-accent-fg`    | `#FFFFFF` | Text on accent elements                      |
| `--matrix-popover`      | `#FFFFFF` | Dropdown/tooltip surfaces                    |
| `--matrix-popover-fg`   | `#32352E` | Text in popovers                             |

### Sand Shades (for gradient depth)

| Variable                | Default   | Description                          |
| ----------------------- | --------- | ------------------------------------ |
| `--matrix-sand-light`   | `#F7F1E7` | Gradient backgrounds, light end      |
| `--matrix-sand-mid`     | `#F3EAE0` | Gradient backgrounds, mid tone       |
| `--matrix-sand-warm`    | `#D6AB8B` | Warm gradient endpoints, accents     |

### Semantic Colors

| Variable               | Default   | Description                    |
| ---------------------- | --------- | ------------------------------ |
| `--matrix-destructive` | `#C4342D` | Errors, delete actions, danger |
| `--matrix-success`     | `#3A7D44` | Positive states, confirmations |
| `--matrix-warning`     | `#D49B2A` | Warnings, caution states       |

### Color Rules

1. **One Ember accent per view.** Multiple Ember elements = visual noise.
2. **Forest is structural.** Headers, primary buttons, nav active states, icons.
3. **Cream is warmth.** Secondary fills, hover states, sidebar backgrounds.
4. **Deep is text.** Never use pure black `#000000`.
5. **Backgrounds are GRADIENT, not flat.** Blend sand shades for warmth.
6. **Shadows use Deep-tinted** `rgba(50,53,46,X)`, never pure black.

### Gradient Backgrounds

```css
/* App page background — warm sand wash (DEFAULT for all apps) */
background: linear-gradient(170deg, #F7F1E7 0%, #F3EAE0 30%, #F7F3ED 60%, #F7F1E7 100%);

/* Section with depth */
background: linear-gradient(165deg, #E0E1CA 0%, #FAFAF5 50%, rgba(208,111,37,0.05) 100%);

/* Dark section / hero card */
background: linear-gradient(135deg, #32352E 0%, #434E3F 40%, #D6AB8B 100%);
```

## Typography

### Font Stack

| Variable                 | Default                             | Description                                    |
| ------------------------ | ----------------------------------- | ---------------------------------------------- |
| `--matrix-font-sans`     | `"Inter", system-ui, sans-serif`    | Body, UI, labels, subtitles, card titles       |
| `--matrix-font-display`  | `"Orbitron", system-ui, sans-serif` | H1/H2 display headings and large stat numbers  |
| `--matrix-font-mono`     | `"JetBrains Mono", monospace`       | Code, data, terminal                           |

### Orbitron Rules (CRITICAL)

Orbitron is the Matrix OS brand typeface. Use it **minimally**:

- **Use for:** H1, H2 display headings, large metric/stat numbers (1.5rem+)
- **NEVER use for:** subtitles (H3+), card titles, descriptions, button labels, navigation, form labels, body text, or anything below 16px
- **H3 and below are ALWAYS Inter weight 600.**

### Type Scale

| Level      | Font     | Size      | Weight | Usage                            |
| ---------- | -------- | --------- | ------ | -------------------------------- |
| Display    | Orbitron | 3rem+     | 700-800| Hero headlines only              |
| H1         | Orbitron | 2.25rem   | 600    | Page titles                      |
| H2         | Orbitron | 1.75rem   | 600    | Section headings                 |
| H3         | Inter    | 1.25rem   | 600    | Subtitles, subsections           |
| H4         | Inter    | 1.125rem  | 600    | Card titles, group labels        |
| Body       | Inter    | 1rem      | 400    | Paragraphs, descriptions         |
| Small      | Inter    | 0.875rem  | 400    | Secondary text, metadata         |
| Caption    | Inter    | 0.75rem   | 400    | Timestamps, footnotes            |
| Label      | Inter    | 0.65rem   | 600    | Uppercase tags, section markers  |

Labels: `letter-spacing: 0.15-0.25em; text-transform: uppercase`.

### Fonts In Apps

Use inherited shell font tokens in app CSS: `var(--matrix-font-sans, Inter, system-ui, sans-serif)` and `var(--matrix-font-mono, "JetBrains Mono", monospace)`. Do not load remote font stylesheets from generated apps; sandboxed apps should stay self-contained and CSP-friendly.

## Shapes

| Element   | Border Radius | Notes                        |
|-----------|---------------|------------------------------|
| Buttons   | 50px          | Full capsule, always         |
| Inputs    | 50px          | Full capsule                 |
| Cards     | 22px          | Soft rounded                 |
| Inner UI  | 14-16px       | Nested elements, icon bgs    |
| Badges    | 9999px        | Perfect pill                 |

No sharp corners anywhere in Matrix OS.

### Shadows

| Level | Value                                    | Use For                |
|-------|------------------------------------------|------------------------|
| sm    | `0 2px 4px rgba(50,53,46,0.06)`         | Cards at rest          |
| md    | `0 4px 12px rgba(50,53,46,0.08)`        | Hover, dropdowns       |
| lg    | `0 8px 24px rgba(50,53,46,0.10)`        | Floating panels        |

### Glass-morphism

For cards and floating elements:

```css
background: rgba(255, 255, 255, 0.55);
backdrop-filter: blur(12px);
border: 1px solid rgba(214, 211, 200, 0.35);
border-radius: 22px;
```

## Icons

Use inline SVG or bundled local icon assets only. Do not load icon scripts, CDNs, remote fonts, or third-party JavaScript from generated apps.

Generated launcher icons use the gateway/kernel icon style. The default comes from `system/desktop.json` when present, otherwise the Matrix OS style: light premium iOS/macOS skeuomorphic artwork, warm off-white or pale pastel background, forest/cream/ember/deep accents, one large tactile object, no text/logos/watermarks, no transparent or black dock backgrounds, no empty padding. The Matrix shell owns the final corner radius, so do not bake a visible frame into the artwork.

Usage: inline an accessible SVG with `aria-hidden="true"` for decorative icons, or pair the icon button with an `aria-label`.

| Purpose          | Set            | Prefix           | Examples                             |
|------------------|----------------|------------------|--------------------------------------|
| UI controls      | Lucide         | `lucide:`        | `lucide:search`, `lucide:plus`, `lucide:x` |
| Weather          | Meteocons      | `meteocons:`     | `meteocons:clear-day-fill`, `meteocons:rain` |
| Loading/spinners | SVG Spinners   | `svg-spinners:`  | `svg-spinners:ring-resize`           |
| Brand logos      | Simple Icons   | `simple-icons:`  | `simple-icons:gmail`, `simple-icons:github` |
| File types       | Catppuccin     | `catppuccin:`    | `catppuccin:typescript`              |
| Flags            | Circle Flags   | `circle-flags:`  | `circle-flags:se`                    |
| Decorative       | Fluent Emoji   | `fluent-emoji:`  | `fluent-emoji:waving-hand`           |

Default to simple line-style SVGs for all UI icons. Only use specialist bundled assets when the domain is obvious.

**NEVER use text characters as icons.** No `+`, `×`, `→`, `✓`, `⚙`. Text characters have unpredictable baselines and never center properly. Use inline SVG or a bundled local asset.

## Animation

### Timing

| Type  | Duration  | Easing                                    | Usage                                |
| ----- | --------- | ----------------------------------------- | ------------------------------------ |
| Micro | 100-150ms | ease                                      | Button press, toggle                 |
| Enter | 200-300ms | ease-out                                  | Panel open, fade-in                  |
| Exit  | 150-200ms | ease-in                                   | Panel close, dismiss                 |
| Move  | 200-300ms | cubic-bezier(0.25, 0.46, 0.45, 0.94)    | Reposition, slide                    |

Never exceed 500ms. Always respect `prefers-reduced-motion`.

### Page Mount — Staggered Fade Up (signature animation)

```css
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-in { animation: fadeUp 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) both; }
/* Stagger: 60ms gap between siblings */
.stagger > :nth-child(1) { animation-delay: 0s; }
.stagger > :nth-child(2) { animation-delay: 0.06s; }
.stagger > :nth-child(3) { animation-delay: 0.12s; }
.stagger > :nth-child(4) { animation-delay: 0.18s; }
.stagger > :nth-child(5) { animation-delay: 0.24s; }
```

### Hover Lift (all clickable elements)

```css
.hoverable { transition: transform 0.2s ease, box-shadow 0.2s ease; }
.hoverable:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(50,53,46,0.08); }
.hoverable:active { transform: translateY(0); transition-duration: 0.1s; }
```

### Skeleton Loading — Warm Shimmer

```css
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.skeleton {
  background: linear-gradient(90deg, var(--matrix-muted) 25%, #F7F1E7 50%, var(--matrix-muted) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.8s ease-in-out infinite;
  border-radius: 10px;
}
```

Use warm sand tones in the shimmer, not gray or white.

### Progress Bars

```css
.progress-fill { transition: width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94); }
```

Animate width from 0 to target on mount.

### Animation Rules

- Page load = one orchestrated wave (stagger all top-level elements)
- Hover lift on every clickable card and button
- Loading always uses warm-tinted skeletons, never blank space
- Spinners: use a local CSS/SVG spinner, never a remote script
- Reduced motion fallback is mandatory

## Component Patterns

### Buttons

Capsule-shaped with clear hierarchy:

```css
button {
  padding: 10px 24px;
  border-radius: 50px;
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 0.875rem;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
}
button:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(50,53,46,0.1); }
```

| Variant    | Background                  | Text              |
|------------|-----------------------------|--------------------|
| Primary    | `var(--matrix-primary)`     | `var(--matrix-primary-fg)` |
| Accent CTA | `var(--matrix-accent)`     | white              |
| Secondary  | transparent + border        | `var(--matrix-fg)` |
| Ghost      | transparent                 | `var(--matrix-fg)` |
| Cream      | `var(--matrix-secondary)`   | `var(--matrix-fg)` |

### Cards

Glass card with gradient background showing through:

```css
.card {
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(214, 211, 200, 0.35);
  border-radius: 22px;
  padding: 20px;
  transition: transform 0.2s, box-shadow 0.2s;
}
.card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(50,53,46,0.06); }
```

**Stat cards must use horizontal layout** — icon container (46px, gradient bg, 14px radius) + text block (label, value, subtitle) side by side. Never stack vertically with empty whitespace.

### Inputs

```css
input, select {
  background: rgba(255, 255, 255, 0.8);
  border: 1.5px solid rgba(214, 211, 200, 0.6);
  border-radius: 50px;
  padding: 13px 22px;
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 0.875rem;
  outline: none;
  transition: all 0.2s;
}
input:focus, select:focus {
  border-color: var(--matrix-primary);
  box-shadow: 0 0 0 3px rgba(67, 78, 63, 0.06);
  background: rgba(255, 255, 255, 0.95);
}
```

### Icon Buttons

Always use flexbox centering and inline SVG or bundled local icons:

```css
.icon-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--matrix-primary);
  color: var(--matrix-primary-fg);
  border: none;
  cursor: pointer;
}
```

```html
<button class="icon-btn" aria-label="Add">
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
  </svg>
</button>
```

## Common Pitfalls (non-negotiable)

1. **Never use text characters as icons.** `+`, `×`, `→`, `✓` never center. Use inline SVG or bundled local assets.
2. **Always center icon buttons with flexbox.** `display:flex; align-items:center; justify-content:center`.
3. **Components must fill space intentionally.** No empty whitespace corners. Use horizontal layouts for compact stat/info cards.
4. **Touch targets: minimum 36×36px.** Even if the icon is 16px.
5. **Text overflow:** `overflow:hidden; text-overflow:ellipsis; white-space:nowrap` on single-line text.
6. **All inputs need visible focus states.** Never just `outline:none` with no replacement.
7. **All buttons need hover + active states.** No flat state-free buttons.
8. **Don't mix border-radius values** on adjacent elements.
9. **Backgrounds must be gradient**, not flat. Use the sand wash as default.
10. **Orbitron only for H1/H2.** Subtitles, card titles, and everything else use Inter.

## Bridge API Patterns

### Structured Data (Postgres-backed)

Apps with `storage.tables` in `matrix.json` use `MatrixOS.db`:

```javascript
const rows = await MatrixOS.db.find('tasks', { filter: { done: false }, orderBy: { created_at: 'desc' } });
const { id } = await MatrixOS.db.insert('tasks', { text: 'Buy milk', done: false });
await MatrixOS.db.update('tasks', id, { done: true });
await MatrixOS.db.delete('tasks', id);
MatrixOS.db.onChange('tasks', () => loadData());
```

### Theme Integration

Apps receive theme variables via the bridge:

```javascript
const theme = window.MatrixOS?.theme;
window.addEventListener('message', (e) => {
  if (e.data?.type === 'os:theme-update') {
    // Variables already updated in injected <style>
  }
});
```
