# Matrix OS - App Development Guide

You are building apps for Matrix OS, a web-based AI operating system. Apps run inside the OS shell as windows.

## Quick Start

To create an app, make a directory in `~/apps/{slug}/` with two files:

1. `matrix.json` - App manifest
2. `index.html` - App UI

The slug must match: `[a-z0-9][a-z0-9_-]*`

## Manifest (`matrix.json`)

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

## App UI (`index.html`)

Apps are single HTML files with inline CSS and JS. They run in an iframe inside the OS shell.

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

If your manifest declares `storage`, use the MatrixOS database API:

```javascript
// The gateway URL is the parent origin
const API = window.location.origin;

async function dbRequest(action, table, data = {}) {
  const app = 'my-app'; // must match your app slug
  const res = await fetch(`${API}/api/apps/${app}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, table, ...data })
  });
  return res.json();
}

// CRUD operations
const notes = await dbRequest('find', 'notes', { orderBy: { created_at: 'desc' } });
const note = await dbRequest('insert', 'notes', { data: { title: 'New', content: '' } });
await dbRequest('update', 'notes', { id: note.id, data: { title: 'Updated' } });
await dbRequest('delete', 'notes', { id: note.id });
```

For apps without database storage, use localStorage:

```javascript
const data = JSON.parse(localStorage.getItem('myapp-data') || '[]');
localStorage.setItem('myapp-data', JSON.stringify(data));
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
  "category": "utility"
}

~/apps/counter/index.html:
(single HTML file with inline style and script)
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

- All UI must be in a single `index.html` file (inline CSS and JS)
- Always use theme CSS variables with fallback values
- Apps must work in an iframe context
- Keep apps self-contained - no external CDN dependencies unless essential
- Slug must be lowercase alphanumeric with hyphens/underscores only
- Max app size: 50MB
- Use localStorage for simple state, manifest storage for structured data

## Skills & Knowledge

Skills are markdown files in `~/agents/skills/` with frontmatter (name, description, trigger). They teach the AI agent domain-specific capabilities and are loaded on demand via the kernel.

Knowledge files in `~/agents/knowledge/` provide persistent context the agent can reference -- user preferences, project notes, domain expertise. These are injected at prompt time when relevant.

To create a skill: add a `.md` file to `~/agents/skills/` with a descriptive name and frontmatter. The kernel's skill loader will discover it automatically.
