# Matrix OS Design System

Comprehensive design token reference for building apps, modules, and UI within Matrix OS. This is the single source of truth for visual language -- every app, game, and tool should draw from these tokens.

## CSS Variable Reference

The shell injects `--matrix-*` variables into app iframes via the bridge. Apps that use these variables automatically adapt to user theme changes.

### Core Colors

| Variable                | Default   | Description                                               |
| ----------------------- | --------- | --------------------------------------------------------- |
| `--matrix-bg`           | `#ece5f0` | Page/canvas background (lavender)                         |
| `--matrix-fg`           | `#1c1917` | Primary text (warm black)                                 |
| `--matrix-card`         | `#ffffff` | Card/panel surfaces                                       |
| `--matrix-card-fg`      | `#1c1917` | Text on cards                                             |
| `--matrix-primary`      | `#c2703a` | Primary accent -- terracotta. Buttons, links, focus rings |
| `--matrix-primary-fg`   | `#ffffff` | Text on primary-colored elements                          |
| `--matrix-secondary`    | `#f0eaf4` | Secondary surfaces (light lavender tint)                  |
| `--matrix-secondary-fg` | `#44403c` | Text on secondary surfaces                                |
| `--matrix-muted`        | `#f0eaf4` | Muted/subtle backgrounds                                  |
| `--matrix-muted-fg`     | `#78716c` | De-emphasized text (warm gray)                            |
| `--matrix-border`       | `#d8d0de` | Borders, dividers (lavender tint)                         |
| `--matrix-input`        | `#d8d0de` | Input field borders                                       |
| `--matrix-ring`         | `#c2703a` | Focus ring color (matches primary)                        |
| `--matrix-accent`       | `#f0eaf4` | Highlight/hover backgrounds                               |
| `--matrix-accent-fg`    | `#44403c` | Text on accent backgrounds                                |
| `--matrix-popover`      | `#ffffff` | Dropdown/tooltip surfaces                                 |
| `--matrix-popover-fg`   | `#1c1917` | Text in popovers                                          |

### Semantic Colors

| Variable               | Default   | Description                    |
| ---------------------- | --------- | ------------------------------ |
| `--matrix-destructive` | `#ef4444` | Errors, delete actions, danger |
| `--matrix-success`     | `#22c55e` | Positive states, confirmations |
| `--matrix-warning`     | `#eab308` | Warnings, caution states       |

### Surface Hierarchy

Three levels of elevation, from lowest to highest:

1. **Background** (`--matrix-bg`): The canvas. Lavender `#ece5f0` by default.
2. **Card** (`--matrix-card`): Content panels sitting on the canvas. White `#ffffff`.
3. **Elevated/Popover** (`--matrix-popover`): Floating elements -- tooltips, dropdowns, modals. White with `backdrop-blur` and shadow.

Use increasing shadow depth to reinforce the hierarchy:

- Background: no shadow
- Card: `box-shadow: 0 1px 3px rgba(0,0,0,0.08)`
- Elevated: `box-shadow: 0 10px 25px rgba(0,0,0,0.12)`

### Typography

| Variable             | Default                          | Description          |
| -------------------- | -------------------------------- | -------------------- |
| `--matrix-font-sans` | `"Inter", system-ui, sans-serif` | Body and UI text     |
| `--matrix-font-mono` | `"JetBrains Mono", monospace`    | Code, data, terminal |
| `--matrix-radius`    | `0.75rem`                        | Base border-radius   |

### Radius Tokens

| Token                | Value                              | Usage                          |
| -------------------- | ---------------------------------- | ------------------------------ |
| `--matrix-radius-sm` | `calc(var(--matrix-radius) - 4px)` | Small chips, tags              |
| `--matrix-radius-md` | `calc(var(--matrix-radius) - 2px)` | Inputs, small buttons          |
| `--matrix-radius-lg` | `var(--matrix-radius)`             | Cards, panels                  |
| `--matrix-radius-xl` | `calc(var(--matrix-radius) + 4px)` | Feature cards, floating panels |

## Color System

### Primary: Terracotta `#c2703a`

The signature color. Use for primary actions (buttons, links), focus rings, and accent highlights. Conveys warmth and distinction -- this is NOT a generic blue.

Terracotta glow for badges and highlights:

```css
background: rgba(194, 112, 58, 0.15);
```

### Background: Lavender `#ece5f0`

The canvas color. Soft, warm, organic. All content floats on this surface. Never replace with white or dark gray as the base.

### Foreground: Warm Black `#1c1917`

Not pure `#000000`. The warm undertone prevents harshness and matches the organic palette.

### Cards: White `#ffffff`

Clean card surfaces with subtle shadow create depth against the lavender canvas.

### Border: Lavender Tint `#d8d0de`

Subtle, not harsh. Borders should be barely visible -- structure without distraction.

### Semantic Rules

- **Success** (`#22c55e`): Use for completed states, confirmations, positive values
- **Warning** (`#eab308`): Use for caution states, approaching limits, attention needed
- **Error/Destructive** (`#ef4444`): Use for errors, delete confirmations, critical alerts
- Never use semantic colors as primary UI chrome -- they are for status communication only

## Typography

### Font Choices

The OS ships with Inter for UI text and JetBrains Mono for code. These are loaded via `next/font/google` in the shell with zero layout shift.

When building apps that load their own fonts (standalone HTML or Vite apps), use characterful alternatives. The following are BANNED as primary fonts because they produce generic, undifferentiated UI:

- Inter (already the shell font -- apps should inherit, not re-declare)
- Roboto
- Arial
- Helvetica
- Open Sans

For display headings in apps, consider distinctive options:

- **DM Serif Display** -- refined serif with personality
- **Space Grotesk** -- geometric sans with character
- **Sora** -- modern, warm, distinctive
- **Fraunces** -- soft serif, organic feel matching the palette
- **Outfit** -- geometric, clean, slightly playful

For body text, inherit `var(--matrix-font-sans)` or use:

- **Source Sans 3** -- professional, readable
- **Nunito Sans** -- rounded, friendly
- **Work Sans** -- geometric, versatile

### Type Scale

| Name        | Size            | Weight  | Usage                               |
| ----------- | --------------- | ------- | ----------------------------------- |
| `text-xs`   | 0.75rem (12px)  | 400     | Fine print, timestamps, metadata    |
| `text-sm`   | 0.875rem (14px) | 400-500 | Labels, secondary text, table cells |
| `text-base` | 1rem (16px)     | 400     | Body text, default                  |
| `text-lg`   | 1.125rem (18px) | 500     | Emphasized body, card titles        |
| `text-xl`   | 1.25rem (20px)  | 600     | Section subheadings                 |
| `text-2xl`  | 1.5rem (24px)   | 600-700 | Section headings                    |
| `text-3xl`  | 1.875rem (30px) | 700     | Page headings                       |
| `text-4xl`  | 2.25rem (36px)  | 700     | Large headings                      |
| `text-5xl`  | 3rem (48px)     | 700-800 | Hero text                           |
| `text-6xl`  | 3.75rem (60px)  | 800     | Display/splash text                 |

### Semantic Weights

- **Regular (400)**: Body text, descriptions
- **Medium (500)**: Labels, emphasized text, navigation items
- **Semibold (600)**: Headings, button text, card titles
- **Bold (700)**: Page headings, strong emphasis
- **Extrabold (800)**: Hero/display text only

### Monospace Labels

For technical indicators, status badges, and data labels:

```css
font-family: var(--matrix-font-mono);
font-size: 0.75rem;
letter-spacing: 0.05em;
text-transform: uppercase;
```

## Spacing

Based on a 4px grid. All spacing values are multiples of 4.

| Token | Value         | Usage                                               |
| ----- | ------------- | --------------------------------------------------- |
| `xs`  | 4px (0.25rem) | Tight gaps: icon-to-label, badge padding            |
| `sm`  | 8px (0.5rem)  | Small gaps: between related elements, input padding |
| `md`  | 16px (1rem)   | Standard gaps: card padding, section spacing        |
| `lg`  | 24px (1.5rem) | Large gaps: between cards, section padding          |
| `xl`  | 32px (2rem)   | Extra-large: page margins, major sections           |
| `2xl` | 48px (3rem)   | Hero spacing, page-level vertical rhythm            |

### Rules

- Inner padding: `md` (16px) for cards, `sm` (8px) for inputs and compact elements
- Gap between siblings: `sm` (8px) for tight lists, `md` (16px) for card grids
- Section spacing: `lg` (24px) to `xl` (32px)
- Page margins: `md` (16px) on mobile, `xl` (32px) on desktop

## Layout Patterns

### Card Grid

Responsive card layout that fills available space:

```css
display: grid;
grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
gap: 16px;
padding: 16px;
```

For smaller cards (tiles, thumbnails):

```css
grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
```

### Sidebar Layout

Fixed sidebar with scrollable content:

```css
.layout {
  display: flex;
  height: 100%;
}
.sidebar {
  width: 260px;
  border-right: 1px solid var(--matrix-border);
  overflow-y: auto;
}
.content {
  flex: 1;
  overflow-y: auto;
}
```

### Overlay/Modal

Centered overlay with backdrop:

```css
.overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  z-index: 50;
}
.dialog {
  background: var(--matrix-card);
  border-radius: var(--matrix-radius-xl);
  padding: 24px;
  max-width: 480px;
  width: 90%;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
}
```

### Responsive Breakpoints

| Breakpoint | Width  | Target                                    |
| ---------- | ------ | ----------------------------------------- |
| Mobile min | 320px  | Smallest supported width                  |
| Mobile     | 640px  | Phones (stack layouts, single column)     |
| Tablet     | 768px  | Tablets, small laptops (2-column layouts) |
| Desktop    | 1024px | Full desktop (multi-column, sidebars)     |

### Rules

- Design mobile-first: stack vertically, then expand
- Minimum app window: 300x200px
- Test at 320px width
- Use `min()` and `clamp()` for fluid sizing
- Touch targets: 44x44px minimum on mobile

## Animation

### Timing

| Type  | Duration  | Easing      | Usage                                   |
| ----- | --------- | ----------- | --------------------------------------- |
| Micro | 100ms     | ease-out    | Button press, toggle, checkbox          |
| Enter | 150ms     | ease-out    | Panel open, tooltip appear, fade-in     |
| Exit  | 100ms     | ease-in     | Panel close, tooltip dismiss            |
| Move  | 200-300ms | ease-in-out | Window reposition, slide transitions    |
| Page  | 300ms     | ease-out    | Route transitions, full-screen overlays |

### Rules

- Only animate `transform` and `opacity` for performance (triggers compositing, not layout)
- Never exceed 500ms
- Never use `linear` easing for UI transitions
- Respect `prefers-reduced-motion`: fall back to simple opacity fade

### Orchestrated Page Load

Stagger child elements on page mount for a polished entrance:

```css
.card {
  animation: fadeSlideUp 0.3s ease-out backwards;
}
.card:nth-child(1) {
  animation-delay: 0ms;
}
.card:nth-child(2) {
  animation-delay: 50ms;
}
.card:nth-child(3) {
  animation-delay: 100ms;
}
.card:nth-child(4) {
  animation-delay: 150ms;
}

@keyframes fadeSlideUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

### Scroll-Triggered Reveals

Use IntersectionObserver to trigger animations as elements scroll into view:

```javascript
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    });
  },
  { threshold: 0.1 },
);
```

### Hover Micro-interactions

Subtle scale and shadow on interactive cards:

```css
.card {
  transition:
    transform 0.15s ease-out,
    box-shadow 0.15s ease-out;
}
.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.1);
}
```

## Component Patterns

### Buttons

Four variants following the shell convention:

**Primary** (main actions):

```css
background: var(--matrix-primary);
color: var(--matrix-primary-fg);
border: none;
border-radius: var(--matrix-radius-md);
padding: 8px 20px;
font-weight: 600;
cursor: pointer;
transition: opacity 0.1s ease-out;
```

**Secondary/Outline** (secondary actions):

```css
background: transparent;
color: var(--matrix-fg);
border: 1px solid var(--matrix-border);
border-radius: var(--matrix-radius-md);
padding: 8px 20px;
```

**Ghost** (tertiary, contextual):

```css
background: transparent;
color: var(--matrix-fg);
border: none;
padding: 8px 20px;
```

On hover: `background: var(--matrix-accent);`

**Destructive** (danger actions):

```css
background: var(--matrix-destructive);
color: #ffffff;
```

### Inputs

```css
input,
select,
textarea {
  padding: 8px 12px;
  background: var(--matrix-card);
  color: var(--matrix-fg);
  border: 1px solid var(--matrix-input);
  border-radius: var(--matrix-radius-md);
  font-size: 0.875rem;
  font-family: var(--matrix-font-sans);
  transition: border-color 0.15s ease-out;
}
input:focus {
  outline: none;
  border-color: var(--matrix-ring);
  box-shadow: 0 0 0 2px rgba(194, 112, 58, 0.2);
}
```

### Cards

```css
.card {
  background: var(--matrix-card);
  border: 1px solid var(--matrix-border);
  border-radius: var(--matrix-radius-lg);
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
```

Glass-morphism variant for floating cards:

```css
.card-glass {
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(8px);
  border: 1px solid var(--matrix-border);
  border-radius: var(--matrix-radius-xl);
}
```

### Modals / Dialogs

- Dark overlay backdrop with blur
- Centered dialog with `--matrix-radius-xl` corners
- Title + content + actions footer
- Close via X button, Escape key, and backdrop click
- Focus trap within the dialog
- Entry: fade + scale from 0.95
- Exit: fade + scale to 0.95

### Empty States

Every view must handle the empty case. Pattern:

```html
<div
  style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:48px 24px; text-align:center; color:var(--matrix-muted-fg);"
>
  <svg><!-- icon, 48x48, stroke style --></svg>
  <h3 style="margin:16px 0 8px; color:var(--matrix-fg); font-weight:600;">
    No items yet
  </h3>
  <p style="margin:0 0 16px; max-width:280px;">
    Get started by creating your first item.
  </p>
  <button class="btn-primary">Create Item</button>
</div>
```

### Loading States

**Skeleton/shimmer**: For content that is loading:

```css
.skeleton {
  background: linear-gradient(
    90deg,
    var(--matrix-muted) 25%,
    var(--matrix-secondary) 50%,
    var(--matrix-muted) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--matrix-radius-md);
}
@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}
```

**Spinner**: For actions in progress:

```css
.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--matrix-border);
  border-top-color: var(--matrix-primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
```

## Accessibility

### Focus Visible

Use `:focus-visible` for keyboard-only focus rings (not on mouse click):

```css
:focus-visible {
  outline: 2px solid var(--matrix-ring);
  outline-offset: 2px;
}
```

### Touch Targets

Minimum 44x44px for all interactive elements on mobile. Use padding to increase hit area without increasing visual size:

```css
.touch-target {
  min-width: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
```

### Contrast

- Body text on background: 4.5:1 minimum (WCAG AA)
- Large text (18px+ bold or 24px+): 3:1 minimum
- The default palette meets these ratios: `#1c1917` on `#ece5f0` = 10.2:1
- Interactive elements: ensure sufficient contrast in all states (default, hover, active, disabled)

### Keyboard Navigation

- All interactive elements reachable via Tab
- Escape closes modals, popovers, overlays
- Enter/Space activates buttons
- Arrow keys for list navigation, tab switching
- Focus management: focus moves to opened panel, returns to trigger on close

### ARIA

- Use semantic HTML (`button`, `nav`, `main`, `dialog`)
- Add `aria-label` for icon-only buttons
- Use `role="dialog"` and `aria-modal="true"` for modals
- Use `aria-expanded` for toggle buttons
- Use `aria-live="polite"` for dynamic content updates

## Bridge API Patterns

### Structured Data (Postgres-backed)

Apps with `storage.tables` in `matrix.json` use `MatrixOS.db`:

```javascript
// Find rows
const rows = await MatrixOS.db.find('tasks', { filter: { done: false }, orderBy: { created_at: 'desc' } });

// Insert
const { id } = await MatrixOS.db.insert('tasks', { text: 'Buy milk', done: false });

// Update
await MatrixOS.db.update('tasks', id, { done: true });

// Delete
await MatrixOS.db.delete('tasks', id);

// Count
const { count } = await MatrixOS.db.count('tasks', { done: false });

// Listen for changes
MatrixOS.db.onChange('tasks', () => loadData());
```

### Legacy KV Data (deprecated for new apps)

```javascript
async function readData(app, key) {
  const res = await fetch(`/api/bridge/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'read', app, key }),
  });
  return res.json();
}
```
```

### Theme Integration

Apps receive theme variables via the bridge. Access current values:

```javascript
const theme = window.MatrixOS?.theme;
// { bg: '#ece5f0', fg: '#1c1917', accent: '#c2703a', ... }
```

Listen for theme changes:

```javascript
window.addEventListener('message', (e) => {
  if (e.data?.type === 'os:theme-update') {
    // Variables already updated in injected <style>
    // Use this to update canvas renders or non-CSS visuals
  }
});
```

### Opening Other Apps

```javascript
window.MatrixOS?.openApp('calculator', '/files/apps/calculator/index.html');
```

## Anti-Patterns

### NEVER Do These

1. **Generic fonts**: Do not use Inter, Roboto, Arial, Helvetica, or Open Sans as a deliberate font choice in apps. Inherit `--matrix-font-sans` or choose a distinctive alternative.

2. **Hardcoded colors**: Never write `color: #c2703a` or `background: #ece5f0` directly. Always use `var(--matrix-primary)` / `var(--matrix-bg)`. Hardcoded values break when the user changes their theme.

3. **Purple gradients on white**: This was the old design. The current palette is warm (lavender + terracotta), not cool (purple + white).

4. **Dark backgrounds by default**: Matrix OS is light-mode by default (`#ece5f0` canvas). Do not set `background: #0a0a0a` or similar dark values.

5. **Cookie-cutter layouts**: Avoid identical card grids with no visual hierarchy. Use size variation, featured items, asymmetric layouts, and editorial spacing.

6. **Missing empty states**: Every view must handle zero items gracefully. A blank screen is a failure.

7. **No animations**: Apps should have entrance animations, hover micro-interactions, and smooth transitions. Static apps feel lifeless.

8. **Sharp corners**: The design language uses rounded corners throughout. Never use `border-radius: 0`.

9. **Heavy drop shadows on cards**: The window chrome already has a shadow. Cards inside windows use subtle `shadow-sm` only.

10. **Ignoring reduced motion**: Always wrap non-essential animations in a `prefers-reduced-motion` check.
