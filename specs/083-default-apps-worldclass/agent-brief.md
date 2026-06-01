# Agent Brief — World-Class Default Apps (spec 083)

You are building **one** Matrix OS default app to a world-class, shippable standard.
Treat your app as if it is your company's only product. No mock UI. No placeholder
metrics. Real interaction, real persistence, real polish.

Read this entire brief before writing code. Then read your app's section in `spec.md`.

---

## 0. Hard constraints (do not violate)

- **Touch ONLY these paths:**
  - `home/apps/<your-slug>/**` (your whole app directory)
  - `home/system/icons/<your-icon>.svg` (your app's icon, only if it doesn't exist or needs improvement)
  - `tests/default-apps/<your-slug>-app.test.tsx` (and any `*-model.ts` test for pure logic)
- **NEVER edit** `home/apps/_shared/**` (theme.css, default-apps.tsx), other apps' directories,
  shared test files, gateway/shell source, or any manifest test. The lead integrates those.
- **NEVER run git** (no add/commit/push/checkout/stash). The lead commits. Just leave your files on disk.
- **NEVER run the global build** (`scripts/build-default-apps.mjs`). Build only your own app dir.
- Do not modify `pnpm-workspace.yaml`, root `package.json`, or root lockfile.
- If you think you need to change a shared file, STOP and say so in your final report instead.

## 1. Tech + file structure

Each app is a self-contained Vite + React + TypeScript SPA built to `dist/`:

```
home/apps/<slug>/
  matrix.json        # manifest (see §4)
  index.html         # <div id="root"></div> + module script to src/main.tsx
  package.json       # app-local deps (react, react-dom, vite, lucide-react, etc.)
  vite.config.ts     # @vitejs/plugin-react, base "./"
  tsconfig.json
  src/
    main.tsx         # createRoot(...).render(<App/>)
    App.tsx          # your app
    styles.css       # imported by App.tsx, uses theme tokens (§3)
    matrix-os.d.ts   # canonical bridge types (§2) — copy verbatim
    <pure logic>.ts  # game engine / model — keep UI-free and unit-testable
```

Copy `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json` shape from an existing
real app: **`home/apps/pomodoro/`** (timer + DB) or **`home/apps/notes/`** (richer). Match their
build config exactly. Use `lucide-react` for icons. React 19. No external CDNs.

## 2. Data — the MatrixOS DB bridge (canonical types)

> **HARD RULE — the #1 cause of broken apps. Read twice.**
> Apps run inside a **sandboxed `srcdoc` iframe with `origin: null`** and a strict CSP
> (`connect-src 'self'`). Therefore:
> - **NEVER call `fetch()` to `/api/bridge/*` (or any URL) directly.** It is blocked by both CORS
>   (null origin) and CSP. The shell shows `Access-Control-Allow-Origin … blocked` and the app breaks.
> - **`localStorage` may throw `SecurityError`** in this sandbox — do not rely on it in the shell.
>   It is fine only as a guarded fallback for the jsdom test environment.
> - The **only** valid persistence transport is the injected `window.MatrixOS` bridge
>   (`db.*`, and `readData`/`writeData`), which uses `postMessage` to the parent shell. Use it.
> - **External APIs are also blocked** by `connect-src 'self'` — you cannot fetch third-party URLs
>   from the iframe. If your app wants external data, degrade gracefully to seeded/demo data.
> Verdict: route ALL persistence through `window.MatrixOS.db`. Guard for `undefined` (tests). Never `fetch`.


If your app has durable structured data, declare tables in `matrix.json` `storage` (§4) and use
`window.MatrixOS.db`. It is injected by the shell and proxies to owner-controlled Postgres via the
gateway. **The bridge always returns rows with an auto-generated `id` (uuid) and `created_at`
(timestamptz). Do not declare those columns yourself.**

Write `src/matrix-os.d.ts` EXACTLY as below (this is the real injected contract):

```ts
interface MatrixOSDb {
  find(table: string, opts?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, "asc" | "desc">;
    limit?: number;
    offset?: number;
  }): Promise<Record<string, unknown>[]>;
  findOne(table: string, id: string): Promise<Record<string, unknown> | null>;
  insert(table: string, data: Record<string, unknown>): Promise<{ id: string }>;
  update(table: string, id: string, data: Record<string, unknown>): Promise<{ ok: boolean }>;
  delete(table: string, id: string): Promise<{ ok: boolean }>;
  count(table: string, filter?: Record<string, unknown>): Promise<number>;
  onChange(table: string, callback: (e: { table: string }) => void): () => void;
}
interface MatrixOS {
  db?: MatrixOSDb;
  theme?: Record<string, string>;
  app?: { name: string };
  readData?(key: string): Promise<unknown>;
  writeData?(key: string, value: unknown): Promise<void>;
  // External APIs are CSP-blocked from the iframe; proxy GETs to an allowlisted
  // host through the gateway. Allowlist lives in the gateway (/api/bridge/proxy).
  proxyFetch?(url: string): Promise<unknown>;
}
declare global {
  interface Window { MatrixOS?: MatrixOS; }
}
export {};
```

**Rules for using the DB (these are graded):**
- `window.MatrixOS?.db` may be `undefined` (e.g. unit tests, KV-only mode). Guard every access.
- Wrap every bridge call in `try/catch`; on failure set a user-visible error string and a
  `console.warn`. **Never bare `catch {}` and never `catch { return null }`.** Distinguish failure
  from empty.
- Optimistic UI: update local state immediately, persist in the background, reconcile on `onChange`.
- Subscribe with `onChange` and reload; always clean up the unsubscribe in `useEffect`.
- Pure local-only state (no cross-session durability needed) may use `localStorage`. Prefer the DB
  for anything the user would expect to persist (notes, tasks, expenses, high scores, settings).

## 3. Design language (consume theme tokens — never redefine the palette)

The shell injects a theme. Your `styles.css` must consume these CSS variables (with fallbacks)
so the app re-themes live. Reference `home/apps/_shared/theme.css` for the full token set; the
core ones:

```css
:root {
  --app-bg: var(--matrix-bg, #FAFAF5);
  --app-fg: var(--matrix-fg, #32352E);
  --app-card: var(--matrix-card, #ffffff);
  --app-muted: var(--matrix-muted, #F0EDE4);
  --app-muted-fg: var(--matrix-muted-fg, #7A7768);
  --app-border: var(--matrix-border, #D6D3C8);
  --app-primary: var(--matrix-primary, #434E3F);
  --app-primary-fg: var(--matrix-primary-fg, #FAFAF5);
  --app-accent: var(--matrix-accent, #D06F25);
  --app-success: var(--matrix-success, #3A7D44);
  --app-warning: var(--matrix-warning, #D49B2A);
  --app-danger: var(--matrix-destructive, #C4342D);
  --app-radius: var(--matrix-radius, 22px);
  --app-font: var(--matrix-font-sans, 'Inter', system-ui, sans-serif);
  --app-mono: var(--matrix-font-mono, 'JetBrains Mono', monospace);
}
* { box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; margin: 0; }
body { overflow: hidden; -webkit-font-smoothing: antialiased; }
```

Visual bar (the light Matrix product language — warm neutral surfaces, soft shadows, generous radius):
- Soft elevation: `box-shadow: 0 4px 12px rgba(50,53,46,0.08)`. Avoid hard borders where a shadow reads better.
- Generous radius (cards ~18–22px, controls ~12–14px), comfortable padding, real whitespace.
- Smooth `transition: all .15s ease`; hover via `color-mix(in srgb, var(--app-fg) 4%, transparent)`.
- Accent color for the single primary action per view; everything else calm.
- The app runs in a fixed window: `height: 100vh; overflow: hidden`, scroll inside panels only.
- **Empty states are onboarding:** icon + headline + one-line description + a clear first action.
- **No layout shift:** transient panels overlay, never push content. Click-to-open / click-to-close.
- Keyboard: support the obvious shortcuts for your domain (Enter to add, arrows/WASD for games,
  Cmd/Ctrl+Z undo where relevant, Esc to dismiss). Focus states use the accent color.
- Animation with intent: tile merges, line clears, card flips, timer rings — motion that conveys
  state, not decoration. Respect `prefers-reduced-motion`.

This is the bar: a user should not be able to tell your app from the benchmark competitor named in
your spec section. If it looks like a generic dashboard, you have failed.

## 4. Manifest (`matrix.json`)

Match this shape (copy from pomodoro/notes and adapt). `slug` and `icon` are required.

```json
{
  "name": "Human Name",
  "description": "One sharp sentence.",
  "category": "productivity|utility|games|finance|social|developer|...",
  "icon": "<icon-slug>",
  "author": "system",
  "version": "1.0.0",
  "slug": "<slug>",
  "runtime": "vite",
  "runtimeVersion": "^1.0.0",
  "scope": "personal",
  "storage": { "tables": { "<table>": { "columns": { "col": "text|integer|float|boolean|timestamptz|jsonb" }, "indexes": ["col"] } } },
  "build": {
    "install": "pnpm install --ignore-workspace --prefer-offline",
    "command": "pnpm build",
    "output": "dist",
    "timeout": 180
  },
  "listingTrust": "first_party"
}
```

- `icon` must be a slug that has (or will have, created by you) a matching shipped icon asset under
  `home/system/icons/<icon>.png` or `.svg`. The current preferred generated raster direction is light
  iOS/macOS skeuomorphic source artwork: full square image with the background continuing into all
  four square corners, no rounded canvas corners, no rounded-square tile, no black/dark/transparent
  corner mask, glossy ceramic/glass object, no text, no logos. Do not reuse an unrelated icon. Games
  must not share `game-center`; every game gets a concrete icon.
- Omit `storage` entirely if the app has no durable structured data.

## 5. TDD (non-negotiable — this repo enforces it)

1. **Red:** write `tests/default-apps/<slug>-app.test.tsx` FIRST. Use the pattern in
   `tests/default-apps/pomodoro-app.test.tsx`: `// @vitest-environment jsdom`,
   `@testing-library/react`, a fake `window.MatrixOS.db` (`vi.fn`), import `App` from
   `../../home/apps/<slug>/src/App`. Assert real behavior (renders, core interaction works,
   persistence calls the bridge with the right args, empty state shows).
   For game/rule logic, ALSO write a pure unit test of the engine (e.g. `<slug>-model.test.ts`)
   covering legal moves / win detection / scoring.
2. Run it, watch it fail for the right reason.
3. **Green:** implement until tests pass.
4. **Refactor** with tests green.

Run your tests from the repo root:
```
pnpm vitest run tests/default-apps/<slug>-app.test.tsx tests/default-apps/<slug>-model.test.ts
```

## 6. Build + verify (your app only)

**Two build models exist — match what your app already uses; do NOT change the build block.**

- **Root-toolchain apps (most apps + ALL games):** they have NO `package.json`. Their manifest uses
  `"install": "true"` and `"command": "vite build --base ./ --outDir dist"`. They build from the repo
  root `node_modules` (react, react-dom, lucide-react, vite, @vitejs/plugin-react are all there — vite
  resolves upward). **Do NOT create a `package.json`, do NOT run `pnpm install`.**
- **App-local apps (notes, pomodoro):** they have their own `package.json` + lockfile and use
  `"command": "pnpm build"`. Keep that.

**Build + verify YOUR app only** by targeting the per-app build script at your directory (safe, no
concurrency with other agents, respects your manifest's own build config):

```
node scripts/build-default-apps.mjs home/apps/<dir>        # e.g. home/apps/calculator
node scripts/build-default-apps.mjs home/apps/games/<game> # e.g. home/apps/games/2048
```

This must produce `dist/index.html`. Do NOT run the script against the whole `home/apps` tree.
Keep the existing `matrix.json` `build` block as-is; you may edit name/description/category/icon/storage.

## 7. Definition of done (report all of these)

- [ ] `matrix.json` valid: `runtime: "vite"`, `slug`, `icon` with a shipped `home/system/icons/<icon>.svg`,
      `storage` declared iff the app has durable data.
- [ ] Real `src/App.tsx` (no mock metrics), `styles.css` consuming theme tokens, `src/matrix-os.d.ts` from §2.
- [ ] Pure logic (engines/models) separated and unit-tested where applicable.
- [ ] `tests/default-apps/<slug>-app.test.tsx` written first and passing; model test passing.
- [ ] `pnpm build` succeeds → `dist/index.html` exists.
- [ ] DB usage (if any) guarded, try/catch with typed handling, `onChange` cleanup, optimistic UI.
- [ ] Empty state, keyboard support, light Matrix polish, no layout shift.
- [ ] You did NOT touch shared files or run git.

**Final report back to lead must include:** files created/changed (paths), the benchmark you targeted,
key interactions implemented, test command + result (paste pass summary), build result, the DB tables
used, and anything you could not finish or any shared-file change you think is needed.
