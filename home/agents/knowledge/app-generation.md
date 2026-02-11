# App Generation Knowledge

## HTML Apps (~/apps/)

Single-file HTML apps are the simplest output. They work immediately in an iframe.

### Structure
- One `.html` file in `~/apps/`
- CSS and JS inline or via CDN imports
- Theme integration: read CSS custom properties from the parent shell

### Theme Integration
```html
<style>
  body {
    background: var(--color-bg, #0a0a0a);
    color: var(--color-fg, #ededed);
    font-family: var(--font-sans, system-ui);
  }
</style>
```

### Manifest
After creating an app, update `~/system/modules.json`:
```json
{
  "name": "my-app",
  "type": "html-app",
  "path": "~/apps/my-app.html",
  "description": "Short description",
  "createdAt": "2026-02-11T00:00:00Z"
}
```

## Modules (~/modules/)

Modules are full directory-based apps with their own server process.

### Structure
```
~/modules/expense-tracker/
  manifest.json     # Module metadata
  index.html        # Entry point
  server.ts         # Optional backend (runs as child process)
  package.json      # Dependencies (if needed)
```

### manifest.json
```json
{
  "name": "expense-tracker",
  "version": "1.0.0",
  "description": "Track daily expenses",
  "entryPoint": "index.html",
  "port": 3100,
  "health": "/health",
  "dependencies": []
}
```

## Best Practices
- Start with HTML apps for simple tools (calculators, notes, dashboards)
- Use modules for apps needing a backend (database, API calls)
- Always include a health endpoint for modules (`GET /health` returns 200)
- Use semantic HTML and accessible markup
- Prefer CDN imports over npm packages in HTML apps
