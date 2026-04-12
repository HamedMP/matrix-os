---
name: build-matrix-app
description: Build apps for Matrix OS -- create the manifest, UI, data storage, and theme integration. Use when asked to build, create, or make an app for Matrix OS, or when working with matrix.json manifests.
triggers:
  - build matrix app
  - create matrix app
  - make an app
  - matrix.json
  - matrix os app
category: builder
tools_needed:
  - Write
  - Read
  - Bash
channel_hints:
  - web
examples:
  - build a calculator app for matrix os
  - create a notes app with database storage
  - make me a pomodoro timer for matrix
composable_with:
  - design-matrix-app
  - publish-app
---

# Build Matrix OS Apps

Matrix OS apps are self-contained packages in `~/apps/{slug}/` with a manifest (`matrix.json`) and an entry point (usually `index.html`).

For the authoritative manifest schema, see `packages/gateway/src/app-manifest.ts` (`AppManifestSchema`). This skill mirrors that schema.

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

## Manifest fields (AppManifestSchema)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name |
| `description` | string | No (but required for publish) | Short description |
| `runtime` | `static` \| `node` \| `python` \| `rust` \| `docker` | No | Default: `static` |
| `entry` | string | No | Entry file for non-static runtimes |
| `port` | int 1024-65535 | No | Port for node/python/rust runtimes |
| `framework` | string | No | Framework hint (e.g. `react`, `vue`) |
| `permissions` | string[] | No | Array of capability strings |
| `resources` | `{ memory?, cpu? }` | No | Resource limits |
| `category` | string | No | Default: `utility` |
| `icon` | string | No | Icon slug -- resolves to `/files/system/icons/{icon}.png` |
| `author` | string | No | Author handle |
| `version` | string | No | Semver |
| `autoStart` | bool | No | Default: `false` |
| `storage` | `{ tables }` | No | Database table declarations |

Note: there is no `integrations` field on the current manifest. Apps access external services via the gateway's `/api/integrations/*` routes at runtime, not via manifest declarations.

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

### Structured data (Postgres tables)

Declare tables in the manifest:

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

Column types accepted by `app-db.ts`: `text`, `string`, `boolean`, `integer`, `int`, `float`, `number`, `date`, `timestamptz`, `timestamp`, `json`, `jsonb`, `uuid`. Unknown types fall back to `text`.

Access structured data via `POST /api/bridge/query` on the gateway:

```javascript
const API = window.location.origin;

async function db(action, table, extra = {}) {
  const res = await fetch(`${API}/api/bridge/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: '{slug}', action, table, ...extra }),
  });
  return res.json();
}

// CRUD actions: find, findOne, insert, update, delete, count
const items = await db('find', 'notes', { orderBy: { created_at: 'desc' } });
const created = await db('insert', 'notes', { data: { title: 'New', content: '' } });
await db('update', 'notes', { id: created.id, data: { title: 'Updated' } });
await db('delete', 'notes', { id: created.id });
```

The gateway validates the app slug and table name against `SAFE_SLUG` before dispatching to `queryEngine`.

### Key-value data

For simple read/write of small JSON blobs, use `/api/bridge/data`:

```javascript
// Read
await fetch(`/api/bridge/data?app=${slug}&key=${key}`).then(r => r.json());
// Write
await fetch('/api/bridge/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'write', app: slug, key, value: JSON.stringify(payload) }),
});
```

For truly ephemeral state, `localStorage` is fine.

## External services

Matrix OS integrates with external providers (Gmail, Calendar, GitHub, Slack, Discord, etc.) via Pipedream. Check connection status and call actions:

```javascript
// Check what's connected
const { services } = await fetch('/api/bridge/service').then(r => r.json());
const gmail = services.find(s => s.service === 'gmail' && s.status === 'active');

// Call an action
const resp = await fetch('/api/bridge/service', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ service: 'gmail', action: 'list_messages', params: { maxResults: 20 } }),
});
const { data } = await resp.json();
```

Users connect services in Settings > Integrations.

## Design guidelines

- Font: `system-ui, -apple-system, sans-serif`
- `box-sizing: border-box` globally
- `height: 100vh; overflow: hidden` on body (apps run in an iframe window)
- Border radius: 8-12px cards, 6-8px buttons
- Transitions: `transition: all 0.15s ease`
- Backdrop blur for panels: `backdrop-filter: blur(20px) saturate(180%)`

## Gotchas

- All UI must be in a single `index.html` (inline CSS and JS) for `runtime: static`
- Slug must match: `[a-z0-9][a-z0-9_-]*`
- Max app size: 50MB (enforced by `validateForPublish`)
- Apps run in an iframe -- no access to parent DOM
- Use theme CSS variables with fallback values for all colors
- Never use `process.env` -- the security audit (`packages/kernel/src/security/audit.ts`) flags hardcoded secrets and unresolved env refs
