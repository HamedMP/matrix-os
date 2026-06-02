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
    related_skills: [matrix-design-system, matrix-app-ui-patterns, matrix-integrations, matrix-debug-app]
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
- For UI, ALWAYS load and follow `matrix-design-system` and `matrix-app-ui-patterns`. Key rules: Forest/Cream/Ember/Deep palette, gradient backgrounds (sand washes not flat), Orbitron H1/H2 only, Inter for everything else, capsule buttons/inputs (50px radius), glass cards (22px radius), inline SVG or bundled local icons (never text characters or remote icon scripts), stable window-sized layouts, and stagger animations on mount. No exceptions.
- Store structured app data through Matrix/Postgres bridge APIs, not ad hoc local databases.
- Never put provider secrets, API keys, or OAuth tokens inside the app directory.
- Do not use browser `localStorage` as app persistence in the Matrix shell. Sandboxed iframes can throw `SecurityError`; use `window.MatrixOS.db` and keep local fallback paths test-only/no-op.
- For default or first-party apps under `home/apps/**`, keep manifests deterministic: `runtime: "vite"`, `build.output: "dist"`, schema columns declared in `storage.tables`, and `icon` pointing to a committed asset in `home/system/icons/`.

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

## Naming

- `name` is the **human, Title-Case label** shown in the launcher, dock, and title bar — e.g.
  `"Calorie Tracker"`, `"Habit Garden"`. Make it short and real; never show the slug to users.
- `slug` is the lowercase, hyphenated id used in paths/URLs (`^[a-z0-9][a-z0-9-]{0,63}$`). Derive it
  from the name (`calorie-tracker`). It is internal — do not use it as a display string anywhere.

## Icon (required — or the app shows a broken tile)

The launcher loads each app's icon from `~/system/icons/<icon>.svg` (or `.png`) matching the manifest
`icon` field. **If you don't ship that file, `/icons/<icon>` 404s and the app gets a broken/placeholder
icon.** So always:

1. Set `"icon": "<slug>"` in `matrix.json` (use the app slug unless you have a better concept name).
2. Create `~/system/icons/<slug>.svg` — a crisp, single-concept mark: 24×24 `viewBox`, `stroke="currentColor"`
   lucide-style lines (or a tasteful filled mark in the Forest/Ember palette). No text characters, no
   remote icon scripts. Keep it simple and legible at small sizes.

```bash
cat > ~/system/icons/<slug>.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <!-- one clear concept for the app -->
</svg>
SVG
```

## Data (Postgres via the MatrixOS bridge)

Apps run in a sandboxed, null-origin iframe (CSP `connect-src 'self'`), so a direct `fetch()` to
`/api/bridge/*` is **blocked** and `localStorage` throws `SecurityError`. Persist ONLY through the
injected bridge:

- Declare your tables in `matrix.json` `storage.tables` (above). The gateway provisions the Postgres
  schema automatically — at startup for shipped apps, and **lazily on first query** for apps you build
  now, so a freshly-built app's `db` calls work without any restart.
- In code use `window.MatrixOS.db` (`find`/`findOne`/`insert`/`update`/`delete`/`count`/`onChange`).
  Guard for `undefined` (it's absent in unit tests), wrap every call in `try/catch` (log + user-visible
  error; never a bare catch), update local state optimistically, and reconcile on `onChange`.
- For external/third-party APIs use `window.MatrixOS.proxyFetch(url)` (allowlisted) — never a raw fetch.
- Do NOT add a `localStorage` fallback that runs in the shell; it throws in the sandbox. A guarded
  `try/catch` localStorage path is acceptable only as a no-op for the unit-test environment.

### Persistence Rules

- Declare every persisted field in `matrix.json` `storage.tables`, including audit fields such as
  `created_at`, best-score/best-time columns, and JSONB state payloads.
- Load from bridge storage on startup; do not seed duplicate fallback rows after real rows load.
- Roll back optimistic UI changes on failed creates, updates, deletes, and reorders. Keep pending deletes
  filtered from visible state until the bridge confirms or rolls back.
- Serialize dependent writes that update ordering, best scores, stats counters, or history rows. Avoid racing
  two bridge writes that can overwrite each other's derived state.
- Keep browser-only helpers guarded for tests. In production shell iframes, direct `localStorage` access and
  raw bridge `fetch()` calls are not reliable persistence.

## First-Party Default Apps

When editing bundled default apps in this repo:

- Keep app manifests and schema in `home/apps/<slug>/matrix.json`.
- Reuse the shared default-app Vite build path; do not add stale per-app package/runtime fields unless the
  app truly needs them.
- Run `node scripts/build-default-apps.mjs home/apps` before host-bundle work when default app source changed.
- Prefer the shared `game-center` icon for games unless a concrete shipped icon exists.
- Verify app icon slugs against `home/system/icons/<slug>.svg` or `.png`; never rely on runtime icon generation.

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

Use the injected `window.MatrixOS.db` bridge for structured data. Do not call `/api/bridge/query`
directly from app code; runtime apps load as sandboxed `srcdoc` iframes, and direct bridge fetches
are blocked by the shell's CORS/CSP boundary.

Example CRUD:

```ts
const db = window.MatrixOS?.db;
if (!db) throw new Error("Matrix data bridge is unavailable");

const tasks = await db.find("tasks", { orderBy: { created_at: "desc" } });
const created = await db.insert("tasks", { title: "Ship" });
await db.update("tasks", created.id, { done: true });
await db.delete("tasks", created.id);
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
