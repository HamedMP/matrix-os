---
name: matrix-app-builder
description: Build Matrix OS apps as Vite React TypeScript projects with matrix.json manifests, Matrix theme integration, Postgres-backed app data, and production build verification.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
metadata:
  agent:
    tags: [Matrix OS, apps, Vite, React, TypeScript]
    related_skills: [matrix-design-system, matrix-integrations, matrix-debug-app]
---

# Matrix App Builder

## When to Use

Use this when the user asks to build, create, fix, redesign, or publish a Matrix OS app.

## Non-Negotiables

- Build user-facing apps in `~/apps/<slug>/`.
- Default to Vite, React 19, TypeScript, and `runtime: "vite"`.
- CRM, roadmap, dashboard, admin, and data-heavy apps are still Vite React SPAs by default. Use Matrix/Postgres bridge APIs for data instead of creating Next.js API routes.
- Do not create Next.js, `.next/`, `app/` router files, `runtime: "node"`, `serve.start`, or `npm start` unless the user explicitly requests a server runtime or Next.js.
- Do not create plain HTML apps unless the user explicitly asks for a plain HTML app.
- Always create or update `matrix.json`.
- Always run `pnpm install` when dependencies changed and `pnpm build` before saying the app works.
- Verify `dist/index.html` exists.
- Use Matrix theme variables and iframe-safe sizing.
- For UI, use the `matrix-design-system` skill: shadcn-style primitives, lucide-react icons, stable control dimensions, and no marketing landing pages.
- Store structured app data through Matrix/Postgres bridge APIs, not SQLite or ad hoc local databases.
- Never put provider secrets, API keys, or OAuth tokens inside the app directory.

## Standard Structure

```text
~/apps/<slug>/
  matrix.json
  package.json
  vite.config.ts
  tsconfig.json
  index.html
  src/
    main.tsx
    App.tsx
    App.css
  dist/
    index.html
```

## Manifest

Use this baseline and adjust the app name, description, category, icon, and storage tables:

```json
{
  "name": "My App",
  "description": "A concise app description",
  "slug": "my-app",
  "version": "1.0.0",
  "runtime": "vite",
  "runtimeVersion": "^1.0.0",
  "listingTrust": "first_party",
  "icon": "my-app",
  "category": "productivity",
  "build": {
    "command": "pnpm build",
    "output": "dist"
  },
  "storage": {
    "tables": {}
  }
}
```

Valid storage column types include `text`, `boolean`, `integer`, `float`, `timestamptz`, `jsonb`, and `uuid`.

## Scaffold Commands

Prefer copying Matrix's bundled Vite template when it exists:

```bash
cp -a ~/apps/_template-vite ~/apps/<slug>
cd ~/apps/<slug>
pnpm install --prefer-offline
pnpm build
test -f dist/index.html
```

If the template is not present, create the standard Vite files directly with `react`, `react-dom`, `@vitejs/plugin-react`, `typescript`, and `vite`.

## Data Access

Use `/api/bridge/query` for structured data. Include a timeout on every fetch.

```ts
async function bridgeQuery(body: unknown) {
  const res = await fetch("/api/bridge/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Matrix data request failed");
  return res.json();
}
```

Example CRUD:

```ts
await bridgeQuery({ app: "todo", action: "find", table: "tasks" });
await bridgeQuery({ app: "todo", action: "insert", table: "tasks", data: { title: "Ship" } });
await bridgeQuery({ app: "todo", action: "update", table: "tasks", id, data: { done: true } });
await bridgeQuery({ app: "todo", action: "delete", table: "tasks", id });
```

## Integrations

If the app needs Gmail, Calendar, GitHub, Slack, Drive, or another provider, use Matrix integration APIs or the `matrix-integrations` skill. The platform owns provider credentials. The app never stores provider secrets.

## Verification

Before reporting done:

```bash
cd ~/apps/<slug>
pnpm build
test -f dist/index.html
node -e 'const m=require("./matrix.json"); if (m.runtime !== "vite" || m.build?.output !== "dist") process.exit(1)'
```

Then open the app in Matrix and check browser console for:

- `needs_build`
- 404s for app bundle or icon paths
- CORS errors from direct provider calls
- unhandled React errors
