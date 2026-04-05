---
name: build-html-app
description: Build a single-file HTML app with no build step Triggers: html app, simple app, quick app, single file. Examples: make me a quick calculator; build a simple clock widget; create a quick unit converter.
---

# Build HTML App

## When to Choose HTML Over React
- Single screen, no routing needed
- No complex state management
- User says "quick", "simple", or "just a..."
- Calculators, clocks, timers, converters, simple widgets
- No build step = instant delivery (< 3 seconds)

## Scaffold

Write a single file to `~/apps/<name>.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>APP_TITLE</title>
  <style>
    :root { --bg: #0a0a0a; --fg: #ededed; --accent: #6c5ce7; --surface: #1a1a2e; --border: #2a2a3a; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem; }
    /* App styles here */
  </style>
</head>
<body>
  <div id="app">
    <!-- App content -->
  </div>
  <script type="module">
    // App logic here
  </script>
</body>
</html>
```

## CDN Import Patterns

React via esm.sh (when needed for interactive HTML apps):
```html
<script type="module">
import React from 'https://esm.sh/react@19';
import ReactDOM from 'https://esm.sh/react-dom@19/client';
</script>
```

Utility libraries:
```html
<script src="https://unpkg.com/chart.js@4"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dayjs/1.11.10/dayjs.min.js"></script>
```

## Theme Integration
Same CSS custom properties as React apps. Set defaults in :root. The shell injects theme overrides via parent CSS.

## Data Persistence
Use the bridge API (POST only) for persistent data:
```js
var GATEWAY = location.origin;
var APP_NAME = 'my-app';

function loadData() {
  fetch(GATEWAY + '/api/bridge/data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'read', app: APP_NAME, key: 'items' })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data && data.value) {
      try { items = JSON.parse(data.value); } catch(e) { items = []; }
    }
    render();
  }).catch(function() { render(); });
}

function saveData() {
  fetch(GATEWAY + '/api/bridge/data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'write', app: APP_NAME, key: 'items', value: JSON.stringify(items) })
  });
}
```

## Auto-Update (MANDATORY)
Apps MUST listen for external data changes so the UI refreshes when data is modified from chat, Telegram, or other agents:
```js
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'os:data-change') {
    loadData(); // Re-fetch from bridge and re-render
  }
});
```
Without this, the app stays stale when the AI updates data externally.

## Design Quality
Every HTML app must have:
- All colors via CSS custom properties: `var(--matrix-bg, #f5f5f7)`, `var(--matrix-fg, #1d1d1f)`, `var(--matrix-accent, #007aff)`, `var(--matrix-card-bg, #fff)`, `var(--matrix-border, #d2d2d7)`, `var(--matrix-muted-fg, #86868b)`
- Smooth transitions (200-300ms) on all interactions
- Hover/focus/active states on every interactive element
- Beautiful empty state with icon + headline + call-to-action
- Proper typography (system font stack, tabular-nums for numbers)
- Consistent spacing, rounded corners (12-16px)
- Animations for add/delete (fade + slide, 200-300ms)
- Responsive at any width

## Registration
Add to ~/system/modules.json:
```json
{"name":"<name>","type":"html-app","path":"~/apps/<name>.html","status":"active"}
```

No build step needed. Write file + register = done.


## Matrix OS Context

- **Category**: builder
- **Channels**: web
- **Composable with**: app-builder
- **Example prompts**: make me a quick calculator; build a simple clock widget; create a quick unit converter
