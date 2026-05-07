---
name: pick-app-runtime
description: Decision tree for choosing the right Matrix OS app runtime
---

# Pick App Runtime

Use this decision tree to choose the right runtime for a new Matrix OS app.

## Decision Tree

1. **Did the user explicitly ask for a server runtime, Next.js, SSR, custom API routes, background jobs, or a WebSocket server owned by this app?**
   - YES: Use `runtime: "node"` only if the server requirement cannot be satisfied by Matrix APIs.
   - NO: Continue to step 2

2. **Does the app need persistence, dashboards, CRUD workflows, CRM/roadmap/project data, charts, or integrations?**
   - YES: Use `runtime: "vite"` and call Matrix/Postgres bridge APIs from the SPA.
   - NO: Continue to step 3

3. **Does the app need React, TypeScript, or npm packages?** (component libraries, state management, charting, animations)
   - YES: Use `runtime: "vite"` -- Vite builds a React SPA to `dist/`
   - NO: Continue to step 4

4. **Is it a single HTML file with inline JS/CSS?**
   - YES: Use `runtime: "static"` -- no build step, served as-is
   - NO: Default to `runtime: "vite"` -- it covers most use cases

Do not choose Next.js or `runtime: "node"` merely because the app has database access. Matrix OS apps should use the platform bridge for app data unless the user asks for a custom server.

## Quick Reference

| Runtime | Build step | Server process | Use case |
|---------|-----------|---------------|----------|
| `static` | None | None | Simple HTML apps, landing pages |
| `vite` | `pnpm build` -> `dist/` | None (static serving) | React SPAs, dashboards, tools |
| `node` | `pnpm build` | Long-running process | Full-stack apps, API servers |

## matrix.json Examples

### Static
```json
{ "runtime": "static", "runtimeVersion": "^1.0.0" }
```

### Vite
```json
{
  "runtime": "vite",
  "runtimeVersion": "^1.0.0",
  "build": { "command": "pnpm build", "output": "dist" }
}
```

### Node
```json
{
  "runtime": "node",
  "runtimeVersion": "^1.0.0",
  "build": { "command": "pnpm build", "output": ".next" },
  "serve": { "start": "pnpm start", "healthCheck": "/api/health" }
}
```
