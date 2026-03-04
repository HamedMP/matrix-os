---
name: design-matrix-app
description: UX/UI design guidelines for Matrix OS apps
triggers:
  - design app
  - app design
  - app layout
  - ui guidelines
  - ux patterns
category: builder
tools_needed:
  - Write
  - Read
channel_hints:
  - web
examples:
  - how should I design my matrix os app
  - what are the ui guidelines
  - best practices for app layout
  - how to make my app look native
composable_with:
  - build-for-matrix
  - app-builder
---

# Design Matrix App

## Window Constraints

Matrix OS apps run in resizable windows. Design for these ranges:
- **Minimum**: 300x200px
- **Default**: 600x400px
- **Maximum**: full viewport

Always test at minimum size. Use responsive layout.

## Dark Theme (Required)

Matrix OS uses a dark-first aesthetic:

```css
body {
  background: #0a0a0a;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

### Color Palette
| Role | Color | Usage |
|------|-------|-------|
| Background | #0a0a0a | Page/app background |
| Surface | #141414 | Cards, panels |
| Surface Alt | #1a1a1a | Elevated surfaces |
| Border | #222 | Subtle borders |
| Border Hover | #333 | Hover state borders |
| Text Primary | #e0e0e0 | Main text |
| Text Secondary | #888 | Labels, hints |
| Text Muted | #555 | Disabled, timestamps |
| Accent Blue | #3b82f6 | Links, primary actions |
| Accent Green | #22c55e / #4ade80 | Success, positive |
| Accent Red | #ef4444 | Error, destructive |
| Accent Amber | #f59e0b | Warning, highlight |
| Accent Purple | #a78bfa | Special, premium |

## Typography

- Font: system font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`)
- Headings: 18-28px, weight 600-700
- Body: 14px, weight 400
- Labels: 12px, uppercase, letter-spacing 0.5px, color #888
- Monospace data: `font-variant-numeric: tabular-nums`

## Layout Patterns

### Header/Toolbar
```css
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(0,0,0,0.3);
  border-bottom: 1px solid #222;
}
```

### Card Grid
```css
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
  padding: 16px;
}
```

### Overlay/Modal
```css
.overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.85);
  z-index: 10;
}
```

## Interactive Elements

### Buttons
```css
.btn-primary {
  padding: 8px 20px;
  background: #3b82f6;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover { background: #2563eb; }

.btn-ghost {
  padding: 6px 14px;
  background: #222;
  color: #e0e0e0;
  border: 1px solid #333;
  border-radius: 4px;
  cursor: pointer;
}
.btn-ghost:hover { background: #333; }
```

### Inputs
```css
input, select {
  padding: 8px 12px;
  background: #1a1a1a;
  color: #e0e0e0;
  border: 1px solid #333;
  border-radius: 6px;
  font-size: 14px;
}
input:focus { outline: none; border-color: #3b82f6; }
```

## Animation Guidelines

- Enter: 150-200ms, ease-out
- Exit: 100-150ms, ease-in
- Hover: 100ms transition
- Use `transform` and `opacity` for performance
- No animation on first paint (use `animation-delay` or JS)

```css
.fade-in { animation: fadeIn 0.15s ease-out; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } }
```

## Accessibility

- All interactive elements must be keyboard accessible
- Focus visible on tab navigation
- Minimum touch target: 44x44px on mobile
- Color contrast: 4.5:1 for text, 3:1 for large text
- Use semantic HTML (`button` not `div`, `nav`, `main`, etc.)

## Empty States

Never show a blank screen. Show an icon + message + action:
```html
<div class="empty-state">
  <div class="icon">...</div>
  <h2>No items yet</h2>
  <p>Get started by creating your first item</p>
  <button class="btn-primary">Create</button>
</div>
```

## Responsive Patterns

- Use `min()` and `clamp()` for fluid sizing
- Stack layouts below 400px width
- Hide secondary content at small sizes
- Touch targets 44px minimum on mobile
- Test with both mouse and touch interactions
