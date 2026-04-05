---
name: build-matrix-app
description: Build apps for Matrix OS -- create the manifest, UI, data storage, and theme integration. Use when asked to build, create, or make an app for Matrix OS, or when working with matrix.json manifests.
---

# Build Matrix OS Apps

Matrix OS apps are self-contained packages in `~/apps/{slug}/` with a manifest (`matrix.json`) and an entry point (`index.html`).

## Quick start

Create two files:

**`~/apps/{slug}/matrix.json`**:
```json
{
  "name": "My App",
  "description": "What this app does",
  "runtime": "static",
  "category": "utility",
  "icon": "my-app",
  "author": "user",
  "version": "1.0.0"
}
```

**`~/apps/{slug}/index.html`**: Single HTML file with inline CSS and JS.

The app appears automatically in the OS launcher and command palette.

## Manifest fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name |
| `description` | Yes | Short description |
| `runtime` | No | `static` (default), `node`, `python`, `rust`, `docker` |
| `category` | No | `utility`, `productivity`, `games`, `developer-tools`, `education`, `finance`, `health-fitness`, `social`, `music`, `photo-video`, `news`, `entertainment`, `lifestyle` |
| `version` | No | Semver string (default: `1.0.0`) |
| `permissions` | No | Array of required capabilities |
| `storage` | No | Database table declarations |
| `integrations` | No | `{ required?: string[], optional?: string[] }` |

## Theme integration (required)

Always use CSS custom properties so the app matches the OS theme:

```css
:root {
  --bg: var(--matrix-bg, #f5f5f7);
  --fg: var(--matrix-fg, #1d1d1f);
  --accent: var(--matrix-accent, #007aff);
  --surface: var(--matrix-card-bg, #ffffff);
  --border: var(--matrix-border, #d2d2d7);
  --muted: var(--matrix-muted-fg, #86868b);
}
```

## Data storage

Declare tables in the manifest for structured data:

```json
{
  "storage": {
    "tables": {
      "notes": {
        "columns": {
          "title": "text",
          "content": "text",
          "pinned": "boolean"
        },
        "indexes": ["pinned"]
      }
    }
  }
}
```

Column types: `text`, `integer`, `float`, `boolean`, `timestamptz`, `uuid`, `jsonb`

Access data via the gateway API:

```javascript
const API = window.location.origin;
async function db(action, table, data = {}) {
  const res = await fetch(`${API}/api/apps/${slug}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, table, ...data })
  });
  return res.json();
}

// CRUD
const items = await db('find', 'notes', { orderBy: { created_at: 'desc' } });
const item = await db('insert', 'notes', { data: { title: 'New', content: '' } });
await db('update', 'notes', { id: item.id, data: { title: 'Updated' } });
await db('delete', 'notes', { id: item.id });
```

For simple state, use `localStorage`.

## Integration declarations

Apps can declare required external services:

```json
{
  "integrations": {
    "required": ["gmail.read", "calendar.write"],
    "optional": ["slack.send"]
  }
}
```

Users are prompted to connect missing services at install time.

## Design guidelines

- Font: `system-ui, -apple-system, sans-serif`
- `box-sizing: border-box` globally
- `height: 100vh; overflow: hidden` on body (runs in iframe)
- Border radius: 8-12px cards, 6-8px buttons
- Transitions: `transition: all 0.15s ease`
- Backdrop blur for panels: `backdrop-filter: blur(20px) saturate(180%)`

## Gotchas

- All UI must be in a single `index.html` (inline CSS and JS)
- Slug must match: `[a-z0-9][a-z0-9_-]*`
- Max app size: 50MB
- Apps run in an iframe -- no access to parent DOM
- Use theme CSS variables with fallback values for all colors
- Never use `process.env` -- use Matrix OS integration APIs instead
