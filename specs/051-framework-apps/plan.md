# Plan 051: Framework Apps (Build-to-Static)

Implementation plan for spec 051. Four phases, dependency-ordered, TDD throughout.

## Research Notes

Patterns identified from industry research that inform implementation decisions:

1. **Discord embedded-app-sdk pattern**: Discord's Activities platform uses a typed SDK over postMessage for sandboxed iframe apps. The SDK provides a command/event interface that abstracts the raw postMessage protocol. Our `@matrix-os/sdk` follows this same pattern -- typed wrappers over postMessage for IPC, direct HTTP fetch for data. Origin validation on all incoming messages.

2. **Vite library mode for SDK**: Build the SDK with Vite's `build.lib` option. React and react-dom are peerDependencies (externalized from the bundle), preventing duplicate React instances in consumer apps. The SDK ships ESM-only (`"type": "module"`) with TypeScript declarations. Reference: Vite docs on library mode + community guides on React component library patterns.

3. **Vite `base` for subdirectory serving**: Vite's `base` config option prefixes all generated asset URLs (JS, CSS, images) with the specified path. Critical for serving from `/files/apps/{slug}/dist/`. Files in `public/` are copied as-is to `outDir`. The `base` must match the gateway's static file serving path exactly.

4. **pnpm workspace `file:` protocol**: Internal workspace packages are resolved via `file:` dependencies in consumer package.json. In Docker, the monorepo is mounted at `/app`, so `"@matrix-os/sdk": "file:/app/packages/sdk"` resolves correctly. No npm publishing needed for local development. The `file:` protocol creates a symlink, so SDK changes are picked up on next build without reinstalling.

5. **postMessage origin validation**: All incoming messages must be validated against the expected parent origin to prevent XSS. The SDK should check `event.origin` matches the gateway URL before processing any message. This hardens the existing bridge pattern which currently uses `"*"` as target origin.

## Phase 1: Foundation (T1 + T6)

No dependencies. Can start immediately.

### T1: Manifest Schema Extensions

**File**: `packages/gateway/src/app-manifest.ts`
**Test file**: `tests/gateway/app-manifest.test.ts`

Add two new fields to `AppManifestSchema`:

```ts
system: z.array(z.string()).default([]),
build: z.object({
  install: z.string().default("pnpm install"),
  command: z.string().default("pnpm build"),
  output: z.string().default("dist"),
}).optional(),
```

Tests:
- Parse manifest with `build` and `system` fields
- Parse manifest with partial `build` (defaults applied)
- Parse manifest without `build`/`system` (backwards compat)
- Parse manifest with empty `system: []`
- Reject invalid `build.output` (empty string)
- Existing manifests (todo, calculator, clock) still parse correctly

### T6: Dockerfile Sudo Changes

**File**: `Dockerfile.dev`

Add after the existing `apk add` line:

```dockerfile
RUN apk add --no-cache sudo \
 && echo "matrixos ALL=(root) NOPASSWD: /sbin/apk" >> /etc/sudoers.d/matrixos-apk \
 && chmod 0440 /etc/sudoers.d/matrixos-apk
```

Verification: `docker compose exec dev su-exec matrixos sudo apk add --no-cache --simulate curl` should succeed. `su-exec matrixos sudo ls /root` should fail.

## Phase 2: Gateway (T2 + T3)

Depends on Phase 1 (manifest schema).

### T2: Gateway `listApps` Entry Field Support

**File**: `packages/gateway/src/apps.ts`
**Test file**: `tests/gateway/apps.test.ts`

Change in `scanAppsDir`: when a directory has a manifest with `entry`, use `manifest.entry` instead of hardcoded `"index.html"` for `file` and `path` construction.

Add build-output visibility check: if `manifest.build` is defined, check that `{appDir}/{build.output}/index.html` exists. If not, skip the app (don't list unbuilt apps).

```ts
const entry = manifest.entry ?? "index.html";
const buildOutput = manifest.build?.output;

// Skip unbuilt framework apps
if (buildOutput) {
  const outputIndex = join(fullPath, buildOutput, "index.html");
  if (!existsSync(outputIndex)) continue;
}

result.push({
  name: manifest.name,
  // ...
  file: `${relativePath}/${entry}`,
  path: `/files/apps/${relativePath}/${entry}`,
});
```

Tests:
- Directory app with `entry: "dist/index.html"` returns correct path
- Directory app without `entry` defaults to `index.html`
- Framework app with `build` defined but no `dist/` directory is skipped
- Framework app with `build` defined and `dist/index.html` present is listed
- Existing static directory apps (todo, calculator) still listed correctly
- Mix of static and framework apps returns correct paths for each

### T3: AppManager Entry Field Support

**File**: `packages/gateway/src/app-manager.ts`
**Test file**: `tests/gateway/app-manager.test.ts`

Update `register()` to read `manifest.entry` for path construction. Set status based on build output existence.

```ts
const entry = manifest.entry ?? "index.html";
const path = isDir ? `/files/apps/${slug}/${entry}` : `/files/apps/${slug}.html`;

// Status: check if build output exists for framework apps
let status: AppStatus["status"] = "running";
if (manifest.build) {
  const outputPath = join(dir, manifest.build.output ?? "dist", "index.html");
  status = existsSync(outputPath) ? "running" : "stopped";
}
```

Tests:
- Register framework app with `entry: "dist/index.html"` sets correct path
- Register framework app without `dist/` sets status `"stopped"`
- Register framework app with `dist/index.html` sets status `"running"`
- Register static app unchanged behavior
- `scanAndRegister` picks up mix of static and framework apps

## Phase 3: SDK (T4 + T5)

Independent of Phase 2. Can run in parallel with Phase 2.

### T4: `@matrix-os/sdk` Core Client

**New package**: `packages/sdk/`

Structure:
```
packages/sdk/
  src/
    core.ts          createMatrixOS() factory
    db.ts            Database client (fetch-based)
    ipc.ts           postMessage IPC (generate, navigate, openApp)
    theme.ts         Theme reader (CSS custom properties)
    types.ts         Shared types
    index.ts         Main export (re-exports core + types)
  package.json
  tsconfig.json
  vite.config.ts     Library mode build config
```

**package.json**:
```json
{
  "name": "@matrix-os/sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./react": { "import": "./dist/react.js", "types": "./dist/react.d.ts" }
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true },
    "react-dom": { "optional": true }
  },
  "devDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "vite": "^6.0.0",
    "typescript": "^5.5.0"
  }
}
```

React is a peerDependency (externalized from bundle) to prevent duplicate React instances. It's optional so the core client works without React (e.g., in a vanilla JS context or Node.js test).

**vite.config.ts** (library mode build):
```ts
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        react: resolve(__dirname, "src/react.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
    },
  },
});
```

**Core client** (`core.ts`):

`createMatrixOS({ app })` returns an object with:
- `db.find(table, opts?)` -- POST to `/api/bridge/query` with `{ app, action: "find", table, ...opts }`
- `db.findOne(table, id)` -- POST with `{ action: "findOne" }`
- `db.insert(table, data)` -- POST with `{ action: "insert" }`
- `db.update(table, id, data)` -- POST with `{ action: "update" }`
- `db.delete(table, id)` -- POST with `{ action: "delete" }`
- `db.count(table, filter?)` -- POST with `{ action: "count" }`
- `getTheme()` -- reads `--matrix-*` CSS custom properties from `document.documentElement`
- `generate(context)` -- postMessage `{ type: "os:generate", app, payload: { context } }` to parent
- `navigate(route, context?)` -- postMessage `{ type: "os:navigate" }` to parent
- `openApp(name, path)` -- postMessage `{ type: "os:open-app" }` to parent

The `db.*` methods mirror the existing injected `MatrixOS.db.*` API exactly (same POST body shape, same endpoint). This ensures framework apps and legacy HTML apps hit the same backend.

**Origin validation**: postMessage calls use the gateway origin (derived from `window.location.origin` or a config option) instead of `"*"`. Incoming message handlers validate `event.origin` before processing.

**Test file**: `tests/sdk/core.test.ts`

Tests (mock `fetch` and `postMessage`):
- `db.find` sends correct POST body
- `db.insert` returns created record
- `db.update` sends correct id and data
- `db.delete` sends correct id
- `db.count` returns number
- `generate()` posts correct message type to parent
- `openApp()` posts correct message type to parent
- `getTheme()` reads CSS custom properties
- Origin validation rejects messages from wrong origin

### T5: `@matrix-os/sdk` React Hooks

**File**: `packages/sdk/src/react.ts`
**Test file**: `tests/sdk/react.test.ts`

Two hooks:

**`useMatrixDB(table, opts?)`**:
- Calls `db.find(table, opts)` on mount
- Returns `{ data, loading, error, refetch }`
- Subscribes to `message` events on `window`
- When an `os:data-change` message arrives for the matching table, calls `refetch()`
- Cleans up event listener on unmount
- Re-fetches when `table` or `opts` change (shallow comparison)

**`useTheme()`**:
- Reads CSS custom properties on mount via `getTheme()`
- Subscribes to `os:theme-update` postMessage events
- On theme update, patches `:root` CSS custom properties and updates React state
- Returns `ThemeVars` object

Tests (React Testing Library + vitest):
- `useMatrixDB` fetches on mount and returns data
- `useMatrixDB` shows loading state before data arrives
- `useMatrixDB` re-fetches when `os:data-change` event fires for matching table
- `useMatrixDB` ignores `os:data-change` for different table
- `useMatrixDB` cleans up listener on unmount
- `useTheme` returns initial CSS properties
- `useTheme` updates on `os:theme-update` message

## Phase 4: Integration (T7 + T8)

Depends on Phases 1-3.

### T7: Agent Knowledge File

**File**: `home/agents/knowledge/framework-apps.md`

Content covers:
1. Decision criteria: when to use framework apps vs single-file HTML
2. Scaffold template with full file listing and example content
3. SDK usage patterns with code examples
4. SDK resolution: `"@matrix-os/sdk": "file:/app/packages/sdk"`
5. Build commands: `pnpm install && pnpm build`
6. System deps: `sudo apk add --no-cache {pkg}`
7. Vite base path: must match `/files/apps/{slug}/dist/`
8. Rebuild instructions

No tests (knowledge file is markdown).

### T8: E2E Validation

**Test file**: `tests/integration/framework-app.test.ts`

Integration test that validates the full flow:
1. Create a temporary app directory with `matrix.json` (runtime: node, framework: vite-react, build, entry)
2. Verify `listApps` skips the app (no dist/ yet)
3. Create a minimal `dist/index.html` (simulate build output)
4. Verify `listApps` now includes the app with correct path
5. Verify `AppManager.register()` sets correct path and status
6. Verify the gateway serves `dist/index.html` at `/files/apps/{slug}/dist/index.html`

This is a unit/integration test against the gateway functions, not a full Docker E2E test. The full scaffold-build-serve flow is validated manually in Docker.

## Dependency Graph

```
Phase 1 (no deps)          Phase 3 (no deps)
  T1: manifest schema        T4: SDK core
  T6: Dockerfile sudo        T5: SDK hooks (depends on T4)
       |                          |
       v                          |
Phase 2 (depends on T1)          |
  T2: listApps entry             |
  T3: AppManager entry           |
       |                          |
       +-----------+--------------+
                   |
                   v
             Phase 4 (depends on all)
               T7: knowledge file
               T8: E2E validation
```

Phase 1 and Phase 3 can execute in parallel. Phase 2 blocks on Phase 1. Phase 4 blocks on everything.

## Files Created / Modified

| Action | File |
|--------|------|
| Modify | `packages/gateway/src/app-manifest.ts` |
| Modify | `packages/gateway/src/apps.ts` |
| Modify | `packages/gateway/src/app-manager.ts` |
| Modify | `Dockerfile.dev` |
| Modify | `pnpm-workspace.yaml` (add `packages/sdk`) |
| Create | `packages/sdk/package.json` |
| Create | `packages/sdk/tsconfig.json` |
| Create | `packages/sdk/vite.config.ts` |
| Create | `packages/sdk/src/core.ts` |
| Create | `packages/sdk/src/db.ts` |
| Create | `packages/sdk/src/ipc.ts` |
| Create | `packages/sdk/src/theme.ts` |
| Create | `packages/sdk/src/types.ts` |
| Create | `packages/sdk/src/index.ts` |
| Create | `packages/sdk/src/react.ts` |
| Create | `home/agents/knowledge/framework-apps.md` |
| Create | `tests/gateway/app-manifest-build.test.ts` |
| Create | `tests/gateway/apps-entry.test.ts` |
| Create | `tests/gateway/app-manager-entry.test.ts` |
| Create | `tests/sdk/core.test.ts` |
| Create | `tests/sdk/react.test.ts` |
| Create | `tests/integration/framework-app.test.ts` |

## Estimated Test Count

- T1 manifest: ~8 tests
- T2 listApps: ~8 tests
- T3 AppManager: ~6 tests
- T4 SDK core: ~12 tests
- T5 SDK hooks: ~10 tests
- T8 E2E: ~6 tests
- **Total: ~50 new tests**
