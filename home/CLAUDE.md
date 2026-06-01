# Matrix OS - App Development Guide

You are building apps for Matrix OS, a web-based AI operating system. Apps run inside the OS shell as windows.

## Quick Start

To create an app, make a Vite app directory in `~/apps/{slug}/`. First-party and polished apps should be React + TypeScript with the Matrix theme; avoid plain one-file HTML apps unless you are making a throwaway prototype.

1. `matrix.json` - App manifest
2. `index.html` - Vite root with `<div id="root">`
3. `src/main.tsx` - React entrypoint
4. `vite.config.ts` - Vite build config

The slug must match: `[a-z0-9][a-z0-9_-]*`

## Manifest (`matrix.json`)

```json
{
  "name": "My App",
  "description": "What this app does",
  "runtime": "vite",
  "category": "utility",
  "icon": "my-app",
  "author": "user",
  "version": "1.0.0",
  "runtimeVersion": "^1.0.0",
  "build": {
    "install": "pnpm install --frozen-lockfile",
    "command": "pnpm build",
    "output": "dist",
    "timeout": 180
  }
}
```

Categories: `utility`, `productivity`, `social`, `dev`, `games`, `entertainment`, `education`, `finance`, `health`, `communication`

### With Data Storage

Apps can declare database tables in the manifest:

```json
{
  "name": "Notes",
  "description": "Quick notes app",
  "category": "productivity",
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

## App UI

Apps run in an iframe inside the OS shell, but they should be built by Vite into `dist/`. Use React components and shadcn-style primitives (Button, Card, Input, Badge, Tabs, Dialog) styled with Matrix theme tokens.

### Theme Integration (Required)

Always use CSS custom properties so the app matches the OS theme:

```css
:root {
  --bg: var(--matrix-bg, #f5f5f7);
  --fg: var(--matrix-fg, #1d1d1f);
  --accent: var(--matrix-accent, #007aff);
  --surface: var(--matrix-card-bg, #ffffff);
  --border: var(--matrix-border, #d2d2d7);
  --muted: var(--matrix-muted-fg, #86868b);
  --input-bg: var(--matrix-input-bg, #f5f5f7);
}
```

### Data Access

> **Apps run in a sandboxed, null-origin `srcdoc` iframe with CSP `connect-src 'self'`.**
> A direct `fetch()` to `/api/bridge/*` is **blocked by both CORS and CSP** and will break your app
> (`No 'Access-Control-Allow-Origin' header` errors in the console). `localStorage` can also throw
> `SecurityError` in this sandbox. **Always go through the injected `window.MatrixOS` bridge**, which
> proxies to the gateway via `postMessage`. Never `fetch` the bridge yourself.

If your manifest declares `storage`, use `window.MatrixOS.db`. It writes to the user's local Postgres
through the gateway; app code never touches `DATABASE_URL`.

```javascript
const db = window.MatrixOS?.db; // may be undefined outside the shell (e.g. tests) — guard it
if (db) {
  const notes = await db.find('notes', { orderBy: { created_at: 'desc' } });
  const { id } = await db.insert('notes', { title: 'New', content: '' });
  await db.update('notes', id, { title: 'Updated' });
  await db.delete('notes', id);
  const n = await db.count('notes');
  const unsub = db.onChange('notes', () => reload()); // call unsub() on cleanup
}
```

Wrap every call in `try/catch` (no bare catch), update local state optimistically, and reconcile on
`onChange`. For simple key/value state use `window.MatrixOS.readData(key)` / `writeData(key, value)`
(also `postMessage`-based) — again, never a raw `fetch`.

### External Service Integrations (Gmail, Calendar, GitHub, Slack, etc.)

Call connected services through the bridge (again, never a raw `fetch`):

```javascript
// Check what's connected
const services = await window.MatrixOS.integrations();
const gmail = services.find(s => s.service === "gmail" && s.status === "active");

// Call an action
const { data } = await window.MatrixOS.service("gmail", "list_messages", { maxResults: 20 });
```

Services: gmail, google_calendar, google_drive, github, slack, discord. User connects in Settings > Integrations.

For simple per-app state without declared `storage`, use the bridge KV helpers (NOT `localStorage`,
which can be blocked in the sandbox):

```javascript
const saved = await window.MatrixOS.readData('myapp-data'); // string | null
await window.MatrixOS.writeData('myapp-data', JSON.stringify(value));
```

## Design Guidelines

- Use `system-ui, -apple-system, sans-serif` font stack
- Use `box-sizing: border-box` globally
- Set `height: 100vh; overflow: hidden` on body (app runs in a fixed-size window)
- Use backdrop blur for sidebars: `backdrop-filter: blur(20px) saturate(180%)`
- Border radius: 8-12px for cards, 6-8px for buttons, 4px for inputs
- Use `color-mix()` for hover states: `color-mix(in srgb, var(--fg) 4%, transparent)`
- Smooth transitions: `transition: all 0.15s ease`
- Focus states should use the accent color

## Example: Simple Counter App

```
~/apps/counter/matrix.json:
{
  "name": "Counter",
  "description": "Simple click counter",
  "category": "utility",
  "runtime": "vite",
  "runtimeVersion": "^1.0.0",
  "build": {
    "install": "pnpm install --frozen-lockfile",
    "command": "pnpm build",
    "output": "dist"
  }
}

~/apps/counter/index.html:
<div id="root"></div><script type="module" src="/src/main.tsx"></script>
```

## Example: App with Storage

```
~/apps/bookmarks/matrix.json:
{
  "name": "Bookmarks",
  "description": "Save and organize bookmarks",
  "category": "productivity",
  "storage": {
    "tables": {
      "bookmarks": {
        "columns": {
          "url": "text",
          "title": "text",
          "tags": "text",
          "favorite": "boolean"
        },
        "indexes": ["favorite"]
      }
    }
  }
}
```

## File Structure

```
~/apps/
  calculator/
    matrix.json
    index.html
  notes/
    matrix.json
    index.html
  my-game/
    matrix.json
    index.html
    assets/
      sprites.png
```

## Testing Your App

After creating the files, the app appears automatically in the OS launcher (F3) and command palette (Cmd+K). Click it to open in a window.

## Rules

- First-party and polished apps should be Vite + React apps with UI in `src/`; avoid single-file inline HTML except for throwaway prototypes
- Always use theme CSS variables with fallback values
- Apps must work in an iframe context
- Keep apps self-contained - no external CDN dependencies unless essential
- Slug must be lowercase alphanumeric with hyphens/underscores only
- Max app size: 50MB
- Use localStorage for simple state, manifest storage for structured data

## Skills & Knowledge

Skills are directory-based Agent Skills in `~/.agents/skills/<name>/SKILL.md` with frontmatter (`name`, `description`, optional metadata). They teach the AI agent domain-specific capabilities and are loaded on demand via the kernel.

Knowledge files in `~/agents/knowledge/` provide persistent context the agent can reference -- user preferences, project notes, domain expertise. These are injected at prompt time when relevant.

To create a skill: add `~/.agents/skills/<slug>/SKILL.md` with a descriptive name and frontmatter. The kernel's skill loader will discover it automatically. Matrix-shipped coding skills are synced from the canonical `skills/matrix/` pack into Matrix, Claude, Codex, and Hermes skill locations.
