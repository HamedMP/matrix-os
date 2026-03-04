---
name: build-html-app
description: Build a single-file HTML app with no build step
triggers:
  - html app
  - simple app
  - quick app
  - single file
category: builder
tools_needed:
  - Write
  - Read
channel_hints:
  - web
examples:
  - make me a quick calculator
  - build a simple clock widget
  - create a quick unit converter
composable_with:
  - app-builder
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
Use the bridge API for persistent data:
```js
async function loadData(key) {
  const r = await fetch(`/api/bridge/data?app=${APP_NAME}&key=${key}`);
  return r.ok ? (await r.json()).value : null;
}
async function saveData(key, value) {
  await fetch('/api/bridge/data', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ app: APP_NAME, key, value })
  });
}
```

## Registration
Add to ~/system/modules.json:
```json
{"name":"<name>","type":"html-app","path":"~/apps/<name>.html","status":"active"}
```

No build step needed. Write file + register = done.
