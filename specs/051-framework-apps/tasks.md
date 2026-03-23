# Tasks 051: Framework Apps (Build-to-Static)

## Phase 1: Foundation

### T1: Manifest schema extensions
- **Status**: pending
- **File**: `packages/gateway/src/app-manifest.ts`
- **Test**: `tests/gateway/app-manifest-build.test.ts`
- **Blocked by**: none
- **Description**: Add `system` (string array, default `[]`) and `build` (object with `install`/`command`/`output`, optional) to `AppManifestSchema`. Write Zod schema additions. Verify backwards compatibility with existing manifests.
- **Acceptance**:
  - [ ] `system` field parses as string array, defaults to `[]`
  - [ ] `build` field parses with defaults (`pnpm install`, `pnpm build`, `dist`)
  - [ ] Manifests without `build`/`system` parse unchanged
  - [ ] Existing `todo`, `calculator`, `clock` manifests still valid
  - [ ] All new tests pass

### T6: Dockerfile sudo changes
- **Status**: pending
- **File**: `Dockerfile.dev`
- **Blocked by**: none
- **Description**: Add `sudo` package and scoped sudoers rule allowing `matrixos` user to run `/sbin/apk` without password. No other sudo access granted.
- **Acceptance**:
  - [ ] `sudo apk add --no-cache --simulate curl` succeeds as matrixos user
  - [ ] `sudo ls /root` fails as matrixos user
  - [ ] Existing container build succeeds
  - [ ] Entrypoint still works (services start as matrixos)

## Phase 2: Gateway

### T2: Gateway `listApps` entry field support
- **Status**: pending
- **File**: `packages/gateway/src/apps.ts`
- **Test**: `tests/gateway/apps-entry.test.ts`
- **Blocked by**: T1
- **Description**: Update `scanAppsDir` to use `manifest.entry` (default `"index.html"`) for `file` and `path` construction. Add build-output visibility check: skip apps where `manifest.build` is defined but `{build.output}/index.html` does not exist.
- **Acceptance**:
  - [ ] App with `entry: "dist/index.html"` returns path `/files/apps/{slug}/dist/index.html`
  - [ ] App without `entry` defaults to `/files/apps/{slug}/index.html`
  - [ ] Framework app with `build` but no `dist/` is not listed
  - [ ] Framework app with `build` and `dist/index.html` is listed
  - [ ] Existing static apps unaffected
  - [ ] All new tests pass

### T3: AppManager entry field support
- **Status**: pending
- **File**: `packages/gateway/src/app-manager.ts`
- **Test**: `tests/gateway/app-manager-entry.test.ts`
- **Blocked by**: T1
- **Description**: Update `register()` to use `manifest.entry` for path. Set status to `"stopped"` when `manifest.build` is defined but build output missing, `"running"` when output exists.
- **Acceptance**:
  - [ ] Framework app path uses `entry` field
  - [ ] Status `"stopped"` when `dist/index.html` missing
  - [ ] Status `"running"` when `dist/index.html` exists
  - [ ] Static app registration unchanged
  - [ ] All new tests pass

## Phase 3: SDK

### T4: `@matrix-os/sdk` core client
- **Status**: pending
- **Files**: `packages/sdk/` (new package)
- **Test**: `tests/sdk/core.test.ts`
- **Blocked by**: none
- **Description**: Create `packages/sdk/` workspace package. Implement `createMatrixOS({ app })` factory returning `db.*` (fetch-based to `/api/bridge/query`), `getTheme()` (CSS custom properties), `generate()`/`navigate()`/`openApp()` (postMessage to parent). Build with Vite library mode, React as optional peerDependency.
- **Subtasks**:
  - [ ] Create `packages/sdk/package.json` with peerDependencies on react/react-dom
  - [ ] Create `packages/sdk/vite.config.ts` with library mode, externalize react
  - [ ] Add `packages/sdk` to `pnpm-workspace.yaml`
  - [ ] Implement `db.ts`: find, findOne, insert, update, delete, count (all POST to `/api/bridge/query`)
  - [ ] Implement `ipc.ts`: generate, navigate, openApp (postMessage with origin validation)
  - [ ] Implement `theme.ts`: getTheme reads `--matrix-*` CSS vars
  - [ ] Implement `core.ts`: createMatrixOS factory
  - [ ] Implement `types.ts`: ThemeVars, DBQuery, DBResult, MatrixOSClient
  - [ ] Implement `index.ts`: re-export core + types
  - [ ] Write tests for all db methods (mock fetch)
  - [ ] Write tests for IPC methods (mock postMessage)
  - [ ] Write tests for theme reader (mock CSS properties)
  - [ ] Write test for origin validation
- **Acceptance**:
  - [ ] `pnpm install` resolves `@matrix-os/sdk` in workspace
  - [ ] `pnpm build` in `packages/sdk/` produces `dist/index.js` + `dist/react.js`
  - [ ] Core client works without React installed
  - [ ] All new tests pass

### T5: `@matrix-os/sdk` React hooks
- **Status**: pending
- **File**: `packages/sdk/src/react.ts`
- **Test**: `tests/sdk/react.test.ts`
- **Blocked by**: T4
- **Description**: Implement `useMatrixDB(table, opts?)` and `useTheme()` hooks. `useMatrixDB` fetches on mount, re-fetches on `os:data-change` postMessage for matching table, returns `{ data, loading, error, refetch }`. `useTheme` reads CSS properties on mount, updates on `os:theme-update` postMessage.
- **Subtasks**:
  - [ ] Implement `useMatrixDB`: fetch on mount, loading/error/data state
  - [ ] Implement `useMatrixDB`: subscribe to `os:data-change` window message events
  - [ ] Implement `useMatrixDB`: re-fetch when table or opts change (shallow compare)
  - [ ] Implement `useMatrixDB`: cleanup listener on unmount
  - [ ] Implement `useTheme`: read CSS properties on mount
  - [ ] Implement `useTheme`: subscribe to `os:theme-update` messages
  - [ ] Implement `useTheme`: patch `:root` CSS vars on update
  - [ ] Export both hooks from `react.ts`
  - [ ] Write tests with React Testing Library
- **Acceptance**:
  - [ ] `useMatrixDB` shows loading then data
  - [ ] `useMatrixDB` re-fetches on matching `os:data-change`
  - [ ] `useMatrixDB` ignores `os:data-change` for different table
  - [ ] `useMatrixDB` cleans up on unmount
  - [ ] `useTheme` returns theme vars
  - [ ] `useTheme` updates on `os:theme-update`
  - [ ] All new tests pass

## Phase 4: Integration

### T7: Agent knowledge file
- **Status**: pending
- **File**: `home/agents/knowledge/framework-apps.md`
- **Blocked by**: T4, T5
- **Description**: Create knowledge file teaching the kernel when and how to scaffold Vite + React apps. Covers decision criteria, scaffold template, SDK patterns, build commands, system deps, base path, rebuild flow.
- **Acceptance**:
  - [ ] Knowledge file covers all 8 topics from spec section G
  - [ ] Includes complete file structure template
  - [ ] Includes code examples for SDK usage
  - [ ] Includes `"@matrix-os/sdk": "file:/app/packages/sdk"` resolution
  - [ ] Includes vite base path pattern

### T8: E2E validation
- **Status**: pending
- **Test**: `tests/integration/framework-app.test.ts`
- **Blocked by**: T1, T2, T3, T4, T5
- **Description**: Integration test validating the full flow: create temp app dir with framework manifest, verify listApps skips unbuilt app, create mock dist/index.html, verify listApps includes it with correct path, verify AppManager registers with correct status.
- **Acceptance**:
  - [ ] Unbuilt framework app not listed
  - [ ] Built framework app listed with correct entry path
  - [ ] AppManager status reflects build state
  - [ ] Gateway serves dist/index.html at expected URL path
  - [ ] All new tests pass
  - [ ] Full manual validation in Docker: scaffold, build, serve, interact

## Summary

| Task | Phase | Blocked by | Est. tests |
|------|-------|-----------|------------|
| T1: Manifest schema | 1 | - | 8 |
| T6: Dockerfile sudo | 1 | - | 0 (manual) |
| T2: listApps entry | 2 | T1 | 8 |
| T3: AppManager entry | 2 | T1 | 6 |
| T4: SDK core client | 3 | - | 12 |
| T5: SDK React hooks | 3 | T4 | 10 |
| T7: Knowledge file | 4 | T4, T5 | 0 |
| T8: E2E validation | 4 | all | 6 |
| **Total** | | | **~50** |
