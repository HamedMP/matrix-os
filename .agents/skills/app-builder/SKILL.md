---
name: app-builder
description: Build apps with theme integration, icons, and data directories Triggers: build app, create app, make app, new app, build me, webapp, build tool, create tool, make tool. Examples: build me a todo app; create an app to track my workouts; make a pomodoro timer.
---

# App Builder

When the user asks to build an app, this skill enhances the builder agent with conventions:

## Before Building
1. Clarify what the app should do. Ask 1-2 follow-up questions if the request is vague.
2. Decide the app type:
   - **React module** (default): full Vite + React + TypeScript app in `~/modules/<name>/`
   - **HTML app** (simple): single HTML file in `~/apps/<name>.html` for trivial tools
3. Choose an appropriate name: lowercase, hyphenated, descriptive.

## Decision Guide

| Signal | Output Type | Estimated Time |
|--------|------------|----------------|
| Default (no preference) | React module | ~15s |
| Multi-screen, complex state | React module | ~15s |
| Dashboard with charts | React module | ~15s |
| CRUD/data management | React module | ~15s |
| "quick", "simple", "just a..." | HTML app | ~3s |
| Calculator, clock, widget | HTML app | ~3s |
| Game (canvas/p5.js) | HTML app (simple) or React (complex) | ~5-15s |

## Theme Integration
All apps must use CSS custom properties for theming:
- `var(--matrix-bg)` -- background color
- `var(--matrix-fg)` -- foreground/text color
- `var(--matrix-accent)` -- accent/primary color
- `var(--matrix-card-bg)` -- card/surface background
- `var(--matrix-border)` -- border color
- `var(--matrix-muted-fg)` -- secondary/muted text
- `var(--matrix-input-bg)` -- input background
- `var(--matrix-font-sans)` -- sans-serif font stack
- `var(--matrix-font-mono)` -- monospace font stack
Set sensible fallback values: `var(--matrix-bg, #f5f5f7)`. Support both light and dark themes.

## Data Persistence
Use the bridge API (`/api/bridge/data`) for read/write from the app iframe. Data stored in `~/data/<app-name>/`.

```javascript
var GATEWAY = location.origin;
var APP_NAME = 'my-app';
// Read
fetch(GATEWAY + '/api/bridge/data', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'read', app: APP_NAME, key: 'data' })
}).then(r => r.json()).then(d => { if (d && d.value) items = JSON.parse(d.value); render(); });
// Write
fetch(GATEWAY + '/api/bridge/data', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'write', app: APP_NAME, key: 'data', value: JSON.stringify(items) })
});
```

## Auto-Update (MANDATORY)
Apps MUST listen for external data changes so the UI updates when data is modified from chat, Telegram, or other agents:
```javascript
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'os:data-change') {
    loadData(); // Re-fetch all data from bridge API and re-render
  }
});
```
This fires when any external source (kernel, chat, Telegram, other agents) writes to the app's data via the bridge API. Without this, the UI stays stale.

## Design Quality
Apps represent the Matrix OS brand. Every app must have:
- Smooth transitions (200-300ms) on all interactions
- Hover/focus/active states on every interactive element
- Beautiful empty states (icon + headline + description)
- Proper typography hierarchy (large titles, medium labels, small metadata)
- Consistent spacing on a 4px grid
- Subtle shadows and rounded corners (12-16px)
- Animations for add/remove operations (fade, slide)
- Responsive layout that works at any width

## Module Registration
After building:
- Add entry to `~/system/modules.json`
- For React modules: `{ "name": "<name>", "type": "react-app", "path": "~/modules/<name>", "status": "active" }`
- For HTML apps: `{ "name": "<name>", "type": "html-app", "path": "~/apps/<name>.html", "status": "active" }`

## Verification
- For React modules: verify `dist/index.html` exists after `pnpm build`
- Read back modules.json to confirm the entry

## Domain-Specific Skills
For specialized app types, load the companion skill for better guidance:
- **Dashboard/analytics**: load `build-dashboard` for chart patterns
- **CRUD/data management**: load `build-crud-app` for data patterns
- **Games**: load `build-game` for canvas/input/score patterns

Tips:
- Start simple and iterate. Get a working version first, then add features.
- Use `pnpm install --prefer-offline` for faster installs.
- If build fails, read error, fix, rebuild. Max 2 retries before falling back to HTML.


## Matrix OS Context

- **Category**: system
- **Channels**: web
- **Composable with**: build-react-app, build-html-app
- **Example prompts**: build me a todo app; create an app to track my workouts; make a pomodoro timer; build a habit tracker; create a weather widget; make me a budget tool; build a recipe manager; create a kanban board; make a note-taking app; build a simple calculator
