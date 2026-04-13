# App Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an import adapter that takes an existing React/Vite/Next.js/Node-HTTP project (from a local tarball or a GitHub clone), turns it into a valid Matrix OS app, and hands it to 063's install-flow via a new `installFromStagingDir` entry point. Covers the two most common user paths: "my laptop project" and "this repo I found on GitHub." Community-trust imports go through 063's existing ack-gated flow — same modal, same issuer, same audit trail, no new trust tier.

**Architecture:** A Hono endpoint under `packages/gateway/src/app-runtime/import/` runs a three-phase pipeline: Phase A (fetch → scrub → classify → detect → reserve slug → synthesize → patch, no code execution), Phase B (trust gate, pause for community), Phase C (lockfile normalize → hand off to 063). Staging lives at `/tmp/matrix-import/{uuid}/app/` and is only ever renamed into `~/apps/` by 063's install-flow; 064 never touches the live app tree directly.

**Tech Stack:** Node 24 + TypeScript 5.5 strict, Hono (streaming NDJSON responses), Zod 4, pnpm, node-tar, `node:child_process` spawning `gh` + `tar` + `pnpm` (lockfile-only, ignore-scripts) with `AbortSignal` timeouts per CLAUDE.md, typed errors, no bare catches.

**Constitution gates:** Everything Is a File (imported source lives on disk, no hidden catalog state), TDD (failing tests first for every module), Defense in Depth (pre-gate invariant, principal-bound correlation store, env whitelist, size caps, path-traversal guards, single-use ack tokens).

---

## Hard prerequisite

**Phase 1 of this plan is BLOCKED until 063 Phase 3b is merged to main.** Not "depends on 063 in general" — blocked specifically on the three prerequisite tasks added to 063's plan:

| 063 task | What it delivers | What 064 needs it for |
|---|---|---|
| T25 `installFromStagingDir` | Parallel install-flow entry point accepting a pre-prepared staging directory | Task 11 imports `installFromStagingDir` directly; pipeline orchestrator has no alternative target. Integration test at T13 cannot pass without it. |
| T26 Shared slug reservation table | `tryReserve`/`release`/`isReserved` singleton consulted by both install-flow paths | Task 6 consumes this API; race-safety tests at T13 depend on it being wired through 063 |
| T27 058 ack-token verifier boundary | `verifyAckToken` import path settled (stub acceptable) | Community-trust resume tests at T13 need at minimum the stub in place |

Before starting Task 1, verify on main:

```bash
grep -q 'export.*installFromStagingDir' packages/gateway/src/app-runtime/install-flow.ts \
  && test -f packages/gateway/src/app-runtime/slug-reservation-table.ts \
  && grep -q 'verifyAckToken' packages/gateway/src/app-runtime/install-flow.ts \
  && echo "063 Phase 3b prerequisites present" \
  || { echo "ERROR: 063 Phase 3b not landed — 064 Phase 1 is blocked"; exit 1; }
```

If this check fails, stop and either land 063 Phase 3b first or file a blocking issue. Do not stub these in 064's tree — the whole point of the prereq is that the module boundary settles before import code is written against it.

---

## Phase Order

```
          [063 Phase 3b on main]
                   |
                   v
Phase 1: Local tarball upload (T1-T14)
                   |
                   v
[RELEASE GATE — T14 phase-gate-invariant green on main]
                   |
    +--------------+---------------+
    v                              v
Phase 2: GitHub clone       Phase 3: Shell UX
(T15-T17)                   (T18-T21)
```

Phase 2 and Phase 3 can land in parallel once Phase 1 ships and the endpoint NDJSON contract at T12 is frozen. Phase 3's UI code depends on the contract shape, not on Phase 2's GitHub fetcher.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/app-runtime/import/errors.ts` | **NEW** — `ImportError` class with full code taxonomy |
| `packages/gateway/src/app-runtime/import/temp-dir.ts` | **NEW** — `/tmp/matrix-import/{uuid}/app/` allocator + startup reaper with correlation-store reconciliation |
| `packages/gateway/src/app-runtime/import/correlation-store.ts` | **NEW** — bounded `Map<correlationId, CorrelationEntry>` with LRU + TTL + principal binding + single-use consumption |
| `packages/gateway/src/app-runtime/import/secrets-scrubber.ts` | **NEW** — walks staging dir, deletes `.env*` / key / secret patterns, returns stripped filenames without reading contents |
| `packages/gateway/src/app-runtime/import/project-detector.ts` | **NEW** — `package.json` inspection → `vite` \| `next` \| `node-http` or rejection with actionable reason |
| `packages/gateway/src/app-runtime/import/slug-resolver.ts` | **NEW** — derives slug, checks against shared 063 reservation table, returns reservation handle |
| `packages/gateway/src/app-runtime/import/manifest-synthesizer.ts` | **NEW** — writes `matrix.json` with defaults; preserves existing with slug-field rewrite; drift sentinel against 063 schema |
| `packages/gateway/src/app-runtime/import/basepath-patcher.ts` | **NEW** — Next.js wrapper config generation + Vite `--base` CLI flag injection, idempotent |
| `packages/gateway/src/app-runtime/import/lockfile-normalizer.ts` | **NEW** — post-gate only; `pnpm import` OR `pnpm install --lockfile-only --ignore-scripts`; rejects `bun.lockb` |
| `packages/gateway/src/app-runtime/import/source-fetcher-local.ts` | **NEW** — multipart upload + tar extraction + running size cap + inline secret strip |
| `packages/gateway/src/app-runtime/import/source-fetcher-github.ts` | **NEW** — `gh api` pre-clone size probe + `gh repo clone` with streaming `du` watcher + ref handling |
| `packages/gateway/src/app-runtime/import/github-ownership.ts` | **NEW** — `gh repo view --json viewerPermission` → `writable` \| `readonly` \| `unauthenticated` \| `not_found` |
| `packages/gateway/src/app-runtime/import/import-pipeline.ts` | **NEW** — Phase A + Phase C orchestration, gate decision, hand-off to `installFromStagingDir` |
| `packages/gateway/src/app-runtime/import/import-endpoint.ts` | **NEW** — Hono routes `POST /api/apps/import` and `POST /api/apps/import/resume`, streaming NDJSON |
| `packages/gateway/src/app-runtime/import/index.ts` | **NEW** — public API exports, gateway registration helper |
| `packages/gateway/src/server.ts` | **MODIFY** — mount import routes after `authMiddleware`, wire startup reaper hook |
| `shell/src/components/AppImportDialog.tsx` | **NEW** — multipart upload + GitHub URL input + NDJSON consumer + error card + ack modal handshake |
| `tests/gateway/app-runtime/import/errors.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/temp-dir.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/correlation-store.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/secrets-scrubber.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/project-detector.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/slug-resolver.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/manifest-synthesizer.test.ts` | **NEW** (includes drift sentinel) |
| `tests/gateway/app-runtime/import/basepath-patcher.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/lockfile-normalizer.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/source-fetcher-local.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/source-fetcher-github.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/github-ownership.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/import-pipeline.test.ts` | **NEW** |
| `tests/gateway/app-runtime/import/phase-gate-invariant.test.ts` | **NEW — RELEASE GATE** |
| `tests/gateway/app-runtime/import-integration.test.ts` | **NEW** — end-to-end Phase 1 + Phase 2 |
| `tests/e2e/app-import.spec.ts` | **NEW** — Playwright Phase 3 |
| `tests/fixtures/import/*` | **NEW** — fixture tree per spec §File structure |

---

## Phase 1 — Local tarball upload

### Task 1: Errors + module scaffolding

**Files:**
- Create: `packages/gateway/src/app-runtime/import/errors.ts`
- Create: `packages/gateway/src/app-runtime/import/index.ts` (empty barrel, will grow as modules land)
- Create: `tests/gateway/app-runtime/import/errors.test.ts`

- [ ] **Step 1: Write failing tests**
  - Every code in the spec taxonomy is assignable (TypeScript compile-level check via a `const _codes: ImportErrorCode[] = [...]` exhaustiveness test)
  - `new ImportError("no_package_json", "detail", "actionable")` serializes `code`, `message`, `actionable`
  - `cause` parameter chains through `error.cause` so `instanceof ImportError && err.cause instanceof Error` works when wrapping
  - `.name === "ImportError"`, inherits from `Error`
- [ ] **Step 2: Red** — `bun run test -- tests/gateway/app-runtime/import/errors.test.ts`
- [ ] **Step 3: Implement** the class exactly as spec §Error handling. No runtime logic, just the taxonomy.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add ImportError taxonomy for 064"
```

---

### Task 2: Temp dir lifecycle + startup reaper

**Files:**
- Create: `packages/gateway/src/app-runtime/import/temp-dir.ts`
- Create: `tests/gateway/app-runtime/import/temp-dir.test.ts`

- [ ] **Step 1: Write failing tests**
  - `allocateTempDir()` returns `/tmp/matrix-import/{uuid}/app/` with the UUID freshly generated via `crypto.randomUUID()`, creates the directory with `0700` mode, and returns `{ correlationId, tempDir, stagingDir }` (staging = `{tempDir}/app/`)
  - Two allocations produce distinct correlationIds
  - `reapStaleTempDirs({ olderThanMs, keepCorrelationIds })` removes `/tmp/matrix-import/*/` whose mtime is older than threshold, skipping any whose UUID appears in `keepCorrelationIds`
  - Reaper errors on a single dir (EACCES, ENOENT mid-read) are logged and skipped; the reaper does not abort
  - Reaper is idempotent: running it twice in a row with the same state is a no-op on the second run
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** using `fs/promises` + `crypto.randomUUID`. Public API:

```typescript
export interface TempDirAllocation {
  correlationId: string;   // matches basename of tempDir
  tempDir: string;         // /tmp/matrix-import/{uuid}
  stagingDir: string;      // /tmp/matrix-import/{uuid}/app
}

export async function allocateTempDir(): Promise<TempDirAllocation>;

export async function reapStaleTempDirs(opts: {
  olderThanMs: number;                 // default 1 hour
  keepCorrelationIds: ReadonlySet<string>;
}): Promise<{ reaped: string[]; skipped: string[]; errors: Array<{ dir: string; err: unknown }> }>;
```

- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 temp dir allocator + startup reaper"
```

---

### Task 3: Correlation store (bounded, LRU, TTL, principal-bound)

**Files:**
- Create: `packages/gateway/src/app-runtime/import/correlation-store.ts`
- Create: `tests/gateway/app-runtime/import/correlation-store.test.ts`

- [ ] **Step 1: Write failing tests**
  - `register({ correlationId, userId, tempDir, slugReservation, expiresAtMs })` stores the entry; duplicate `correlationId` throws
  - `lookup(correlationId, { userId })` returns the entry only when `userId` matches; otherwise returns `{ error: "principal_mismatch" }`
  - `lookup` returns `{ error: "not_found" }` when missing (either never registered or evicted)
  - `consume(correlationId, { userId })` returns the entry and marks it consumed; second call returns `{ error: "already_consumed" }`
  - TTL expiry: entries past `expiresAtMs` return `{ error: "expired" }` via `lookup`, even before `sweepExpired` runs
  - `sweepExpired()` removes expired + consumed entries and returns the list for downstream temp-dir reaping
  - **LRU cap at 32**: registering a 33rd entry evicts the oldest non-consumed entry; eviction emits a callback so the pipeline can close the stream with `{"step":"evicted"}` and reap the temp dir
  - Reaper integration: `entriesToKeep()` returns the set of correlationIds with live (non-expired, non-consumed) entries — used by temp-dir reaper's `keepCorrelationIds`
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** with a `Map<string, Entry>` plus a linked-list for LRU ordering. Eviction callback is a constructor arg (`onEvict: (entry) => void`). Tests inject a fake clock.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 correlation store with LRU, TTL, principal binding"
```

---

### Task 4: Secrets scrubber

**Files:**
- Create: `packages/gateway/src/app-runtime/import/secrets-scrubber.ts`
- Create: `tests/gateway/app-runtime/import/secrets-scrubber.test.ts`
- Create fixture: `tests/fixtures/import/secrets-in-env/` (dir tree with `.env`, `.env.production`, `src/nested/.env.local`, `id_rsa`, `cert.pem`, plus innocent files)

- [ ] **Step 1: Write failing tests**
  - `scrubStagingDir(stagingDir)` walks the dir tree, deletes any file matching the spec pattern set (`.env`, `.env.*`, `*.env`, `.secret`, `.secret.*`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`), and returns `{ stripped: string[] }` with relative paths
  - **Never reads file contents** — asserted by monkey-patching `fs.readFile` / `fs.createReadStream` to throw, then asserting scrub still succeeds
  - Innocent files are left alone (test fixture contains `.env.example`, a `package.json`, a `src/main.tsx`, etc — only the dangerous files are removed)
  - Nested matches are found (regex walk via `fs.readdir` recursive; do NOT use a lib that streams file contents)
  - Case sensitivity matches platform: on Linux patterns are case-sensitive (`.ENV` is not stripped); document this.
  - Symlinks are not followed (important: a symlink to `/etc/passwd` named `.env` must not cause us to unlink `/etc/passwd`). Use `fs.lstat` + `fs.unlink` on the symlink itself.
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement**
  - Use `fs.readdir(dir, { recursive: true, withFileTypes: true })` to walk
  - For each entry, test name against the pattern set
  - On match, call `fs.unlink` (on the entry path, not a resolved symlink target)
  - Collect and return the relative paths
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 secrets scrubber (filenames never contents)"
```

---

### Task 5: Project detector

**Files:**
- Create: `packages/gateway/src/app-runtime/import/project-detector.ts`
- Create: `tests/gateway/app-runtime/import/project-detector.test.ts`
- Create fixtures under `tests/fixtures/import/`:
  - `vite-owned/`, `next-owned/`, `node-hono/` (happy paths)
  - `cra-rejected/`, `monorepo-rejected/`, `unbundled-react-rejected/`, `no-package-json-rejected/`, `unrecognized-rejected/`
  - `pre-existing-matrix-json/` (valid Matrix OS manifest already present)

- [ ] **Step 1: Write failing tests** covering every branch of the decision tree in spec §Project Detection. Each fixture drives one test. Assertions:
  - `{ ok: true, type: { runtime, framework }, packageJson }` shape on happy paths
  - `{ ok: false, reason, actionable }` on reject paths, with the exact reason codes from the spec
  - Pre-existing matrix.json case still returns a detection result (the preservation decision is a synthesizer concern, not the detector's)
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** the decision tree from spec §Project Detection. Reads `package.json` only; does not evaluate any user code, does not `require()` or `import()` anything from the staging dir.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 project detector (vite/next/node-http + rejects)"
```

---

### Task 6: Slug resolver + reservation

**Files:**
- Create: `packages/gateway/src/app-runtime/import/slug-resolver.ts`
- Create: `tests/gateway/app-runtime/import/slug-resolver.test.ts`

**Prerequisite check:** Verify `packages/gateway/src/app-runtime/slug-reservation-table.ts` exists on main (it is 063 T26). Import `tryReserveSlug`, `releaseSlug`, `isReserved` from there. Do not stub locally.

- [ ] **Step 1: Write failing tests**
  - `reserveSlug({ preferred: "my-app", packageJsonName: "whatever", userId, correlationId, ttlMs })` validates `preferred` against `SAFE_SLUG`, rejects invalid
  - With no `preferred`, derives from `packageJsonName`: `"My Cool App" → "my-cool-app"`, `"foo--bar" → "foo-bar"`, `"123@#" → "123"`, empty → `"imported-app"`
  - Collision with an existing `~/apps/{candidate}` bumps to `{candidate}-2`, etc, up to 99
  - Collision with the in-memory reservation table (injected fake) also bumps
  - Collision with BOTH on-disk and in-memory is handled (exercise with a fake that returns `true` for certain slugs, and a real tmp `~/apps` dir with other slugs)
  - Exhaustion throws `ImportError("slug_exhausted")`
  - On success, `release()` on the returned handle releases the reservation exactly once (second call is a no-op, verified)
  - `reserveSlug` holds the 063 reservation atomically — under a concurrent scenario (two resolvers racing), exactly one wins
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** using the 063 reservation table. Signature from spec §Slug Resolution.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 slug resolver with shared reservation table"
```

---

### Task 7: Manifest synthesizer (with drift sentinel)

**Files:**
- Create: `packages/gateway/src/app-runtime/import/manifest-synthesizer.ts`
- Create: `tests/gateway/app-runtime/import/manifest-synthesizer.test.ts`

- [ ] **Step 1: Write failing tests**

Happy paths:
  - Vite synthesis produces the exact shape in spec §Manifest Synthesis, with `--base /files/apps/{slug}/dist/` appended to `build.command`
  - Next synthesis produces the Next shape, `runtime: "node"`, `output: ".next"`, `serve.start` from `scripts.start`
  - node-http synthesis matches the node-http defaults with `healthCheck: "/"` fallback
  - `listingTrust` is stamped from the input parameter, not inferred
  - `permissions: ["network", "data:read", "data:write"]` unconditionally on all three
  - `memoryMb: 512`, `timeout: 300` (vite) / `600` (next)

Preservation paths (the load-bearing ones):
  - Existing `matrix.json` in `stagingDir` that validates against 063's schema is preserved
  - `slug` is **rewritten** to `resolvedSlug` even when the existing manifest had a different slug
  - `listingTrust` is **rewritten** to the input value
  - `scope` is **forced to `"personal"`** (assert with an input manifest that has `scope: "shared"`)
  - For `runtime: "vite"`, any existing `--base ...` argument in `build.command` is stripped and replaced with the new `--base /files/apps/{resolvedSlug}/dist/`
  - Other fields (`resources`, `permissions`, `serve`, `category`, `icon`, `storage`) are preserved verbatim
  - Malformed existing manifest → `ImportError("invalid_existing_manifest")`

**Drift sentinel test** (critical):
  - Build a Vite manifest that includes every field 063's Zod schema supports (use introspection: iterate over `AppManifestSchema.shape` keys)
  - For each string-valued field, replace `slug` substrings with a distinctive sentinel (`XXSLUGXX`)
  - Run the preservation path with `resolvedSlug = "new-slug"`
  - Assert the output manifest contains `new-slug` in EVERY field that originally contained `XXSLUGXX`
  - If 063 adds a new slug-shaped field in the future and the synthesizer doesn't rewrite it, this test fails with a clear message listing the stale fields

```typescript
// Sketch of the drift sentinel
it("rewrites every slug-derived field on preservation (drift sentinel)", async () => {
  const SENTINEL = "XXSLUGXX";
  const existingManifest = buildFullManifestWithSentinel(SENTINEL);
  await fs.writeFile(join(stagingDir, "matrix.json"), JSON.stringify(existingManifest));

  await synthesizeManifest({
    stagingDir,
    projectType: { runtime: "vite", framework: "vite" },
    packageJson: { name: "whatever" },
    listingTrust: "first_party",
    resolvedSlug: "new-slug",
  });

  const written = JSON.parse(await fs.readFile(join(stagingDir, "matrix.json"), "utf8"));
  const stale = findSentinelOccurrences(written, SENTINEL);
  expect(stale, `Stale slug references found in preserved manifest: ${stale.join(", ")}`).toEqual([]);
});
```

- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** per spec §Manifest Synthesis. For the drift sentinel, the preservation code MUST have an explicit allowlist of rewritten fields + a runtime assertion that no other field contains the old slug. If a field drifts in, the assertion fires in tests and in prod (logged at error).
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 manifest synthesizer with drift sentinel"
```

---

### Task 8: Basepath patcher

**Files:**
- Create: `packages/gateway/src/app-runtime/import/basepath-patcher.ts`
- Create: `tests/gateway/app-runtime/import/basepath-patcher.test.ts`
- Create fixtures: `tests/fixtures/import/next-config-variants/` with subdirs for `.js`, `.mjs`, `.ts`, `.cjs`, and `no-config/`

- [ ] **Step 1: Write failing tests**
  - `patchNext({ stagingDir, slug })` on a dir containing `next.config.js` renames it to `next.config.user.js` and writes a new `next.config.js` with the wrapper
  - Same for `.mjs` (wrapper uses ESM `import`/`export default`), `.ts` (wrapper uses `export default` relying on Next's ts-node loader), `.cjs` (uses `require` + `module.exports`)
  - With no existing config, `patchNext` writes a minimal wrapper without the `require`
  - The generated wrapper preserves `userConfig` fields via spread and overlays `basePath: /apps/{slug}` + `assetPrefix: /apps/{slug}`
  - **Idempotence**: running `patchNext` twice produces no additional renames and no content change. Detect via a marker comment (`// Generated by Matrix OS import (spec 064).`) in the generated file; if present, skip.
  - `patchVite({ matrixJson, slug })` rewrites `build.command` to append `--base /files/apps/{slug}/dist/`, stripping any previous `--base` argument
  - Running `patchVite` twice produces no duplicate flags
  - `patchNodeHttp` is a no-op (returns without modifying anything)
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement**
  - Next.js wrapper bodies per spec §basePath Patching
  - Vite: parse `build.command`, split on whitespace (respecting quotes), remove any token sequence matching `--base ...`, append the new `--base` flag. Do NOT use regex replace — it misbehaves on commands with extra flags.
  - Idempotence via the marker comment
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 basepath patcher (next wrapper + vite --base)"
```

---

### Task 9: Lockfile normalizer (Phase C only)

**Files:**
- Create: `packages/gateway/src/app-runtime/import/lockfile-normalizer.ts`
- Create: `tests/gateway/app-runtime/import/lockfile-normalizer.test.ts`
- Create fixtures: `tests/fixtures/import/lockfile-variants/` with `pnpm/`, `npm/`, `yarn/`, `bun/`, `none/`

- [ ] **Step 1: Write failing tests**
  - `normalizeLockfile({ stagingDir })` on a dir with `pnpm-lock.yaml` is a no-op (returns `{ action: "noop" }`)
  - With `package-lock.json`: spawns `pnpm import` (mocked via a fake child process), deletes `package-lock.json` after success, returns `{ action: "pnpm_import", from: "package-lock.json" }`
  - With `yarn.lock`: same pattern, `from: "yarn.lock"`
  - With `bun.lockb`: throws `ImportError("lockfile_unsupported")` without spawning anything
  - With no lockfile: spawns `pnpm install --lockfile-only --ignore-scripts`. The argv check asserts **both flags are present**. After success, asserts `pnpm-lock.yaml` exists and `node_modules/` does NOT exist.
  - **Critical regression test**: fixture `none/` contains a `package.json` with a `preinstall` script that writes a sentinel file (`/tmp/matrix-064-sentinel-{uuid}`). Running the normalizer on this fixture MUST NOT create the sentinel file. Test uses a real `pnpm` binary + a unique tmp path.
  - `pnpm import` failure (mocked non-zero exit) → `ImportError("lockfile_normalize_failed")` with stderr in `cause`
  - `pnpm install --lockfile-only` failure → `ImportError("lockfile_generate_failed")`
  - Both calls are wrapped in `AbortSignal.timeout` (60s for `pnpm import`, 120s for `pnpm install --lockfile-only`)
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement**
  - Stat the staging dir for lockfiles
  - Spawn via `child_process.spawn` with `importSafeEnv()` (TBD: add a minimal `importSafeEnv` helper inline here or in `safe-env.ts` — a helper module for 063-style env whitelist is acceptable; the helper lives in this module or a sibling and is imported by later tasks)
  - Argv list construction must put flags into the argv array, NOT string-interpolated into a command
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 lockfile normalizer (post-gate, no lifecycle scripts)"
```

---

### Task 10: Source fetcher — local tarball

**Files:**
- Create: `packages/gateway/src/app-runtime/import/source-fetcher-local.ts`
- Create: `tests/gateway/app-runtime/import/source-fetcher-local.test.ts`
- Create fixtures:
  - `tests/fixtures/import/tarballs/vite-happy.tar.gz`
  - `tests/fixtures/import/tarballs/path-traversal.tar.gz` (entry with `../../../etc/evil`)
  - `tests/fixtures/import/tarballs/symlink-escape.tar.gz`
  - `tests/fixtures/import/tarballs/oversized.tar.gz` (>500 MB when unpacked, or use a small cap in the test config)
  - `tests/fixtures/import/tarballs/with-env-files.tar.gz`

- [ ] **Step 1: Write failing tests**
  - Happy path: upload a vite tarball, extract to `stagingDir`, assert files present, assert `.env*` stripped inline (stripped filenames returned in the result)
  - Path traversal: extraction throws `ImportError("tarball_path_traversal")` and `stagingDir` is left empty (all partial content removed)
  - Symlink escape (entry is a symlink pointing outside the root): same rejection
  - Running-size overflow: extraction aborts when running total exceeds the configured cap; cleanup empties `stagingDir`; throws `ImportError("clone_too_large")` (yes, same code as github — the spec uses `clone_too_large` for both upload and clone for uniformity; rename if you prefer `upload_too_large_unpacked`)
  - `.env` / `.env.production` / `id_rsa` entries in the tarball are dropped during extraction, not post-hoc; the returned `strippedSecrets` list has them
  - Malformed tarball → `ImportError("tarball_malformed")`
  - Bodylimit is enforced at the Hono layer (tested at the endpoint level in T12, not here)
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement**
  - Use `node-tar` with `filter` callback that rejects absolute paths, `..`, symlinks, hardlinks, device files, FIFOs, `.git/`, `node_modules/`, and secret patterns
  - Running total counter in the `onentry` callback; abort via `parser.abort()` and reject the promise when overflow is detected
  - Return `{ stagingDir, strippedSecrets: string[] }`
  - On any error, recursively remove `stagingDir` and rethrow
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 local tarball fetcher with path-traversal + size guards"
```

---

### Task 11: Import pipeline orchestrator

**Files:**
- Create: `packages/gateway/src/app-runtime/import/import-pipeline.ts`
- Create: `tests/gateway/app-runtime/import/import-pipeline.test.ts`

**Prerequisite check:** `installFromStagingDir` must be importable from `packages/gateway/src/app-runtime/install-flow.ts`. Run the 063 Phase 3b prerequisite check command from the top of this plan before starting. If it fails, stop.

- [ ] **Step 1: Write failing tests**

Architecture tests (Phase A / Phase B / Phase C split):
  - `runPhaseA` emits a sequence of events matching the spec's NDJSON stream (without the pnpm steps); the sequence ends at `gate_check` or `gated`
  - `runPhaseA` never spawns a `pnpm` subprocess (mock `child_process.spawn`, assert no call with argv starting `pnpm`)
  - `runPhaseC` emits the lockfile-normalize and hand-off events; Phase C only runs after Phase A has completed
  - Gated path: Phase A for a community-classified import ends with `{"step":"gated"}`; Phase C is not entered; correlation store has the entry registered; temp dir is retained
  - First-party path: Phase A → Phase C runs in the same request without pause
  - Resume: calling `resumeFromGate({ correlationId, ackToken, userId })` looks up the correlation entry, runs Phase C, and hands off to `installFromStagingDir`
  - Resume with principal mismatch → `ImportError("correlation_principal_mismatch")`
  - Resume with missing correlation (reaped) → `ImportError("staging_expired")`

Failure cleanup tests:
  - Any error in Phase A reaps the temp dir and releases the slug reservation
  - Any error in Phase C (post-gate) also reaps and releases
  - A `installFromStagingDir` rejection propagates as `ImportError("install_flow_rejected")` with `cause` set

Concurrency tests:
  - Phase-A mutex per user: second concurrent import returns `{ error: "import_in_progress", activeImport: {...} }`
  - Per-user Phase-B gated quota: fourth pending gated import returns `{ error: "gated_quota_exceeded", pendingCorrelationIds: [...] }`
  - LRU eviction: when the correlation store is at cap, the pipeline's eviction callback closes the evicted stream with `{"step":"evicted"}` and reaps the evicted temp dir

- [ ] **Step 2: Red**
- [ ] **Step 3: Implement**
  - `ImportPipeline` class takes `{ installFlow, correlationStore, slugTable, tempDirApi }` via constructor DI
  - `runPhaseA({ source, principalUserId })` returns `{ correlationId, stagingDir, manifestListingTrust, gated: boolean }` along with an async generator yielding NDJSON events
  - `runPhaseC({ correlationId, userId, ackToken? })` runs lockfile normalize + hand-off
  - Per-user Phase-A mutex via `Map<userId, Promise<void>>`
  - Eviction callback registered on the correlation store at construction time
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 import pipeline orchestrator with three-phase split"
```

---

### Task 12: Import HTTP endpoint

**Files:**
- Create: `packages/gateway/src/app-runtime/import/import-endpoint.ts`
- Modify: `packages/gateway/src/server.ts` (mount routes + wire startup reaper)
- Create: `tests/gateway/app-runtime/import/import-endpoint.test.ts`

- [ ] **Step 1: Write failing tests**
  - `POST /api/apps/import` without bearer token → 401 from `authMiddleware`
  - `POST /api/apps/import` with `Content-Type: application/json`, body `{ source: "github", ... }` → streaming NDJSON response with `Transfer-Encoding: chunked` and `Content-Type: application/x-ndjson`
  - Multipart variant: `POST /api/apps/import` with `source=local` form field + tarball → same streaming response
  - Body > `bodyLimit` → `413 upload_too_large`
  - Community import: stream ends with `{"step":"gated"}`, HTTP response completes normally (200), temp dir persists in the correlation store
  - `POST /api/apps/import/resume` with valid `{correlationId, ack}` → resumes, completes, catalog entry present
  - `/resume` with principal mismatch → `403 correlation_principal_mismatch`
  - `/resume` with missing correlation → `404 correlation_not_found`
  - `/resume` with expired correlation → `404 staging_expired`
  - Concurrent Phase-A from same user → `409 import_in_progress` with `activeImport` body
  - `ImportError` subclasses are mapped to HTTP status codes per spec §Failure Modes
  - NDJSON encoding: every line is a valid JSON object, terminated by `\n`; no trailing newline after the last event; `correlationId` present on every event
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement**
  - Hono route handlers wrap `importPipeline.runPhaseA` and `importPipeline.resumeFromGate`
  - NDJSON writer helper: `async function writeNdjson(stream, obj)` that calls `stream.write(JSON.stringify(obj) + "\n")`
  - Server.ts modifications: `app.route("/api/apps", importRouter)` after `authMiddleware`, plus `onStart: () => reapStaleTempDirs({...})`
  - Error → status mapping in a single `importErrorToHttpStatus(code)` helper; test via a matrix test
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 POST /api/apps/import and /resume endpoints"
```

---

### Task 13: Phase 1 integration test (happy path)

**Files:**
- Create: `tests/gateway/app-runtime/import-integration.test.ts`
- Create fixtures:
  - `tests/fixtures/import/real-vite/` — a minimal, actually-buildable Vite + React app with a pinned lockfile
  - `tests/fixtures/import/real-vite-community/` — a copy of real-vite used via a mocked GitHub clone to drive the community path

- [ ] **Step 1: Write failing tests**

**First-party happy path**:
  - Start the gateway in-test
  - `POST /api/apps/import` multipart with a real tarball of `real-vite/`
  - Consume the NDJSON stream
  - Assert sequence: `fetching` → `scrubbing_secrets` → `classifying` → `detecting` → `inspecting_lockfile` → `reserving_slug` → `synthesizing_manifest` → `patching_basepath` → `gate_check` (pass) → `normalizing_lockfile` → `handing_off` → `installing pnpm_install` → `installing pnpm_build` → `done`
  - Assert `~/apps/{slug}/` exists with a populated `dist/`
  - Hit `/files/apps/{slug}/dist/index.html` through the gateway and assert `200 OK` with the built HTML
  - App catalog contains the new app with `listingTrust: "first_party"`

**Community path (stubbed 058 verifier)**:
  - Force a community classification (inject via a test-only flag on the import pipeline OR via a mock `github-ownership` — use whichever is cleaner given 063 Phase 3b landed; T15 adds the real ownership module in Phase 2)
  - `POST /api/apps/import` → stream ends with `{"step":"gated"}`
  - Mint an ack token via the 063 Phase 3b test helper (the `verifyAckToken` stub accepts a blessed test token)
  - `POST /api/apps/import/resume` with `{ correlationId, ack: testToken }`
  - Assert Phase C runs and the app lands

**Race cleanup**:
  - Start two concurrent Phase-A imports from the same user
  - Assert the second returns `409 import_in_progress`
  - After the first completes, a third import succeeds

**Reaper reconciliation**:
  - Use fake clock to advance past 1h TTL on a completed (but not consumed) gated import
  - Run the reaper
  - Assert the temp dir is gone, correlation entry is gone, slug reservation is released

- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** — wire the test harness, fixtures, and helpers. This task is wiring-heavy but mostly glue.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "test(gateway): 064 Phase 1 integration — happy + community + cleanup"
```

---

### Task 14: **RELEASE GATE** — phase-gate invariant test

**Files:**
- Create: `tests/gateway/app-runtime/import/phase-gate-invariant.test.ts`
- Create fixture: `tests/fixtures/import/malicious-preinstall/`
  - `package.json` with `"scripts": { "preinstall": "node write-sentinel.js", "install": "node write-sentinel.js", "postinstall": "node write-sentinel.js", "prepare": "node write-sentinel.js", "build": "vite build" }`
  - `write-sentinel.js` that writes `/tmp/matrix-064-phase-gate-violation-${process.env.MATRIX_TEST_RUN_ID}` and exits 0
  - Vite dependencies so detection classifies it as vite
  - No lockfile (to force the `pnpm install --lockfile-only --ignore-scripts` code path)

**This task is a release gate, not a normal test task.** Phase 1 does not ship without it green on main.

The test asserts the **most load-bearing security invariant in the spec**: imported code — particularly community-classified imported code from GitHub — must never execute lifecycle scripts before the user explicitly accepts the community trust gate. This is the single biggest way 064 could go wrong.

- [ ] **Step 1: Write the test**

```typescript
// tests/gateway/app-runtime/import/phase-gate-invariant.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, stat, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packTarball, uploadTarball } from "./helpers.js";
import { startGatewayInTest } from "../helpers/gateway.js";

describe("064 phase-gate invariant (RELEASE GATE)", () => {
  let runId: string;
  let sentinelPath: string;
  let gateway: Awaited<ReturnType<typeof startGatewayInTest>>;

  beforeEach(async () => {
    runId = randomUUID();
    sentinelPath = `/tmp/matrix-064-phase-gate-violation-${runId}`;
    await rm(sentinelPath, { force: true });
    gateway = await startGatewayInTest({
      env: { MATRIX_TEST_RUN_ID: runId }, // NOT forwarded to import subprocesses, for the test harness itself
    });
  });

  afterEach(async () => {
    await gateway.stop();
    await rm(sentinelPath, { force: true });
  });

  it("community import never executes preinstall/install/postinstall during Phase A or Phase B", async () => {
    const tarball = await packTarball("tests/fixtures/import/malicious-preinstall");

    // Drive the community path: mock github-ownership (Phase 2 has the real one;
    // this test runs in Phase 1 against a test-only override that forces
    // listingTrust = "community" on any import)
    const res = await uploadTarball(gateway, tarball, {
      bearer: gateway.testPrincipal.token,
      forceCommunityClassification: true,
    });

    const events = await consumeNdjson(res);
    const lastStep = events.at(-1)?.step;
    expect(lastStep).toBe("gated");

    // INVARIANT: no sentinel file was written anywhere in Phase A or Phase B.
    // If any of preinstall/install/postinstall/prepare ran, it created this file.
    await expect(stat(sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("community import that is never ack'd never executes scripts before expiry reap", async () => {
    // Second assertion: even if we wait out the 10-min TTL without acknowledging,
    // no script runs during the gate. Rules out any background / deferred
    // execution path.
    const tarball = await packTarball("tests/fixtures/import/malicious-preinstall");

    const res = await uploadTarball(gateway, tarball, {
      bearer: gateway.testPrincipal.token,
      forceCommunityClassification: true,
    });
    await consumeNdjson(res);

    // Advance fake clock past TTL and run the reaper explicitly.
    gateway.clock.advance(11 * 60 * 1000);
    await gateway.runReaper();

    await expect(stat(sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("first-party import DOES run scripts (sanity check — make sure the fixture is actually dangerous)", async () => {
    // Contrast test: if we import the same malicious fixture as first_party,
    // the gate passes and the script runs. This proves the fixture actually
    // writes the sentinel when given the chance — otherwise the above tests
    // are vacuous.
    const tarball = await packTarball("tests/fixtures/import/malicious-preinstall");

    // Local tarball is classified as first_party automatically.
    const res = await uploadTarball(gateway, tarball, {
      bearer: gateway.testPrincipal.token,
    });
    const events = await consumeNdjson(res);

    // Install will fail because the build will error (vite build with no source),
    // but that's fine — we only care that preinstall ran.
    await expect(stat(sentinelPath)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Red** — the test should fail if the pipeline is not correctly preventing Phase A/B script execution. Verify this by temporarily moving the lockfile normalizer back to Phase A and watching the first test fail. Then restore Phase C ordering.
- [ ] **Step 3:** The test passes with the correct pipeline ordering; no implementation change required at this task, only verification.
- [ ] **Step 4: Green** — run with CI settings and confirm.
- [ ] **Step 5: Mark test as a release gate**
  - Add the test file path to the repo's CI config as a required check
  - Document in `docs/dev/pr-review-analysis.md` (or the equivalent release-gate list) that `phase-gate-invariant.test.ts` failures block merge into main
- [ ] **Step 6: Commit**

```
git commit -m "test(gateway): 064 phase-gate invariant RELEASE GATE

Enforces the core spec 064 security property: no user-authored
lifecycle scripts execute during Phase A or Phase B of an import,
even for community-classified imports that are never ack'd.

Phase 1 merge to main is gated on this test."
```

**Phase 1 done criteria** (checked before any Phase 2 task begins):

- [ ] T1-T12 unit tests green
- [ ] T13 Phase 1 integration test green
- [ ] T14 phase-gate-invariant test green **and marked as a required CI check**
- [ ] `bun run lint` clean, `bun run build` clean
- [ ] Benchmark checkpoint from spec §Open Questions item 1 run against the real-vite fixture + at least three other real projects; measurements recorded in spec.md and the synthesizer defaults updated if the data warrants it
- [ ] Manual smoke test: import a real off-GitHub React project via `curl` against a running gateway

---

## Phase 2 — GitHub clone

### Task 15: GitHub ownership check

**Files:**
- Create: `packages/gateway/src/app-runtime/import/github-ownership.ts`
- Create: `tests/gateway/app-runtime/import/github-ownership.test.ts`

- [ ] **Step 1: Write failing tests** (with a mock `gh` binary shimmed via PATH override in the test harness)
  - `ADMIN`, `MAINTAIN`, `WRITE` → `"writable"`
  - `READ`, `TRIAGE`, `null` → `"readonly"`
  - gh exits with `authentication required` stderr → `"unauthenticated"`
  - gh exits with `not found` → `"not_found"`
  - AbortSignal timeout → `ImportError("ownership_check_timeout")`
  - gh binary missing at PATH → `ImportError("gh_not_available")`
  - Module-load-time probe: `isGhAvailable()` caches the result across calls
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** — `spawn("gh", ["repo", "view", ownerRepo, "--json", "viewerPermission"])` with `importSafeEnv()`, parse JSON, map result.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 github-ownership via gh repo view"
```

---

### Task 16: GitHub source fetcher — bounded clone

**Files:**
- Create: `packages/gateway/src/app-runtime/import/source-fetcher-github.ts`
- Create: `tests/gateway/app-runtime/import/source-fetcher-github.test.ts`
- Create fixture: `tests/fixtures/import/bare-repos/real-vite.git` — a file:// bare git repo built from the real-vite fixture, used to drive the mock-gh clone path

- [ ] **Step 1: Write failing tests**
  - URL regex rejects SSH, short form, query strings, fragments, non-github hosts
  - URL regex accepts `https://github.com/owner/repo`, `https://github.com/owner/repo.git`
  - `fetchFromGithub({ url, ref?, stagingDir })` with mock `gh`:
    - Pre-clone size probe via `gh api repos/owner/repo --jq .size` returns 50000 (50 MB) → clone proceeds
    - Pre-clone size probe returns 600000 (600 MB) → `ImportError("clone_too_large")`, no `gh repo clone` spawned
    - Pre-clone probe times out → warn log, clone still proceeds (resilient to flaky metadata API)
    - Pre-clone probe returns 404 → `ImportError("repo_not_found")`
    - Streaming size watcher: during a mocked long clone, `du` reports 600 MB at the 10s tick → clone process is SIGKILLed and `ImportError("clone_too_large")` is raised
    - Clone timeout (300s) fires AbortSignal → `ImportError("clone_timeout")`
    - `ref` branch passed via `--branch` flag in argv
    - `ref` 40-char hex SHA triggers a post-clone `git checkout` subprocess; failure → `ImportError("ref_not_found")`
  - Post-clone secret scrub runs and the `strippedSecrets` are included in the result
  - Strict argv: test asserts `gh` is spawned with argv list, never shell-interpolated
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement**
  - `parseGithubUrl(url)` → `{ owner, repo }` or throw
  - `probeSize({ owner, repo })` → size in KB
  - `cloneWithWatcher({ owner, repo, ref, stagingDir })` spawns `gh repo clone`, runs `setInterval(du, 10000)` in parallel, cancels on exit
  - Returns `{ stagingDir, strippedSecrets }`
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): 064 github fetcher with pre-probe + streaming du watcher"
```

---

### Task 17: Phase 2 integration test

**Files:**
- Extend: `tests/gateway/app-runtime/import-integration.test.ts`

- [ ] **Step 1: Write failing tests**
  - First-party GitHub import: mock ownership to return `writable`, drive a clone against the bare `real-vite.git` fixture, assert the same success flow as Phase 1 T13
  - Community GitHub import: ownership returns `readonly` → gated → resume → install
  - Unauthenticated: mock `gh` to return `authentication required` → `401 gh_not_authenticated` with actionable message
  - Private no access: mock `gh repo view` to return 404 → `403 repo_private_no_access` (distinguished from `404 repo_not_found` by an auth-state check)
  - Over-size pre-probe rejection surfaces the clone_too_large error before any clone subprocess starts (assert no `gh repo clone` spawn in the test harness)
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** — wire the test harness around the mocked `gh` binary.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "test(gateway): 064 Phase 2 integration — first_party + community GitHub"
```

**Phase 2 done criteria:**

- [ ] T15-T17 green
- [ ] Manual test: `gh auth login` in a terminal, then import a real public GitHub React project end-to-end
- [ ] Manual test: import a private repo from an authenticated user end-to-end
- [ ] Manual test: attempt to import a huge (>500 MB) public repo, assert clean rejection

---

## Phase 3 — Shell UX

### Task 18: `AppImportDialog` skeleton

**Files:**
- Create: `shell/src/components/AppImportDialog.tsx`
- Create: `tests/shell/app-import-dialog.test.tsx`

- [ ] **Step 1: Write failing tests**
  - Renders two tabs: "From file" and "From GitHub"
  - "From file" tab has a drag-drop zone + file picker for `.tar.gz` / `.tgz`
  - "From GitHub" tab has a URL input + optional branch / ref input
  - Submit on either tab calls a `startImport({ source, ... })` prop
  - Disabled while an import is in progress
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** the skeleton. No actual import logic yet — just the surface and the prop contract.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(shell): AppImportDialog skeleton for 064"
```

---

### Task 19: NDJSON streaming consumer + progress UI

**Files:**
- Modify: `shell/src/components/AppImportDialog.tsx`
- Create: `shell/src/lib/import-stream.ts`
- Create: `tests/shell/import-stream.test.ts`

- [ ] **Step 1: Write failing tests**
  - `consumeImportStream(response)` is an async generator that yields each parsed event object
  - Partial lines across chunk boundaries are buffered until the next `\n`
  - Invalid JSON mid-stream throws a typed error with the offending line
  - The dialog renders each step with a human-readable label + spinner
  - `scrubbing_secrets` step renders a non-blocking warning panel listing the stripped filenames
  - `gated` step triggers the ack modal handshake (see T20)
  - `evicted` step renders an error card saying "Import cancelled — too many concurrent imports"
  - `done` closes the modal and refreshes the app launcher
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement**
  - Use `Response.body.getReader()` + `TextDecoder` for streaming
  - React state machine for step rendering
  - Handle 409 `import_in_progress` — render an "already in progress" panel with a "Reconnect" button (Phase 3 scope: for now just surface the active-import status)
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(shell): 064 NDJSON import stream consumer + progress UI"
```

---

### Task 20: Ack modal handshake with spec 058

**Files:**
- Modify: `shell/src/components/AppImportDialog.tsx`
- Create: `tests/shell/app-import-dialog-ack.test.tsx`

**Prerequisite check:** Spec 058's ack modal component (`<CommunityTrustAckModal>` or equivalent) must be importable from the gallery module. If 058 has not yet shipped the modal, stub with a dialog that mints a fake ack token against the correlation ID — tests should use a hook point that Phase 3 preserves when the real modal lands.

- [ ] **Step 1: Write failing tests**
  - On receiving `{"step":"gated"}`, the dialog opens the 058 ack modal (or stub) with the correlation ID and `permissionsAdvisory` list
  - User accepts → shell mints ack token via `POST /api/apps/ack-import` (058-owned route) → shell calls `POST /api/apps/import/resume` with `{correlationId, ack}`
  - User declines → dialog closes, import is abandoned (temp dir expires on its own)
  - `/resume` failure → error card with the typed code surfaced
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** — thread the resume call through the existing NDJSON consumer; reuse the same stream-rendering code.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "feat(shell): 064 community trust ack handshake with 058"
```

---

### Task 21: Playwright end-to-end

**Files:**
- Create: `tests/e2e/app-import.spec.ts`
- Create shell-side fixtures for mocked 058 and gh

- [ ] **Step 1: Write failing tests**
  - Sign in → open "Import app" dialog → drop a `.tar.gz` fixture → wait for progress → assert the new app appears in the launcher → click → assert it renders
  - Paste a mocked GitHub URL → ownership check shows `first_party` → assert completion
  - Mocked community-trust import → assert the ack modal appears → accept → assert completion
  - Decline the ack modal → assert the import does NOT appear in the launcher
  - Oversize upload → assert the error card renders the actionable message
  - Unauth gh → assert the "run `gh auth login` in a terminal" actionable message
  - Screenshot each state for visual regression
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement** — Playwright harness hooks into a test gateway running with mocked `gh` and mocked 058 verifier.
- [ ] **Step 4: Green**
- [ ] **Step 5: Commit**

```
git commit -m "test(e2e): 064 app import Playwright coverage"
```

**Phase 3 done criteria:**

- [ ] T18-T21 green
- [ ] Visual screenshots approved for all progress + error states
- [ ] Manual test: real user imports their own GitHub repo via the UI end-to-end

---

## Global Done Criteria

- [ ] 063 Phase 3b merged to main (hard prereq)
- [ ] All Phase 1 + 2 + 3 tasks merged to main
- [ ] `bun run test` all green (unit + integration + e2e)
- [ ] `bun run lint` and `bun run build` clean
- [ ] **T14 phase-gate invariant test is a required CI check** and is green
- [ ] Benchmark checkpoint recorded in `specs/064-app-import/spec.md` §Open Questions item 1 with p50/p95 build wallclock and peak memory across 5+ real imports; synthesizer defaults updated if the data warrants
- [ ] Playwright e2e (`tests/e2e/app-import.spec.ts`) passes in CI
- [ ] User can import a local tarball in under 60 seconds end-to-end on a warm pnpm store
- [ ] User can import a public GitHub React project of ≤50 MB in under 90 seconds end-to-end
- [ ] User can import a community-classified GitHub repo through the ack modal flow
- [ ] Manual smoke test: import a real off-GitHub Next.js project and use it

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 063 Phase 3b slips | Phase 1 of 064 is entirely blocked | Hard prereq check at top of plan; 063 Phase 3b is a small extension to an existing module and should land quickly. If 058 verifier lags, 063 T27 has an explicit stub-fallback. |
| `pnpm install --lockfile-only --ignore-scripts` silently changes behavior in a future pnpm version and begins executing scripts | Phase-gate invariant violated | T9 argv check asserts both flags are present at call time; T14 release gate catches any regression end-to-end |
| `gh api .size` lies about repo size | Clone cap bypassed | Streaming `du` watcher at T16 is the second guard; discrepancy logs at warn |
| Re-entrant correlation store corruption under heavy concurrency | Lost imports, leaked temp dirs | T3 tests include LRU + TTL + principal lookup concurrency; T13 integration test exercises 3+ concurrent imports |
| User re-imports the same repo with a different `listingTrust` by spoofing the matrix.json they committed | Trust downgrade attack | T7 synthesizer always rewrites `listingTrust` from the ingest-time decision, never trusting the repo's value |
| Tarball path traversal (zip-slip class) | Arbitrary file write | T10 uses node-tar filter rejecting absolute / `..` / symlinks; fixtures exercise every variant |
| pnpm lockfile migration (T9 `pnpm import`) is slow on large projects | UX degraded | 60s AbortSignal + progress event streamed to UI; open question for benchmarking |
| Shell UI 409 `import_in_progress` handling confuses users with multiple tabs | Support load | T19 renders the active-import correlation ID + source; user can see which tab owns the in-progress import |
| Next.js wrapper config breaks on unusual user configs (e.g. async config function, ESM-only projects with `"type": "module"`) | Imported Next apps fail to build | T8 tests all four extensions and both CJS/ESM; open question for additional variants when benchmarking surfaces real-world failures |
| Community imports pile up in the correlation store, blocking new imports via the global cap | User hits "evicted" | LRU eviction policy is documented; Phase-B quota of 3 per user bounds the worst case; UI exposes pending correlation IDs to let users cancel |

---

## Dependencies

**External to 063 Phase 3b prerequisites** (see top of plan for the hard block):

- `node-tar` (add to gateway package) — streaming tar extraction with filter callbacks
- `hono/body-limit` middleware (already in hono) — upload size cap
- `gh` binary available in the gateway container (add to Dockerfile if not already present per spec 056 terminal setup)

Run `pnpm install` from the repo root after adding dependencies per CLAUDE.md lockfile rule.

**Spec dependencies**:

- **063 — Required**: `installFromStagingDir`, shared slug reservation table, ack verifier module boundary (063 Phase 3b, tasks T25/T26/T27)
- **056 — UX dependency**: terminal for `gh auth login`; no code dependency
- **058 — Module dependency**: `verifyAckToken` import, `<CommunityTrustAckModal>` component. Stub fallback acceptable in 063 T27 and 064 T20 if 058 lags.
- **025 — Forward dependency**: when 025 lands, community-tier imports flip from `gated` to `installable` automatically via 063's policy function. No 064 code changes needed at that time.
