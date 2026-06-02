---
name: matrix-app-ui-patterns
description: UI patterns and layouts for Matrix OS apps — dashboards, workspaces, data views, mobile, and windowed contexts. Use this when building the interior of an app, not the design tokens (see matrix-design-system).
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
metadata:
  agent:
    tags: [Matrix OS, UI, layout, patterns, dashboard, mobile, responsive]
    related_skills: [matrix-design-system, matrix-app-builder]
---

# Matrix OS App UI Patterns

## When to Use

Use this when building the layout and interaction patterns inside a Matrix OS app. For colors, typography, and token values, use `matrix-design-system`. This skill covers how things are arranged, not how they look at the token level.

## Context: Apps Run in Windows

Matrix OS apps render inside iframes within window frames. The OS provides title bar chrome (traffic lights, title, drag handle). Apps should:

- Fill the full window space: `html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }`
- Handle arbitrary resize gracefully (min: 320×200px)
- Use their own scroll containers, not body scroll
- Never render their own title bar or window chrome
- Never add internal margin against window edges
- Keep fixed-format UI stable with explicit dimensions, grid tracks, aspect ratios, or min/max constraints so
  hover states, labels, icons, tiles, and loading states do not shift layout.

## App Shell Pattern

Most apps follow a consistent shell structure:

```
┌─────────────────────────────────────┐
│ App Bar (optional)                  │
├──────┬──────────────────────────────┤
│ Side │ Content Area                 │
│ bar  │                              │
│      │                              │
│      │                              │
├──────┴──────────────────────────────┤
│ Status Bar (optional)               │
└─────────────────────────────────────┘
```

```css
.app-shell {
  height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background: var(--bg);
  color: var(--fg);
  font-family: 'Inter', system-ui, sans-serif;
}

.app-content {
  display: grid;
  grid-template-columns: auto 1fr;
  overflow: hidden;
}

.app-main {
  overflow-y: auto;
  padding: 24px;
}
```

## Pattern: Dashboard

Greeting, key stats, quick actions, and a command/search bar.

```
┌─────────────────────────────────────┐
│ Good morning, Arian.                │
│ Monday, May 12 — 3 tasks            │
├───────────┬───────────┬─────────────┤
│   12      │   3.2k    │    99%      │
│   Apps    │  Requests  │   Uptime    │
├───────────┴───────────┴─────────────┤
│ ┌─────────────────────────────┬───┐ │
│ │ Ask anything...             │ → │ │
│ └─────────────────────────────┴───┘ │
└─────────────────────────────────────┘
```

- **Greeting** uses Inter, 1.25-1.5rem, weight 600. Orbitron only if the greeting is a large hero-level display (2rem+).
- **Stats** use Orbitron for the number only when large (1.5rem+). Inter weight 700 for smaller stat numbers. Inter for the label (tiny, uppercase, tracked).
- **Stat cards** have `--bg` background, 14px radius, 16px padding
- **Command bar** is a composite input: text input + icon button in a single container with `--bg` background, 14-16px radius
- Keep the dashboard to a single scroll-free view when possible

## Pattern: Data Table

For lists, records, logs — the workhorse view.

```
┌─────────────────────────────────────┐
│ Title          [Filter] [+ New]     │
├─────────────────────────────────────┤
│ Name       Status    Date    ···    │
│ ────────────────────────────────    │
│ Project A  ● Active  May 10  ···   │
│ Project B  ● Draft   May 8   ···   │
│ Project C  ● Done    May 5   ···   │
└─────────────────────────────────────┘
```

- **Header row**: Inter weight 600, `--muted-fg` color, tiny uppercase
- **Data rows**: Inter weight 400, full `--fg`
- **Row hover**: `--muted` background, smooth 150ms transition
- **Status badges**: pill-shaped with tinted backgrounds (see design-system badge variants)
- Row height: 48-52px for comfortable touch targets
- Alternate row backgrounds are NOT used — keep it clean with hover instead
- Border-bottom between rows: 1px `--border`

## Pattern: Detail / Side Sheet

For viewing a single record alongside a list.

```
┌──────────────────┬──────────────────┐
│ List             │ Detail Sheet     │
│ ● Item A         │                  │
│   Item B         │ Item A           │
│   Item C         │ Status: Active   │
│   Item D         │ Created: May 10  │
│                  │                  │
│                  │ [Edit] [Delete]  │
└──────────────────┴──────────────────┘
```

- List takes 35-40% width, detail takes 60-65%
- Separator: 1px `--border` vertical line
- On mobile (< 640px): detail overlays as a full-width sheet sliding from right
- Detail sheet close: X button, swipe right (mobile), Escape key

## Pattern: Form

For settings, creation, and edit flows.

```
┌─────────────────────────────────────┐
│ Create New Project                  │
│                                     │
│ PROJECT NAME                        │
│ ┌─────────────────────────────────┐ │
│ │ My Project                      │ │
│ └─────────────────────────────────┘ │
│                                     │
│ DESCRIPTION                         │
│ ┌─────────────────────────────────┐ │
│ │ A brief description...          │ │
│ └─────────────────────────────────┘ │
│                                     │
│ CATEGORY                            │
│ ┌─────────────────────────────────┐ │
│ │ Productivity              ▾    │ │
│ └─────────────────────────────────┘ │
│                                     │
│          [Cancel]  [Create]         │
└─────────────────────────────────────┘
```

- **Labels**: Inter 0.65rem, weight 600, letter-spacing 0.15em, uppercase, `--muted-fg`
- **Inputs**: 14px radius, 1.5px border, 12-14px vertical padding
- **Form width**: constrained to 480-560px max, centered if the window is wider
- **Spacing**: 20-24px between fields, 32px before action buttons
- **Actions**: right-aligned. Primary on the right, secondary on the left.
- **Validation**: show errors below the field, `--destructive` color, only after the user has interacted

## Pattern: Workspace / Canvas

For spatial apps: whiteboards, kanban boards, node editors.

- Full-bleed canvas: no padding, fills the entire window
- Floating toolbar: glass-morphism bar, positioned top-center or left side
- Toolbar buttons: ghost variant, 36×36px, icon-only with tooltips
- Zoom controls: bottom-right corner, small pill-shaped container
- Canvas background: very subtle dot grid or topo pattern at 2-3% opacity
- Cancellation must be explicit: Escape/cancel should suppress follow-up blur commits for inline editors.
- Destructive actions and failed saves should not clear visible local state until the bridge/server confirms.

## Pattern: Empty State

Every empty view needs:

1. **Icon or illustration** — simple, monochrome, 48-64px
2. **Headline** — Inter weight 600, 1-1.25rem, short, active voice ("No tasks yet")
3. **Description** — Inter, one sentence, `--muted-fg`
4. **Call to action** — a button or text link ("Create your first task")

Place the empty state in the same position where content will appear when populated. Don't center it in the viewport unless the entire view is empty.

## Pattern: Notifications / Activity Feed

```css
.notification {
  display: flex;
  gap: 14px;
  padding: 16px 20px;
  background: var(--bg);
  border-radius: 14px;
  border-left: 3px solid var(--primary);
}
```

- Left border accent: Forest for informational, Ember for urgent
- Avatar: 32-36px, 10-12px radius, Inter weight 700 initial or icon on colored background
- Title: Inter 0.8rem weight 600
- Description: Inter 0.75rem, `--muted-fg`
- Timestamp: JetBrains Mono 0.6rem, `--muted-fg`, right-aligned

## Pattern: Mobile Adaptation

Apps should be usable at 320px width (minimum window size).

- Sidebar → collapses to hamburger menu or bottom tabs
- Data table → stacks into card list
- Side sheet → full-width overlay
- Stats grid → 2 columns, then 1 column
- Command bar → full width with reduced padding
- Font sizes remain the same (don't shrink body text below 0.875rem)

## Pattern: Loading States

- **Skeleton screens**: use `--muted` background with subtle shimmer animation (2.4s, ease-in-out). Match the shape of the content that will load.
- **Spinners**: use a simple 16-20px circle with `--primary` color, 2px stroke, rotating. Not a full-page overlay — inline where the content will appear.
- **Progress bars**: 4px height, `--muted` track, fill color matches the context (Forest for neutral, Ember for important).

## Composition Rules

1. **No marketing within apps.** The first screen is the usable product. No hero banners, no onboarding carousels, no "Welcome to App Name" splash screens.
2. **Dense where useful.** Productivity apps should pack information. Don't add whitespace between every element in a data table.
3. **Airy where reflective.** Journals, notes, creative tools should breathe. More padding, fewer borders.
4. **One primary action per view.** The main thing the user came to do should be immediately obvious.
5. **Never nest cards inside cards.** If you need hierarchy, use muted backgrounds or border-left accents.
6. **Navigation: top (tabs) or left (sidebar).** Never bottom — the OS owns that space.
7. **No layout shift under data refresh.** Loading, empty, error, and populated states should reserve compatible
   space for the same controls.
8. **Keyboard behavior is stateful.** Pause overlays, inline editors, and selected tools should treat Enter,
   Escape, and arrow keys according to the current mode instead of restarting or committing unexpectedly.
