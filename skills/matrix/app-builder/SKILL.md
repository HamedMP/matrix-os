---
triggers: ["build app", "create app", "Matrix app", "redesign app", "Postgres app"]
name: matrix-app-builder
description: Build Matrix OS apps as Vite React TypeScript projects with matrix.json manifests, Matrix theme integration, Postgres-backed app data, and production build verification.
version: 1.2.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
related_skills: [matrix-design-system, matrix-app-ui-patterns, matrix-integrations, matrix-debug-app, emil-design-eng, apple-design, animate, shadcn]
metadata:
  agent:
    tags: [Matrix OS, apps, Vite, React, TypeScript]
    related_skills: [matrix-design-system, matrix-app-ui-patterns, matrix-integrations, matrix-debug-app, emil-design-eng, apple-design, animate, shadcn]
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
- Always create or update `matrix.json`. For apps built for the owner, include `listingTrust: "first_party"` and `scope: "personal"`; missing trust blocks launch even if the build succeeds. Never relabel downloaded/store/community apps to bypass policy.
- Always run `pnpm install` when dependencies changed and `pnpm build` before saying the app works.
- Verify `dist/index.html` exists.
- Use injected Matrix theme variables and iframe-safe sizing. Choose a coherent product style from the brief, mood and references; use app-local semantic tokens for its palette/materials, with inherited Matrix tokens as the baseline when no direction is chosen.
- For UI, read `matrix-design-system`, `matrix-app-ui-patterns`, and [App craft](references/app-craft.md). Discover relevant installed skills through the active harness catalog (or `load_skill` in kernel routes). Read `emil-design-eng` for polish, `apple-design` for direct manipulation, and `animate` for specific motion work; load supporting references only for the chosen task. Preserve Matrix integration/runtime rules and choose typography, shapes, borders, layout, materials, color and motion for the app’s actual purpose.
- Store structured app data through Matrix/Postgres bridge APIs, not ad hoc local databases.
- Never put provider secrets, API keys, or OAuth tokens inside the app directory.
- Do not use browser `localStorage` as app persistence in the Matrix shell. Sandboxed iframes can throw `SecurityError`; use `window.MatrixOS.db` and keep local fallback paths test-only/no-op.
- For default or first-party apps under `home/apps/**`, keep manifests deterministic: `runtime: "vite"`, `build.output: "dist"`, schema columns declared in `storage.tables`, and `icon` pointing to a committed asset in `home/system/icons/`.

## Design workflow

1. Read [Visual references and style intake](references/visual-references.md), the craft reference, and the user’s images/links or existing DESIGN.md. Invite a style or inspiration screenshot when the direction is unclear. When available, delegate bounded similar-app screenshot research to one or two subagents, inspect the actual images, and select a task-appropriate direction. Offer annotated alternatives when useful or requested; continue independent work and use the user’s delegated default without a mandatory approval checkpoint.
2. Save a short app `DESIGN.md`: primary task, visual family and palette, layout and density, semantic tokens, typography/spacing, true data and state behavior, and one useful motion recipe with a reduced-motion variant. Keep it updated as the implementation changes.
3. Build one complete vertical slice against the owner's real Postgres through `window.MatrixOS.db`: read → create/edit → confirm or restore on failure → reopen. Verify it before expanding secondary screens. Never use convincing fake records to conceal a missing data path.
4. Inspect the running app in the available Matrix surfaces, refine the largest hierarchy or interaction problem, and inspect again. Check keyboard and reduced motion, not just the default screenshot. Record skills loaded, surface, viewport, theme, states, persistence result, and screenshot/recording evidence; report unavailable evidence explicitly.

For apps and matching landing pages, read [Responsive layout and verification](references/responsive-layout.md). Compose for actual app container width across varied Matrix windows and mobile screens; verify the listed widths and retain all meaningful fields/actions.

Avoid a generic welcome hero, decorative statistic cards, repeated glass containers, and automatic staggered entrances. The usable primary flow owns the first screen.

For requested shadcn UI, read the installed `shadcn` skill, [preset guidance](../shadcn/presets.md) and [charts](../shadcn/charts.md). Use real current components with the project’s actual config, approved package policy and semantic tokens. Choose one fresh coherent style for a new app when the user delegates direction; sample preset links are examples. Preserve existing local components/design during refinements.

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
  "scope": "personal",
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

## Presenting apps and charts in Chat

After verifying the app, link its owner-relative directory, for example
`[AI Adoption](~/apps/ai-adoption)`. Electron Desktop resolves installed app directories
against the app catalog and opens them through the normal launcher behavior.
Do not claim an arbitrary folder is an installed app.

Display saved charts or screenshots with Markdown images and full owner-relative
paths, for example `![AI adoption chart](~/apps/ai-adoption/chart-light.png)`.
Electron Desktop can display these images and open them in File Preview; do not tell the
user images can only appear in the agent's terminal. Use Markdown links for
other saved files. Static HTML previews are sandboxed without scripts; link
the installed app for an interactive chart rather than promising active HTML
execution inside Chat. Report missing files or preview failures truthfully.

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
2. Create `~/system/icons/<slug>.png` using the Matrix OS shipped-icon style:
   light premium iOS/macOS skeuomorphic app icon artwork, refined Apple-like product rendering,
   bright warm off-white or pale pastel background, subtle ceramic/glass depth, soft bevels, glossy
   highlights, realistic studio shadows, and a single large tactile 3D object or symbol that clearly
   represents the app. Keep the icon family aligned with Matrix OS forest, cream, ember, and deep accents.
   Do not include text, logos, watermarks, transparent backgrounds, black/dark dock
   backgrounds, empty padding, or a separate visible icon frame; the Matrix shell owns the final corner
   radius. Keep lighting and material treatment consistent with the shipped default app PNGs in
   `~/system/icons/`.

For first-party/default apps, prefer committed PNG icons from `home/system/icons/`. SVGs are acceptable
only for system chrome or simple compatibility fallbacks, not for newly generated app logos.

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

## Theme Inheritance

The shell injects `--matrix-*` tokens into every bridged app iframe and updates them on theme changes. Use those tokens as a baseline, then define app-local semantic tokens when the selected product style needs its own palette:

```css
:root {
  --app-bg: var(--matrix-bg, #FAFAF9);
  --app-fg: var(--matrix-fg, #32352E);
  --app-card: var(--matrix-card, #FCFCF8);
  --app-primary: var(--matrix-primary, #434E3F);
  --app-primary-fg: var(--matrix-primary-fg, #FAFAF5);
  --app-accent: var(--matrix-accent, #D06F25);
  --app-success: var(--matrix-success, #3A7D44);
  --app-warning: var(--matrix-warning, #E0A12E);
  --app-danger: var(--matrix-destructive, #D74A3A);
  --app-border: var(--matrix-border, #D8D6C7);
}
```

Use the inherited shell fonts (`var(--matrix-font-sans)`, `var(--matrix-font-mono)`) instead of loading remote font stylesheets. A chosen product style may use bright, playful, retro, minimal, neo-brutalist or neumorphic art direction. Scope palette, surfaces and materials to app-local semantic tokens. Keep focus/status readable, support the selected modes, and preserve Matrix bridge behavior. Do not override the owner’s global shell theme.

### Persistence Rules

- Declare every persisted field in `matrix.json` `storage.tables`, including audit fields such as
  `created_at`, best-score/best-time columns, and JSONB state payloads.
- Load from bridge storage on startup; do not seed duplicate fallback rows after real rows load.
- Roll back optimistic UI changes on failed creates, updates, deletes, and reorders. Keep pending deletes
  filtered from visible state until the bridge confirms or rolls back.
- Do not confuse sequential requests with a database transaction. Keep a single-entity change in one
  bridge write; use the documented `bulkUpdate`/`bulkInsert` operation when it matches the atomic operation.
  If a workflow requires multiple related writes across operations, use an existing server transaction
  boundary or redesign the schema/action to one write; do not invent a `db.transaction()` API.
- Cap queries with `limit` and paginate large collections. Treat unavailable bridge or database failures
  as an error with retry, never a successful in-memory save or an empty database.
- Serialize saves to the same record and prevent duplicate submissions. Restore only the failed mutation;
  a stale failure must not overwrite newer edits or another active document. Keep unsaved text available.
  Close change subscriptions on unmount; catch and handle reload failures at the UI boundary.
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
node <resolved-matrix-app-builder-skill-directory>/scripts/verify-app.mjs "$PWD"
```

Resolve the skill directory from the SKILL.md you loaded; the script ships beside it and needs no dependencies. Run it on the actual app directory, not the template. It verifies the owner-built Vite manifest and production entry; it never changes trust or proves a live login.

### Launch and authentication

Matrix supplies owner authentication. Do not build a separate login page or read/copy gateway credentials into the app. The native launcher obtains a short-lived token through `POST /api/apps/<slug>/session-token`; the launch is `/apps/<slug>/`. Missing or unknown `listingTrust` yields `403 install_blocked_by_policy`, not an expired login. An existing app you just built for the owner can have its missing metadata corrected after checking its origin; never silently promote an imported app. `401` means authentication, `403` policy, `409` scope/acknowledgment, `404` discovery, and `5xx` a server failure. Report failures accurately instead of recommending sign-in for all of them. Do not disable authentication, weaken policy, restart the VPS, or add a server to work around a launch failure.

Then open the app from the Matrix launcher using the existing authenticated session. Verify app assets, icon, bridge operations, a save/reopen round trip, and the craft reference's visual/state checks. If browser access is unavailable, report launch and visual verification as pending rather than claiming the app works. Check browser console/network for:

- `needs_build`
- 404s for app bundle or icon paths
- CORS errors from direct provider calls
- unhandled React errors
