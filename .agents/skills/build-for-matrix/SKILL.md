---
name: build-for-matrix
description: Master skill for building Matrix OS apps -- manifest format, lifecycle, bridge API, theming Triggers: matrix app, matrix.json, app manifest, build for matrix, matrix os app. Examples: how do I create a Matrix OS app; explain the matrix.json format; how does the app bridge API work.
---

# Build for Matrix OS

## App Types

Matrix OS supports three types of apps:

### Static HTML Apps (simplest)
Single HTML file in `~/apps/<name>.html` or directory in `~/apps/<name>/index.html`. Served directly by the gateway. No build step needed.

### Directory Apps with matrix.json
Directory in `~/apps/<name>/` with a `matrix.json` manifest. Can contain any static files. The gateway serves files from the directory.

### Process Apps (advanced)
Node.js, Python, or other runtime apps that run as server processes. The gateway reverse-proxies to the app port.

## matrix.json Manifest

Every app should have a `matrix.json` in its root directory:

```json
{
  "name": "My App",
  "description": "What it does",
  "runtime": "static",
  "category": "utility",
  "icon": "app-icon",
  "author": "system",
  "version": "1.0.0"
}
```

### Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | string | yes | - | Display name |
| description | string | no | - | Short description |
| runtime | enum | no | "static" | "static", "node", "python", "rust", "docker" |
| entry | string | no | - | Start command for process apps |
| port | number | no | auto 3100-3999 | Port for process apps |
| framework | string | no | - | "nextjs", "vite", etc. |
| permissions | string[] | no | [] | "network", "database", etc. |
| resources | object | no | - | { memory: "256MB", cpu: 0.5 } |
| category | string | no | "utility" | "utility", "productivity", "games", "social" |
| icon | string | no | - | Icon name or emoji |
| author | string | no | - | Author name |
| version | string | no | - | Semantic version |
| autoStart | boolean | no | false | Start on boot |

### Runtime Types
- **static**: HTML/CSS/JS served by gateway (no process)
- **node**: Node.js app (`pnpm dev` or custom entry)
- **python**: Python app (FastAPI, Flask, etc.)
- **rust**: Compiled binary
- **docker**: Docker container

## Bridge API for Data Persistence

Apps use the bridge API to read/write persistent data:

```javascript
const BRIDGE_URL = window.location.origin + '/api/bridge/data';

// Read
const res = await fetch(BRIDGE_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'read', app: 'my-app', key: 'settings' }),
});
const data = await res.json();

// Write
await fetch(BRIDGE_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'write', app: 'my-app', key: 'settings', value: myData }),
});
```

Data is stored in `~/data/<app-name>/<key>.json`.

## Theming

All apps should use a dark theme consistent with Matrix OS:
- Background: `#0a0a0a`
- Surface: `#141414` to `#1a1a1a`
- Border: `#222` to `#333`
- Text: `#e0e0e0` (primary), `#888` (secondary), `#555` (muted)
- Accent: varies by app

For CSS custom properties:
```css
:root {
  --bg: #0a0a0a;
  --fg: #e0e0e0;
  --surface: #141414;
  --border: #222;
  --accent: #3b82f6;
}
```

## Sound Effects (Web Audio API)

```javascript
function playSound(freq, duration, type) {
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  gain.gain.value = 0.06;
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + duration);
}
```

## App Communication with Shell

Apps run in iframes. To communicate with the shell:
```javascript
// Open another app from within an app
window.parent.postMessage({
  type: 'matrix:open-app',
  path: '/files/apps/other-app/index.html',
  name: 'Other App'
}, '*');
```

## Directory Structure

```
~/apps/
  my-app/
    matrix.json       # manifest
    index.html        # entry point
    style.css         # (optional)
    script.js         # (optional)
    assets/           # (optional) images, fonts
```

## Quick Start Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My App</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 16px;
    }
  </style>
</head>
<body>
  <h1>My App</h1>
  <script>
    // App logic here
  </script>
</body>
</html>
```


## Matrix OS Context

- **Category**: builder
- **Channels**: web
- **Composable with**: build-react-app, build-html-app, build-game, app-builder
- **Example prompts**: how do I create a Matrix OS app; explain the matrix.json format; how does the app bridge API work; what ports can my app use
