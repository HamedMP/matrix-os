# Spec 064: App Import

**Status**: Draft
**Created**: 2026-04-11
**Depends on**: 063 (React App Runtime — install-flow, trust tiers, manifest schema, session cookies), 056 (Terminal — users run `gh auth login` here), 058 (App Gallery — ack token format and "I understand the risk" modal)
**Blocks**: —
**Constitution alignment**: I (Everything Is a File — imported source lives on disk), III (Headless Core — import is a gateway API, shell only renders it), IV (Defense in Depth — typed errors, path-traversal guards, timeouts, resource caps)

## Problem

Matrix OS today has exactly one way to get a non-default app onto the platform: have the AI scaffold a new one from `home/apps/_template-vite/` or `_template-next/`. There is no path for:

- Users who already have a React/Vite/Next.js project on their laptop and want to run it as a Matrix OS app
- Users who want to try a GitHub repo they saw ("clone this and install it for me")
- Users who built something in another workspace and want to bring it over

Spec 063 built the whole runtime, trust tiers, install-flow, and session machinery. The piece missing is an **import adapter** that takes an arbitrary source tree, makes it look like a Matrix OS app, and hands it to a staging-aware entry point in 063's install-flow. That is all 064 is.

This spec is deliberately thin. The heavy lifting — building, running, sandboxing, trust classification, session cookies — lives in 063. 064 owns fetch, detect, synthesize, patch, hand off. The hand-off target is a new parallel entry point `installFlow.installFromStagingDir()` that 063 adds as a small prerequisite to this spec (see §Dependencies); it shares 063's internal validation / rename / build / catalog-registration helpers with the existing `installFlow.install()` gallery path and ships in the same module.

## Goals

1. **Two import sources**: local tarball upload and GitHub clone. Both use the same pipeline downstream.
2. **Reuse 063 trust tiers and install-flow internals**: imports produce a manifest with `listingTrust` stamped and hand off to a new `installFlow.installFromStagingDir()` entry point in 063, which shares all the heavy-lifting helpers (schema validation, atomic rename, build orchestrator invocation, build-stamp write, catalog registration, ack-token verification) with 063's existing gallery `install()` path. The new entry point is scoped, parallel, and small (~60-100 LOC in 063); it exists so 064 does not have to synthesize a tarball just to satisfy a signature the gallery path expects.
3. **Smart trust classification**: local uploads and GitHub clones of repos where the user has write permission are `first_party` (installable immediately). GitHub clones of repos the user does not own are `community` (gated, requires ack token, flips to installable when spec 025 lands — no code change in 064).
4. **Framework detection**: support Vite, Next.js, and plain Node HTTP servers. Reject CRA and unbundled React with actionable errors.
5. **basePath / asset prefix patching** for Next.js apps, `--base` CLI injection for Vite apps, so imported apps serve correctly under `/apps/{slug}/` and `/files/apps/{slug}/dist/` respectively.
6. **GitHub auth via the terminal**: users run `gh auth login` in a Matrix OS terminal session (spec 056) before importing private repos. The import endpoint spawns `gh repo clone` under the user's own gh credentials. No OAuth flow to build in this spec.
7. **Safety by default**: slug sanitization, tarball path-traversal guards, size caps, timeouts on every external call, `.env*` stripping, temp-dir reaper.

## Non-Goals

- **Environment variable management** — split to spec 065 (App Env Vault). Imported apps that need env vars will fail to build/start with a clear error until 065 lands; they can manually add a `.env.production` in the file manager in the interim.
- **CRA → Vite auto-migration** — reject CRA apps with a "convert first, then re-import" message. Too risky to rewrite user build configs silently.
- **Monorepo / workspace support** — reject repos with a `workspaces` field. Subfolder import is a follow-up.
- **Non-GitHub git forges** (GitLab, Bitbucket, self-hosted, SSH URLs). Phase 1 leans on the `gh` CLI as the simplest path. Adding forges is a future spec.
- **Continuous sync from the source** — import is one-shot. Updates happen by editing files in place or re-importing. Re-import of the same GitHub URL produces a new slug (`my-app-2`), not an in-place update. A future spec can own "pull latest" semantics.
- **Import UI design** — 064 defines the contract and error surface. Shell layout/copy is owned separately.
- **Python, Rust, or Docker runtimes** — consistent with 063 non-goals.

## Architecture

### Pipeline

The pipeline is split into three phases with a hard **no-code-execution** invariant until after the trust gate clears. This is the single most important design constraint in this spec: imported user code — or worse, arbitrary third-party code from GitHub — must never run lifecycle scripts (`preinstall`, `install`, `postinstall`, Vite/Next config side-effects, etc.) before the user has explicitly acknowledged the community-trust risk.

```
POST /api/apps/import
  |
  v
----- Phase A: PRE-GATE (no user-code execution, no ~/apps mutation) -----
1. fetch               -> /tmp/matrix-import/{uuid}/app/  (extract-only OR git clone, no install)
2. scrub-secrets       -> delete .env* entries, stream stripped filenames (never contents)
3. classify-trust      -> first_party | community via gh-ownership (GitHub only)
4. detect-framework    -> vite | next | node-http (reads package.json ONLY, no require/import)
5. inspect-lockfile    -> identify lockfile type (read-only stat + head bytes)
6. reserve-slug        -> in-memory reservation under per-user mutex (does NOT touch ~/apps)
7. synthesize-manifest -> write matrix.json into temp dir (OR preserve + rewrite slug fields)
8. patch-basepath      -> write next.config.{ext} wrapper / rewrite build.command for Vite
                          (these are text writes; they do NOT execute user code)

----- Phase B: GATE -----
9. gate-check          -> first_party  -> proceed to Phase C
                          community    -> stream {"step":"gated"...}, PAUSE,
                                          keep temp dir alive under correlationId for 10 min

----- Phase C: POST-GATE (ack cleared OR first_party) -----
10. normalize-lockfile -> pnpm-lock: no-op
                          package-lock.json / yarn.lock: pnpm import (no scripts, metadata-only)
                          bun.lockb: reject
                          no lockfile: pnpm install --lockfile-only --ignore-scripts
                                       (generates lockfile, writes NOTHING to node_modules,
                                        executes NO lifecycle scripts)
11. hand-off           -> installFlow.installFromStagingDir({
                              stagingDir: /tmp/matrix-import/{uuid}/app,
                              resolvedSlug,
                              listingTrust,
                              ackToken,  // forwarded verbatim; 063 verifies
                            })
                          InstallFlow owns: atomic rename staging -> ~/apps/{slug}/,
                          pnpm install --frozen-lockfile, pnpm build, build stamp,
                          trust policy enforcement.
```

**Invariants.**

- **No `pnpm` invocation at all in Phase A or Phase B.** Only `gh`, `tar`, and filesystem reads/writes. Lockfile inspection in Phase A is metadata-only (`stat` + reading the first few bytes to identify the format). Every pnpm call — including the documented script-free `pnpm import` and `pnpm install --lockfile-only --ignore-scripts` — is Phase C, after the trust gate has cleared. The placement is deliberate: even though those pnpm invocations are safe by documentation, keeping them entirely on the far side of the gate means any residual risk from a future pnpm change is disclosed (community imports require ack) rather than absorbed silently.
- **064 never writes into `~/apps/`.** The temp dir at `/tmp/matrix-import/{uuid}/app/` is either renamed into place by `installFlow.installFromStagingDir` in Phase C, or reaped. There is no intermediate state where an unacknowledged community app occupies a live app directory.
- **Slug reservation is in-memory only in Phase A.** The `slug-resolver` enters the resolved slug into a gateway-wide `Map<slug, { userId, correlationId, expiresAt }>` held under the same mutex that 063's install-flow uses for its own slot acquisition, so a concurrent install from the gallery cannot steal the slug either. On gate/ack expiry or import failure, the reservation is released.
- **Gate resume never re-runs Phase A.** A valid ack within 10 min and matching principal resumes from the cached temp dir at step 10. If the temp dir has been reaped (TTL exceeded, or crash), the resume call returns `{"step":"expired"}` and the shell must re-submit the original request.
- **All error paths reap the temp dir and release the slug reservation.** The only exception is Phase B (gated): the temp dir is kept alive specifically so the user can ack.

### HTTP surface

**`POST /api/apps/import`** — authenticated via `authMiddleware` (bearer token).

Request body is one of two variants, content-type sensitive:

```
Content-Type: application/json
{ "source": "github", "url": "https://github.com/owner/repo", "ref"?: "main", "slug"?: "my-app" }

Content-Type: multipart/form-data
  source=local
  tarball=<file>
  slug=<optional>
```

There is **no `ack` field** on the initial request. Gated imports always go through a two-call flow: the initial request runs Phase A, emits `{"step":"gated"}`, and ends. The caller then mints an ack token via spec 058's modal and calls `POST /api/apps/import/resume` with `{ correlationId, ack }`. A one-shot "I already have an ack token" shortcut is not supported — it would duplicate code paths and complicate the principal-binding story without saving a round-trip the shell ever actually needs.

Response is a streaming NDJSON body (one JSON object per line) so the shell can render live progress. Every event carries `correlationId`, which is the UUID of the temp dir and the key used for gate/resume:

```jsonl
{"step":"fetching","correlationId":"imp_01HXYZ","detail":"cloning https://github.com/owner/repo"}
{"step":"scrubbing_secrets","correlationId":"imp_01HXYZ","stripped":[".env",".env.production"],"note":"removed from import. Matrix OS will provide env vars via the env vault (spec 065). Never log contents of these files."}
{"step":"classifying","correlationId":"imp_01HXYZ","trust":"first_party"}
{"step":"detecting","correlationId":"imp_01HXYZ","runtime":"vite","framework":"vite"}
{"step":"inspecting_lockfile","correlationId":"imp_01HXYZ","kind":"package-lock.json"}
{"step":"reserving_slug","correlationId":"imp_01HXYZ","slug":"my-dashboard"}
{"step":"synthesizing_manifest","correlationId":"imp_01HXYZ","action":"write_new"}
{"step":"patching_basepath","correlationId":"imp_01HXYZ","mode":"vite_cli_base"}
{"step":"gate_check","correlationId":"imp_01HXYZ","decision":"pass","reason":"first_party"}
{"step":"normalizing_lockfile","correlationId":"imp_01HXYZ","action":"pnpm_import","from":"package-lock.json"}
{"step":"handing_off","correlationId":"imp_01HXYZ","listingTrust":"first_party","distributionStatus":"installable"}
{"step":"installing","correlationId":"imp_01HXYZ","substep":"pnpm_install"}
{"step":"installing","correlationId":"imp_01HXYZ","substep":"pnpm_build"}
{"step":"done","correlationId":"imp_01HXYZ","slug":"my-dashboard"}
```

On community classification the stream reaches the gate, emits a terminal gated event, and the server **pauses** — the request ends here. The temp dir is kept alive for 10 minutes keyed on `correlationId`:

```jsonl
...Phase A steps...
{"step":"gate_check","correlationId":"imp_01HXYZ","decision":"gated","reason":"community_trust"}
{"step":"gated","correlationId":"imp_01HXYZ","listingTrust":"community","permissionsAdvisory":["network","data:read","data:write"],"ackEndpoint":"/api/apps/ack-import","ttlSeconds":600}
```

**Resume flow.** The shell opens the spec 058 ack modal, mints an ack token against `correlationId` via `POST /api/apps/ack-import` (route owned by spec 058), and re-calls `POST /api/apps/import/resume`:

```
POST /api/apps/import/resume
{ "correlationId": "imp_01HXYZ", "ack": "<token signed by 058>" }
```

The resume endpoint:

1. Validates `authMiddleware` bearer token. Looks up `correlationId` in the in-memory correlation store.
2. Confirms `correlationStore[correlationId].userId === authenticated principal`. Rejects `404 correlation_not_found` if missing (either wrong principal or temp dir reaped).
3. Verifies the ack token against `correlationId` via spec 058's verifier (not 064's code).
4. Re-opens a streaming NDJSON response and executes **only Phase C** (normalize-lockfile + hand-off). Phase A is not re-run — the pre-gate artifacts on disk are already valid.
5. On success, releases the correlation entry. On failure (build fail, install-flow rejection), reaps the temp dir and releases the slug reservation.

If the ack token is valid but the temp dir has been reaped (TTL exceeded or crash recovery), resume returns:

```jsonl
{"step":"expired","correlationId":"imp_01HXYZ","detail":"Temp dir no longer available. Re-submit the original import."}
```

The shell re-runs the full `POST /api/apps/import` flow. No state loss for the user beyond re-fetching.

The ack token format, issuer, and verifier are the **same module** spec 058 uses for community gallery installs. One modal, one issuer, one audit trail. 064 does not mint or verify ack tokens — it forwards them and trusts 058's verifier.

**Concurrent imports from the same user**. The per-user mutex is held across Phase A only. If a user starts a second import while Phase A is running, the second request receives a status response (not a dead-end 429) describing the active import so the shell can reconnect or show "already in progress":

```json
{
  "error": "import_in_progress",
  "activeImport": {
    "correlationId": "imp_01HXYZ",
    "source": "github",
    "sourceDetail": "https://github.com/owner/repo",
    "step": "patching_basepath",
    "slug": "my-dashboard",
    "startedAt": "2026-04-11T14:22:00Z"
  }
}
```

If the user's first import is paused at the gate (Phase B), a second import **is allowed** because the first is not actively consuming CPU or holding the per-user mutex — only the temp dir and the slug reservation. Two gated imports from the same user can coexist until one is ack'd or expires.

### File structure

```
packages/gateway/src/app-runtime/import/
  import-endpoint.ts          # Hono routes: POST /api/apps/import, POST /api/apps/import/resume
  import-pipeline.ts          # Phase A + Phase C orchestration, gate decision, hand-off to 063
  source-fetcher-local.ts     # Multipart upload + tar extraction, path-traversal guarded
  source-fetcher-github.ts    # gh api size probe + gh repo clone with streaming size guard
  github-ownership.ts         # gh repo view --json viewerPermission -> trust classification
  project-detector.ts         # package.json inspection -> ProjectType or rejection reason
  secrets-scrubber.ts         # Walks source dir, deletes .env* entries, returns stripped filenames
  manifest-synthesizer.ts     # Writes matrix.json with listingTrust stamped; preserves + rewrites
  basepath-patcher.ts         # Next.js wrapper config + Vite --base flag injection
  lockfile-normalizer.ts      # Post-gate: pnpm import OR pnpm install --lockfile-only --ignore-scripts
  slug-resolver.ts            # In-memory reservation table + unique slug under ~/apps/
  correlation-store.ts        # Map<correlationId, {userId, tempDir, slugReservation, expiresAt}>
  temp-dir.ts                 # /tmp/matrix-import/{uuid} lifecycle + startup reaper (TTL = 1h)
  errors.ts                   # ImportError codes
  index.ts                    # Public API exports + gateway registration

shell/src/components/
  AppImportDialog.tsx         # Shell-side import UI (contract defined here, layout owned by shell)

tests/gateway/app-runtime/import/
  import-pipeline.test.ts
  source-fetcher-local.test.ts
  source-fetcher-github.test.ts
  github-ownership.test.ts
  project-detector.test.ts
  manifest-synthesizer.test.ts
  basepath-patcher.test.ts
  lockfile-normalizer.test.ts
  slug-resolver.test.ts
  temp-dir.test.ts
tests/gateway/app-runtime/import-integration.test.ts
tests/e2e/app-import.spec.ts

tests/fixtures/import/
  vite-owned/                 # Vite app with pnpm-lock.yaml, no matrix.json
  next-owned/                 # Next.js app with a user-authored next.config.js
  node-hono/                  # Plain Hono server, no bundler
  cra-rejected/               # CRA app, rejected by detector
  monorepo-rejected/          # Has workspaces field, rejected
  bun-lockfile-rejected/      # Has bun.lockb, rejected
  npm-lockfile/               # Has package-lock.json, exercises pnpm import
  yarn-lockfile/              # Has yarn.lock, exercises pnpm import
  path-traversal/             # Tarball with ../ entries, must be rejected
  secrets-in-env/             # Has .env files, must be stripped
  pre-existing-matrix-json/   # Already structured for Matrix OS, synthesizer skips
  over-size/                  # 600 MB tarball, must trip the size cap
```

## Trust Classification

Imports produce manifests that go through spec 063's existing trust machinery. The only 064-specific logic is choosing which `listingTrust` value to stamp. There is **no new trust tier**.

| Source | Ownership check | `listingTrust` | `distributionStatus` (pre-025) | Ships |
|---|---|---|---|---|
| Local tarball upload | n/a — treated as user's own code | `first_party` | `installable` | Phase 1 |
| GitHub clone where `gh repo view --json viewerPermission` ∈ {`ADMIN`, `MAINTAIN`, `WRITE`} | writable | `first_party` | `installable` | Phase 2 |
| GitHub clone where viewer has only `READ`, `TRIAGE`, or `null` | read-only / none | `community` | `gated` | Phase 2 |

**The community path is not blocked.** It lands through 063's existing community install flow: the install-flow rebuilds from source, hashes `dist/`, and requires an ack token. When spec 025 lands, `community` flips to `installable` via the single policy function in `install-flow.ts` — same flip that unlocks community gallery apps from spec 058. No 064 code changes.

**Ownership check** lives in `github-ownership.ts`:

```typescript
export type OwnershipResult =
  | "writable"          // ADMIN / MAINTAIN / WRITE -> first_party
  | "readonly"          // READ / TRIAGE / null -> community
  | "unauthenticated"   // gh not logged in
  | "not_found";        // repo doesn't exist OR private and no access

export async function checkOwnership(ownerRepo: string): Promise<OwnershipResult>;
```

Implementation: spawns `gh repo view {ownerRepo} --json viewerPermission` under `AbortSignal.timeout(10_000)`, parses stdout, maps to `OwnershipResult`. Never throws — returns typed result or rejects with `ImportError("gh_not_authenticated" | "gh_not_available" | "repo_not_found" | "ownership_check_timeout")`.

## Project Detection

**Location**: `packages/gateway/src/app-runtime/import/project-detector.ts`

```typescript
export type ProjectType =
  | { runtime: "vite"; framework: "vite" }
  | { runtime: "node"; framework: "next" }
  | { runtime: "node"; framework: "node-http" };

export type DetectionResult =
  | { ok: true; type: ProjectType; packageJson: PackageJson }
  | { ok: false; reason: string; actionable: string };

export async function detectProjectType(sourceDir: string): Promise<DetectionResult>;
```

Decision tree (reads `sourceDir/package.json` only — no AST parsing):

1. No `package.json` at the root → `{ ok: false, reason: "no_package_json", actionable: "Matrix OS imports single-package projects. Make sure package.json is at the repo root." }`
2. `workspaces` field present → `{ ok: false, reason: "monorepo_not_supported", actionable: "Workspaces are not supported yet. Point at a single app directory, or flatten the project first." }`
3. `dependencies.next` or `devDependencies.next` present → `{ runtime: "node", framework: "next" }`
4. `dependencies.vite` or `devDependencies.vite` present (and no next) → `{ runtime: "vite", framework: "vite" }`
5. `dependencies["react-scripts"]` present → `{ ok: false, reason: "cra_not_supported", actionable: "Create React App is not supported. Convert to Vite (https://vitejs.dev/guide/migration-from-cra) and re-import." }`
6. No bundler, but `scripts.start` exists and at least one of `hono | express | fastify | koa | polka` is in dependencies → `{ runtime: "node", framework: "node-http" }`
7. `dependencies.react` with no bundler and no server framework → `{ ok: false, reason: "unbundled_react", actionable: "Matrix OS needs a bundler. Add Vite or Next.js to your project and re-import." }`
8. Otherwise → `{ ok: false, reason: "unrecognized_project", actionable: "Could not detect a supported framework. Matrix OS currently supports Vite, Next.js, and plain Node HTTP servers." }`

If the source directory already contains a valid `matrix.json`, the detector still runs (for logging), but `manifest-synthesizer.ts` preserves the existing manifest instead of overwriting. This is how a developer who structured their repo for Matrix OS can import it without re-authoring the manifest.

## Manifest Synthesis

**Location**: `packages/gateway/src/app-runtime/import/manifest-synthesizer.ts`

Synthesizer receives `{ sourceDir, projectType, packageJson, listingTrust, resolvedSlug }` and writes `matrix.json` into `sourceDir`.

**If a valid `matrix.json` already exists**, it is preserved — but **not verbatim**. 064 owns the slug (because imports always resolve a fresh slug, potentially `my-app-2` if the preferred one is taken) and therefore owns every field that is a function of the slug. The synthesizer loads the existing manifest, runs it through 063's Zod schema (reject with `ImportError("invalid_existing_manifest")` if the repo's manifest is malformed), and then **rewrites**:

- `slug` → `resolvedSlug`
- `listingTrust` → the value determined by this import (first_party / community). The user's import source decides trust, not whatever was in the repo.
- `scope` → force `"personal"` (imports always land as personal; 064 does not handle shared scope — see 063)
- `build.command` for `runtime: "vite"` → strip any existing `--base ...` argument and append `--base /files/apps/{resolvedSlug}/dist/`. Users who authored their own `--base` for a previous install are overridden, because the old slug is no longer valid
- Any `basePath` / `assetPrefix` hint in a `next.config.*` is handled by the basepath-patcher regardless of whether the manifest is synthesized or preserved — the patcher always runs

Everything else (`resources`, `permissions`, `serve`, `storage`, `category`, `icon`, etc.) is preserved as the author wrote it. A user who structures their repo for Matrix OS keeps their intentional choices.

**Slug-derived fields are a known hazard.** If a future spec adds a new manifest field whose value depends on the slug, the synthesizer's preservation code must be updated to rewrite it — or the rewrite will silently leave a stale value. This is called out in the testing section: `manifest-synthesizer.test.ts` includes a "drift sentinel" test that parses the schema and asserts every slug-shaped field is explicitly handled by the preservation path.

**Defaults for Vite imports:**

```json
{
  "name": "{package.json.name -> title case}",
  "slug": "{resolvedSlug}",
  "description": "{package.json.description ?? ''}",
  "category": "imported",
  "icon": "package",
  "author": "{package.json.author ?? '<current user handle>'}",
  "version": "{package.json.version ?? '0.1.0'}",
  "runtime": "vite",
  "runtimeVersion": "^1.0.0",
  "scope": "personal",
  "listingTrust": "{first_party|community}",
  "build": {
    "install": "pnpm install --frozen-lockfile",
    "command": "{package.json.scripts.build ?? 'pnpm build'} --base /files/apps/{slug}/dist/",
    "output": "dist",
    "timeout": 300,
    "sourceGlobs": ["src/**", "public/**", "*.config.*", "index.html", "matrix.json"]
  },
  "resources": { "memoryMb": 512, "cpuShares": 512, "maxFileHandles": 128 },
  "permissions": ["network", "data:read", "data:write"]
}
```

**Defaults for Next.js imports:**

```json
{
  "name": "...",
  "slug": "...",
  "runtime": "node",
  "runtimeVersion": "^1.0.0",
  "scope": "personal",
  "listingTrust": "...",
  "build": {
    "install": "pnpm install --frozen-lockfile",
    "command": "{package.json.scripts.build ?? 'pnpm build'}",
    "output": ".next",
    "timeout": 600
  },
  "serve": {
    "start": "{package.json.scripts.start ?? 'pnpm start'}",
    "healthCheck": "/",
    "startTimeout": 30,
    "idleShutdown": 300
  },
  "resources": { "memoryMb": 512, "cpuShares": 512, "maxFileHandles": 128 },
  "permissions": ["network", "data:read", "data:write"]
}
```

**Defaults for `node-http` imports**: same as Next.js but `build.output: "dist"` and `serve.healthCheck: "/health"` if `scripts.health` exists, else `/`.

**Import-specific starting defaults (not doctrine).** These diverge from 063's steady-state defaults because imports are a different workload: cold pnpm cache on first build, unfamiliar dependency graphs, no prior profiling. They are **starting values pending a benchmarking checkpoint in Phase 1**, not permanent choices:

- `permissions: ["network", "data:read", "data:write"]` — imported apps always get the broad advisory permission set. Confirmed as the default. When spec 025 enforces this, imported apps continue to work without re-grants. Users who want a tighter set edit `matrix.json` after import. This one is a product decision, not a benchmark target.
- `timeout: 300` (Vite) / `timeout: 600` (Next) — imported apps miss the pnpm store cache on first build, so 063's 120s default is not enough. Pessimistic starting values.
- `memoryMb: 512` (vs 063 default of 256) — Vite + Next.js builds routinely use 300+ MB. 256 OOMs often enough on first build to be worth bumping.

**Benchmarking checkpoint (Phase 1 exit criterion)**: run 5–10 real imports drawn from diverse project sizes (small Vite portfolio site, medium Next.js dashboard, large Next.js app with image optimization, a Node HTTP server, a pathological-but-legit repo like a full-stack starter). Record p50/p95 build wallclock and peak memory. Tune the three defaults above from data, then update the synthesizer constants and this section. No plan.md task closes on these defaults until the benchmark is in.

## basePath Patching

**Location**: `packages/gateway/src/app-runtime/import/basepath-patcher.ts`

Imported apps were written assuming they serve at `/`, not `/apps/{slug}/`. Asset URLs break without patching.

**Vite**: no source edit. The synthesizer appends `--base /files/apps/{slug}/dist/` to the build command. Vite's CLI flag overrides any `base` in `vite.config.*`. Zero-touch on the user's files.

**Next.js**: requires a wrapper config because Next has no CLI flag for `basePath`.

1. Detect existing `next.config.{js,mjs,ts,cjs}`. If present, rename to `next.config.user.{ext}`.
2. Write a new `next.config.{ext}` that imports the user config and merges Matrix OS settings:

```js
// Generated by Matrix OS import (spec 064). Do not edit.
// Your original config is preserved in next.config.user.js.
const userConfig = require("./next.config.user.js");
const slug = process.env.MATRIX_APP_SLUG;
if (!slug) {
  throw new Error("MATRIX_APP_SLUG is not set. This Next.js app is configured to run under the Matrix OS runtime.");
}
module.exports = {
  ...userConfig,
  basePath: `/apps/${slug}`,
  assetPrefix: `/apps/${slug}`,
};
```

3. If no `next.config.*` exists, write a minimal one without the require.
4. Handle `.js` (CJS), `.mjs` (ESM — use `import` + `export default`), and `.ts` (transpile-free: use `export default` and rely on Next's ts-node loader).

The patcher is **idempotent**: running it a second time detects the Matrix OS marker comment and no-ops. This matters for re-imports.

**node-http**: no patching. User code is expected to listen on `process.env.PORT`. 063's reverse proxy strips `/apps/{slug}/` from the path before forwarding.

## Source Fetchers

### Local tarball

**Location**: `packages/gateway/src/app-runtime/import/source-fetcher-local.ts`

Multipart upload landed by Hono with `bodyLimit(MAX_UPLOAD_MB * 1024 * 1024)` (default 100 MB). The stream is piped into `tar -x` running inside `node-tar` with a strict filter:

- Reject absolute paths
- Reject any entry whose resolved path (after symlink and `..` resolution) escapes the extraction root
- Reject symlinks, hard links, device files, FIFOs, sockets
- Reject `.git/`, `node_modules/`, and any dot-file pattern matching `.env*` (these are dropped during extraction, not after — so we never write a secret to disk even transiently)
- **Running-total size counter** increments on every extracted byte. If total exceeds `MAX_UNPACKED_MB` (default 500 MB), abort extraction, reap the partial staging dir, return `ImportError("clone_too_large"` — same code as the github fetcher for consistency `)`

Any of these rejections fails the whole import. No partial-extract retry.

### GitHub clone — bounded fetch strategy

**Location**: `packages/gateway/src/app-runtime/import/source-fetcher-github.ts`

The 500 MB clone cap must be enforced **before or during** the clone, not post hoc. Two guards, belt and suspenders:

**Guard 1 — pre-clone size probe.** Before spawning `gh repo clone`, call `gh api repos/{owner}/{repo} --jq '.size'` (GitHub's repo metadata includes the size in KB). `AbortSignal.timeout(10_000)`:

- Size > 500 MB → `ImportError("clone_too_large", "Repo size {X} MB exceeds the 500 MB import limit.")`. No clone attempted.
- Size check times out or fails with a non-404 error → log warning and fall through to Guard 2 (don't block imports on a flaky metadata API, but don't skip enforcement either).
- Size check returns 404 → `ImportError("repo_not_found")`. The ownership check would have caught this too, but the size probe is cheap and we may want to skip ownership for public repos in the future.

GitHub's `.size` field reports the repo's disk footprint in KB, which is a reasonable approximation of clone size for `--depth=1 --single-branch`. It is an **upper bound for history-shallow clones** in typical cases, which is exactly what we use.

**Guard 2 — streaming size watcher during clone.** `gh repo clone {owner}/{repo} {stagingDir} -- --depth=1 --single-branch` runs under `AbortSignal.timeout(300_000)`. In parallel, a `setInterval` polls `du -sb {stagingDir}` every 10 seconds:

- If byte count exceeds 500 MB at any poll → `child.kill("SIGKILL")`, reap staging dir, return `ImportError("clone_too_large", "Clone exceeded the 500 MB import limit after pre-clone size probe reported {Y} MB.")`. Log the discrepancy at warn level — that means `.size` lied, which is worth knowing.
- If `du` itself errors (staging dir gone, fs busy) → log and continue. The AbortSignal timeout still bounds the worst case.
- On clone exit, cancel the interval.

Combined: the pre-probe rejects obviously-too-big repos in ~100 ms without any bandwidth cost; the streaming watcher catches repos that lied or whose `.git/` dwarfs their checkout. Together they actually enforce the cap.

**URL validation**: `^https://github\.com/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}/[a-zA-Z0-9._-]{1,100}(\.git)?$` — matches GitHub's actual username/repo rules, rejects SSH, query strings, fragments, and anything else. The regex is stricter than the earlier draft to avoid weird unicode or excessively long repo names.

**Post-clone scrub**: run `secrets-scrubber.ts` over the clone, emit `{step: "scrubbing_secrets", stripped: [...filenames]}` before entering Phase B. Same stripping happens for local tarballs, but local runs it during extraction (above) to avoid ever writing secrets to disk; github clones need a post-clone pass because `gh repo clone` doesn't expose a per-file filter.

**Ref handling**: the optional `ref` field in the request body (a branch name or commit SHA) is validated against `^[a-zA-Z0-9._/-]{1,100}$` and passed via `gh repo clone -- --branch {ref}` (for branches) or a `git checkout {ref}` subprocess after clone (for SHAs, detected by 40-char hex regex). On failure to check out the ref, the import fails with `ImportError("ref_not_found")`. Phase 1 UI always uses the repo's default branch; advanced users pass `ref` via the API.

## Lockfile Normalization

**Location**: `packages/gateway/src/app-runtime/import/lockfile-normalizer.ts`
**Phase**: **Post-gate only** (Phase C). Runs after the community trust gate has cleared, or immediately after Phase A for `first_party` imports.

063's `installFlow` uses `pnpm install --frozen-lockfile`, which refuses to run without a valid `pnpm-lock.yaml`. Imported projects may arrive with a different lockfile — or none. The normalizer reconciles this **without ever executing user code**:

- `pnpm-lock.yaml` present → no-op.
- `package-lock.json` present → `pnpm import` (reads npm lockfiles, writes `pnpm-lock.yaml`, does NOT install packages and does NOT run lifecycle scripts — per pnpm docs `pnpm import` is a metadata conversion), then delete `package-lock.json`. `AbortSignal.timeout(60_000)`.
- `yarn.lock` present → same — `pnpm import` handles yarn. Delete `yarn.lock` after.
- `bun.lockb` present → `ImportError("lockfile_unsupported", "bun.lockb is not currently supported. Remove it and re-import, or use pnpm/npm/yarn.")`. No auto-conversion.
- None of the above → run `pnpm install --lockfile-only --ignore-scripts` (generates `pnpm-lock.yaml` from `package.json`, **writes nothing under `node_modules/`**, refuses to execute any `preinstall` / `install` / `postinstall` / `prepare` script even if present in the manifest). `AbortSignal.timeout(120_000)`. This is the only place 064 generates a lockfile at all, and it runs with both belt and suspenders against lifecycle scripts.

**Why this is safe.** `pnpm install --lockfile-only` by pnpm's documented semantics does not write `node_modules/` and does not run lifecycle scripts. `--ignore-scripts` is a second layer of defense against any edge case or future pnpm behavior change. If either flag is ever dropped in a future pnpm version, the normalizer's own argv check guards against it (unit test asserts both flags are present).

**Why this is in Phase C, not Phase A.** Even though `pnpm install --lockfile-only --ignore-scripts` is documented as not executing user code, (a) it still invokes pnpm which resolves the dependency graph against the npm registry, and (b) a future pnpm bug or unsandboxed plugin could widen the blast radius. Placing it **after** the user has ack'd the community trust gate means any residual risk is disclosed, not absorbed silently. First-party imports skip the gate and run this immediately, which is fine: first-party code is the user's own.

## Slug Resolution & Reservation

**Location**: `packages/gateway/src/app-runtime/import/slug-resolver.ts`

```typescript
export type SlugReservation = { slug: string; release: () => void };

export async function reserveSlug(options: {
  preferred?: string;
  packageJsonName: string;
  userId: string;
  correlationId: string;
  ttlMs: number; // 10 min for gated, 5 min for first-party (just covers Phase C runtime)
}): Promise<SlugReservation>;
```

1. If `options.preferred` is set, validate against `SAFE_SLUG` regex (`^[a-z0-9][a-z0-9-]{0,63}$`). Reject with `ImportError("invalid_slug")` if not.
2. Otherwise derive from `packageJsonName`: lowercase, replace any char outside `[a-z0-9-]` with `-`, collapse consecutive dashes, trim leading/trailing dashes, truncate to 64 chars. If the result fails `SAFE_SLUG`, fall back to `imported-app`.
3. Under a gateway-wide slug lock (shared with 063's install-flow, so gallery installs and imports cannot collide): for each candidate starting with the derived slug, check both `~/apps/{candidate}/` existing on disk **and** the reservation table. If either is occupied, try `{candidate}-2`, `{candidate}-3`, ..., `{candidate}-99`.
4. If all 99 are taken, throw `ImportError("slug_exhausted", "Too many apps share this slug. Provide an explicit slug in the import request.")`.
5. Enter the chosen slug into the reservation table as `{ userId, correlationId, expiresAt: now + ttlMs }` and return the reservation handle. Releasing the handle clears the entry.

Reservations are **in-memory only** — they do not create any directory under `~/apps/`. On gateway restart, reservations are lost, which is safe: any half-started import is reaped by the temp-dir reaper and the slug becomes available again. There is no on-disk state to roll back.

## Staging & Hand-off

064 **never** creates a directory under `~/apps/`. The temp dir at `/tmp/matrix-import/{uuid}/app/` is the staging area for the entire pre-install lifecycle. After the gate clears and the lockfile is normalized, 064 hands the staging dir to a new entry point in 063's install-flow:

```typescript
// packages/gateway/src/app-runtime/install-flow.ts — new entry point added by this spec
export async function installFromStagingDir(opts: {
  stagingDir: string;            // /tmp/matrix-import/{uuid}/app, fully prepared
  resolvedSlug: string;          // slug reservation, held by the caller
  listingTrust: "first_party" | "community";
  ackToken?: string;             // required for community, verified via 058 inside install-flow
  principalUserId: string;
}): Promise<{ slug: string; distributionStatus: "installable" }>;
```

**InstallFromStagingDir responsibilities (owned by 063, not 064):**

1. Re-validate `matrix.json` on disk at `stagingDir/matrix.json` against the runtime Zod schema. Reject on any mismatch with the declared `listingTrust` or `resolvedSlug`.
2. For `community`, verify the `ackToken` against `{ correlationId: basename(stagingDir), principalUserId }` via 058's verifier. Reject `401 invalid_ack` on failure.
3. Compute `distributionStatus` from `listingTrust` via the existing policy function. If `gated` and no ack, reject — but the 064 pipeline should have caught this at the gate, so reaching this path is a bug and logs at error level.
4. Under the install-flow slot lock, `fs.rename(stagingDir, join(homeDir, "apps", resolvedSlug))` — `rename` is atomic on the same filesystem. Both paths must live on the same device: `/tmp/matrix-import/` is configured to be a bind-mount / subdirectory of the gateway container's app volume, not a separate tmpfs, so `rename` does not fall back to copy+unlink. This is a documented dependency in `docs/dev/docker-development.md`.
5. On `EEXIST`: the slug got taken between reservation and rename (race with a gallery install that bypassed the shared lock — a bug). Release the reservation, reap the staging dir, return `ImportError("slug_race")` with correlation ID, log at error.
6. After successful rename, run the normal install-flow build pipeline: `pnpm install --frozen-lockfile` → `pnpm build` → write `.build-stamp` → register in the app catalog.
7. On any failure inside 063's build pipeline, 063 owns cleanup: remove `~/apps/{slug}/`, propagate a typed error, release the slug.

064's hand-off is one function call. There is no 064 code path that writes into `~/apps/` or holds state after `installFromStagingDir` returns.

**Why this is a new 063 entry point, not a wrapper around `installFlow.install()`.** `installFlow.install()` in 063 is designed to consume a gallery install bundle (`source.tar.gz + dist.tar.gz + manifest.json + publisher_signature`). It has no concept of "source already extracted, config already patched, manifest already synthesized." Adding staging-dir support is cleaner as a parallel entry point that shares the build and registration internals via extracted helpers. See `064 Dependencies → Spec 063 additions` at the bottom of this document for the full contract.

## Security

Per CLAUDE.md Mandatory Code Patterns:

### External calls

Every subprocess and every fetch in the import pipeline has an `AbortSignal.timeout`:

| Call | Timeout |
|---|---|
| `gh repo view` (ownership check) | 10 s |
| `gh repo clone` | 300 s (5 min — repos can be large on slow networks) |
| `tar -x` (local extraction) | 120 s |
| `pnpm import` (lockfile conversion) | 60 s |
| Tarball upload stream | 120 s |

Backend errors never leak to the client. The NDJSON stream exposes typed `ImportError` codes only. Full stderr tails go to gateway logs keyed by correlation ID.

### Input validation

- `bodyLimit(MAX_UPLOAD_MB * 1024 * 1024)` on `/api/apps/import` (default 100 MB, env-configurable via `MATRIX_IMPORT_MAX_UPLOAD_MB`)
- GitHub URL validated against `^https://github\.com/[\w.-]+/[\w.-]+(\.git)?$`. Rejects SSH, short form, query strings, fragments, and any non-github host
- Slug validated with `SAFE_SLUG` regex before any filesystem operation
- `gh` invocations pass the repo identifier via argv, never via shell string interpolation
- Tarball extraction uses `node-tar` with a filter that rejects: absolute paths, any path containing `..`, symlinks pointing outside the extraction root, hard links, device files, FIFOs. Reject `.git/` and `node_modules/` as a hygiene measure (reduces attack surface, speeds up extraction)
- Post-extract scan for `.env*` files — delete and log the filenames (not contents)
- Post-clone scan same as above

### Resource management

- **Per-user Phase-A concurrency**: one active Phase-A import per user. Second request from the same principal while Phase A is running returns a `409 import_in_progress` status body describing the active import (see §HTTP surface for the shape), not a dead-end `429`. Phase-A mutex releases at the gate or at the hand-off call, so users are never blocked while their own prior import is paused in Phase B.
- **Per-user Phase-B cap**: a single user may have up to **3 gated imports** pending ack simultaneously (each holds a temp dir + slug reservation but no CPU). Fourth gated import returns `409 gated_quota_exceeded` with the list of pending correlation IDs so the UI can prompt to ack or cancel one. This prevents a user from pinning unbounded disk via gated imports.
- **Temp dir layout**: `/tmp/matrix-import/{uuid}/` where UUID is generated server-side. On gateway startup, `temp-dir.ts::reapStaleTempDirs()` removes any temp dir whose mtime is older than 1 hour. Temp dirs tied to a live correlation store entry are kept until the entry's `expiresAt` even if their mtime is stale.
- **Size caps**: 100 MB upload (bodyLimit), 500 MB unpacked tarball (running-total counter during extraction, aborts on overflow), 500 MB git clone enforced by the two-guard strategy in §Source Fetchers (pre-clone metadata probe + streaming `du` watcher during clone).
- **Global slot cap**: `Map<correlationId, ImportSession>` capped at 32, LRU eviction with graceful abort of the oldest pending session (reaps temp dir, releases slug, closes stream with `{step:"evicted"}`). Caps the worst case where many concurrent imports pile up.
- **Correlation store cap**: `Map<correlationId, CorrelationEntry>` capped at the same 32, same eviction policy, so pending gated imports can't stay alive indefinitely regardless of per-user limits.
- **Build concurrency** is owned by 063's build orchestrator (4 parallel slugs globally). Imports inherit it automatically via the install-flow hand-off.

### Child process isolation

- `gh`, `tar`, `pnpm`, and `du` spawn via `child_process.spawn` with `{ cwd: <temp dir>, env: importSafeEnv() }` where `importSafeEnv()` is a dedicated whitelist:

```typescript
{
  PATH: minimalPath,
  HOME: gatewayUserHome,    // so gh reads ~/.config/gh/hosts.yml for the user's login
  PNPM_HOME: "~/.pnpm-store",
  // NO CLAUDE_API_KEY, NO CLERK_SECRET, NO DB_URL, NO NODE_OPTIONS
}
```

- `NODE_OPTIONS` stripped from inherited env to prevent debugger injection into pnpm subprocess.
- Run as the same user as the gateway (container is the security boundary — consistent with 063).

### Error handling

All catches are typed. No bare `catch { return null }`. No silent fallbacks. The `ImportError` class lives in `errors.ts`:

```typescript
export class ImportError extends Error {
  constructor(
    public code:
      | "no_package_json"
      | "unrecognized_project"
      | "cra_not_supported"
      | "unbundled_react"
      | "monorepo_not_supported"
      | "invalid_existing_manifest"
      | "lockfile_unsupported"
      | "lockfile_normalize_failed"
      | "lockfile_generate_failed"
      | "invalid_github_url"
      | "invalid_slug"
      | "gh_not_authenticated"
      | "gh_not_available"
      | "repo_not_found"
      | "repo_private_no_access"
      | "ref_not_found"
      | "clone_timeout"
      | "clone_too_large"
      | "upload_too_large"
      | "tarball_path_traversal"
      | "tarball_malformed"
      | "slug_exhausted"
      | "slug_race"
      | "import_in_progress"
      | "gated_quota_exceeded"
      | "correlation_not_found"
      | "correlation_principal_mismatch"
      | "invalid_ack"
      | "ack_already_consumed"
      | "ack_expired"
      | "staging_expired"
      | "disk_full"
      | "ownership_check_timeout"
      | "install_flow_rejected",
    public detail: string,
    public actionable?: string,
    public cause?: unknown,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ImportError";
  }
}
```

`install_flow_rejected` wraps a typed error from 063's `installFlow.installFromStagingDir()` as `cause`, so the UI can surface the underlying build/ack/schema failure without 064 needing to know about every 063 error code.

### Secret hygiene

- `.env*` files are **stripped, not silently**. The import pipeline emits a dedicated `{"step":"scrubbing_secrets","stripped":[filenames],"note":"..."}` NDJSON event so the shell can surface a clear "we removed 3 env files — use the env vault (spec 065) once it ships" card to the user. Silent stripping would look like mysterious import breakage later when the app can't find its env.
- Filenames in the `stripped` array are always safe to display. **Contents are never logged, never emitted over the stream, and never read into memory beyond what `fs.unlink` touches**. The scrubber uses `fs.rm` on the path without opening the file.
- The set of patterns stripped: `.env`, `.env.*`, `*.env`, `.secret`, `.secret.*`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`. Anything else is left alone.
- `gh` credentials live in `~/.config/gh/hosts.yml` on disk. The import subprocess inherits them via `HOME`, so no secret flows through environment variables.
- The repo URL is logged with query string and fragment stripped (guards against a user pasting `https://...?token=ghp_...`).

### Authorization (route matrix)

Spec 064 adds two routes. Ack issuance is delegated to spec 058 and is **not** mounted by 064.

| Route | Caller | Auth | Extra checks | Principal binding |
|---|---|---|---|---|
| `POST /api/apps/import` (initial, JSON or multipart) | Shell `fetch` | `authMiddleware` bearer | `bodyLimit`, GitHub URL regex (for source=github), `SAFE_SLUG` for `slug` override, per-user Phase-A mutex | Principal = container owner; correlation store entry bound to this principal |
| `POST /api/apps/import/resume` | Shell `fetch`, after 058 ack modal | `authMiddleware` bearer + `correlationId` lookup + ack token verification via 058 verifier | `correlationStore[correlationId].userId === principal` (prevents cross-principal ack replay), temp dir still exists, ack not already consumed | Principal must match the one that started the original import |
| `POST /api/apps/ack-import` | Shell, user consent UI | Owned by **spec 058** (not mounted here) | — | Ack token is signed over `{ correlationId, principalUserId, expiresAt }` |
| `GET /apps/{slug}/*` / `GET /files/apps/{slug}/*` post-import | Browser iframe | Inherited entirely from **spec 063** (app session cookie) | — | — |

**Principal binding invariants:**

- The correlation store keys on `correlationId`; each entry records `userId`, `tempDir`, `slugReservation`, and `expiresAt`. On `/resume`, the authenticated principal must match `entry.userId`. A user who somehow obtains another user's ack token (e.g. via a bug in 058 or a compromised shell session) still cannot land the import, because the gateway re-verifies the principal on `/resume`.
- The same invariant holds for concurrent imports from a single user (two browser tabs): each tab has its own `correlationId`, so the ack path is unambiguous.
- Ack tokens are **single-use**. 058's verifier marks the token consumed after `/resume` succeeds. A repeated `/resume` with the same token returns `401 ack_already_consumed`. This prevents replay after the first install completes and the temp dir is reaped — an attacker cannot use an old token to install a later version of the same repo.

**What this prevents:**

- Cross-user ack replay (principal mismatch on `/resume`)
- Ack replay after install (single-use token)
- Gate bypass via direct `installFromStagingDir` call (063 re-verifies the ack token internally and fails closed if the correlation store entry is missing or principal-mismatched)
- Race between gate and hand-off (slug reservation held across both)

**What this does NOT prevent (out of scope for 064):**

- A compromised 058 ack issuer that signs tokens freely — that's 058's security surface
- A compromised 063 install-flow that accepts any staging dir — that's 063's security surface
- Malicious code inside a first-party import — local uploads and owned repos are explicitly trusted as "user's own code"; see §Trust Classification

After the import completes, the new app is reachable at `/apps/{slug}/*` under 063's session cookie flow. Nothing 064-specific is needed there — the first `POST /api/apps/{slug}/session` call from AppViewer issues the cookie exactly like any other app.

## Failure Modes

| Failure | Detection | Response |
|---|---|---|
| Upload exceeds `MAX_UPLOAD_MB` | Hono `bodyLimit` | `413 upload_too_large` |
| Tarball contains `../` entry | node-tar filter | `400 tarball_path_traversal`, temp dir reaped |
| Tarball malformed | node-tar throw | `400 tarball_malformed` |
| GitHub URL fails regex | pre-clone validation | `400 invalid_github_url` |
| `gh` binary missing | ENOENT on spawn | `500 gh_not_available` (infra issue, surfaced to user as "GitHub import is temporarily unavailable") |
| `gh` not authenticated | stderr parse after `gh repo view` | `401 gh_not_authenticated`, actionable: "Run `gh auth login` in a terminal, then retry." |
| Repo not found (or private, no access) | `gh repo view` exit code + stderr | `404 repo_not_found` or `403 repo_private_no_access` |
| Ownership check exceeds 10 s | AbortSignal | `504 ownership_check_timeout` |
| Pre-clone size probe reports > 500 MB | `gh api repos/{owner}/{repo} --jq '.size'` | `413 clone_too_large`, no clone attempted |
| Clone exceeds 5 min | AbortSignal | `504 clone_timeout`, temp dir reaped |
| Clone exceeds 500 MB during fetch | streaming `du -sb` watcher every 10 s | SIGKILL clone process, `413 clone_too_large`, temp dir reaped, log discrepancy with reported `.size` |
| Ref not found on clone | `git checkout` exit | `404 ref_not_found`, temp dir reaped |
| No `package.json` at root | detector | `422 no_package_json` |
| CRA detected | detector | `422 cra_not_supported` with conversion link |
| Unbundled React | detector | `422 unbundled_react` |
| Workspaces / monorepo | detector | `422 monorepo_not_supported` |
| Pre-existing `matrix.json` fails schema | synthesizer | `422 invalid_existing_manifest` |
| `bun.lockb` only | normalizer | `422 lockfile_unsupported` |
| `pnpm import` fails | exit code + stderr | `500 lockfile_normalize_failed` (chained cause) |
| `pnpm install --lockfile-only` fails | exit code + stderr | `500 lockfile_generate_failed` (chained cause) |
| Slug derivation yields empty/invalid | resolver | fall back to `imported-app` |
| Slug reservation collision loop exhausted | resolver | `409 slug_exhausted`, user must supply explicit slug |
| Slug reservation race with gallery install (EEXIST on rename inside `installFromStagingDir`) | 063's rename | bug — release reservation, reap staging, `500 slug_race` with correlation ID, log at error |
| InstallFromStagingDir rejects (build fail, ack mismatch, schema drift) | typed error from 063 | `install_flow_rejected` with chained cause, temp dir reaped |
| Community classification, no ack token | gate check | Stream ends with `{"step":"gated",...}`, temp dir kept for 10 min, slug reservation held |
| Resume: correlation ID not in store | `/resume` lookup | `404 correlation_not_found` |
| Resume: principal mismatch | `/resume` principal check | `403 correlation_principal_mismatch`, log at warn |
| Resume: ack token invalid / consumed / expired | 058 verifier | `401 invalid_ack` / `401 ack_already_consumed` / `401 ack_expired` |
| Resume: temp dir reaped between gate and ack | filesystem stat on resume | Stream returns `{"step":"expired"}`, `404 staging_expired`, shell re-submits |
| Second Phase-A import from same user | per-user mutex | `409 import_in_progress` with active-import status body |
| Fourth pending gated import from same user | Phase-B quota | `409 gated_quota_exceeded` with pending correlation IDs |
| Global correlation store at cap (32) | LRU eviction | Oldest pending session is evicted: stream closes with `{"step":"evicted"}`, temp dir reaped, slug released |
| Disk full during clone or unpack | ENOSPC | `507 disk_full`, temp dir reaped |

## Testing

**Unit tests** (one per module under `tests/gateway/app-runtime/import/`):

- `project-detector.test.ts` — all happy paths (vite, next, node-http), all reject paths (cra, unbundled, monorepo, no package.json, unrecognized), pre-existing matrix.json preservation
- `github-ownership.test.ts` (with a mock `gh` binary) — `ADMIN/MAINTAIN/WRITE` → writable, `READ/TRIAGE/null` → readonly, unauthenticated, not_found, timeout
- `source-fetcher-local.test.ts` — happy path tarball, path traversal rejection, running-size cap enforcement (aborts mid-stream), `.env*` stripping emits stream event with filenames, malformed tar
- `source-fetcher-github.test.ts` (mock `gh`) — happy path clone, pre-clone size probe rejects oversized repo **before** clone spawns, streaming `du` watcher kills clone that exceeds cap mid-fetch, clone timeout, auth error, repo not found, private no access, URL validation against the strict regex, ref-not-found
- `secrets-scrubber.test.ts` — deletes known patterns, stream event emits filenames (never contents), does not read file contents into memory
- `manifest-synthesizer.test.ts` — all three framework defaults, listingTrust stamping (first_party vs community), pre-existing matrix.json preservation **with slug rewrite** (asserting `slug`, `build.command` `--base` substring, and `scope: "personal"` are rewritten while other fields are preserved), **drift sentinel test** that walks the 063 Zod schema and asserts every slug-shaped field is listed in the preservation rewrite list
- `basepath-patcher.test.ts` — next.config in `.js`, `.mjs`, `.ts`, `.cjs`; no config exists → minimal written; idempotence (run twice → same output); Vite command rewrite with `--base`
- `lockfile-normalizer.test.ts` — pnpm no-op, npm → pnpm import, yarn → pnpm import, bun rejection, no lockfile → `pnpm install --lockfile-only --ignore-scripts` (**mock subprocess asserts both flags are in argv**), regression test that lifecycle scripts in a fixture are **not** executed
- `slug-resolver.test.ts` — derivation from package name, preferred override, collision retry against both on-disk directories AND the in-memory reservation table, exhaustion, invalid slug rejection, reservation release on handle drop
- `correlation-store.test.ts` — bound enforcement, LRU eviction closes stream with `{"step":"evicted"}`, TTL expiry, principal binding lookup, single-use consumption
- `temp-dir.test.ts` — UUID allocation, reaper removes stale dirs, reaper preserves dirs tied to live correlation entries, reconciliation of stale correlation/reservation entries on startup
- `import-pipeline.test.ts` — end-to-end with local and github fixtures, first_party and community paths, Phase-A failure cleanup, Phase-C failure cleanup, gated → ack → resume path, gated → timeout → expired path, concurrent Phase-A imports return active-import status, Phase-B gated-quota enforcement
- `phase-gate-invariant.test.ts` — **dedicated guard test** that runs a fixture with a malicious `preinstall` lifecycle script. Asserts the script does NOT execute during Phase A or Phase B, even for a community-classified import that is never ack'd. The malicious script writes a sentinel file; the test asserts the sentinel is absent.

**Integration test** (`tests/gateway/app-runtime/import-integration.test.ts`):

- Upload `tests/fixtures/import/vite-owned/` as a real tarball → pipeline → `installFromStagingDir` → build → serves `dist/index.html` through 063's static route. Assert end-to-end 200 on the served page.
- Clone `tests/fixtures/import/next-owned/` via a file:// bare repo (mock `gh` to shell out to plain git against the local path) → pipeline → `installFromStagingDir` → spawn → proxy a request → assert SSR HTML comes back. Validates the basepath patcher end-to-end.
- Force a community classification (mock `gh` to return READ), import, assert the stream emits `{"step":"gated"}` and pauses, mint an ack token via the 058 test helper, call `/resume`, assert success and catalog registration.
- Community import: `/resume` with a valid ack token but a **different principal** returns `403 correlation_principal_mismatch`.
- Community import: `/resume` twice with the same ack token returns `401 ack_already_consumed` on the second call.
- Community import: wait past the 10 min TTL (fake clock), `/resume` returns `{"step":"expired"}`, temp dir is reaped, original slug reservation released.
- Concurrent Phase-A imports from same user: second request receives `409 import_in_progress` with full `activeImport` status body.
- Three gated imports from same user: fourth returns `409 gated_quota_exceeded` with the pending correlation IDs.
- Temp dir reaper: create a stale temp dir with a matching stale correlation entry, restart the gateway in the test, assert both are cleaned up and the slug becomes available again.
- Slug race: stage an import to `foo`, then start a gallery install of `foo` via 063's install-flow, assert the import's hand-off fails with `slug_race` and cleanup happens correctly. Validates the shared slug reservation table.

**E2E test** (`tests/e2e/app-import.spec.ts`, Playwright):

- Sign in, open the import dialog, drop a fixture tarball, wait for the streaming progress to reach `done`, click the new app in the launcher, assert it renders. Screenshot each progress state.
- Paste a GitHub URL (test fixture file:// origin, gh mocked), assert the ownership check step shows "first_party", assert the app opens.
- Try to import a mocked-private repo without `gh auth`, assert the error card shows the "Run `gh auth login` in a terminal" actionable message.
- Drop a tarball that exceeds the size cap, assert `413` error card.

## Integration Wiring

- `import-endpoint.ts` mounts two routes in `packages/gateway/src/server.ts` after `authMiddleware` and before the 063 app runtime routes: `POST /api/apps/import` and `POST /api/apps/import/resume`.
- `import-pipeline.ts` takes `installFlow`, `correlationStore`, and `slugReservationTable` as **constructor arguments**, not via globalThis lookup (per CLAUDE.md "Wiring Verification" rule). Gateway startup builds the pipeline instance once and passes it into the endpoint handler.
- `installFlow.installFromStagingDir()` is a new entry point added to spec 063's install-flow module. See §Dependencies for the exact contract.
- `slugReservationTable` is a gateway-wide singleton shared between 064's resolver and 063's install-flow slot acquisition so that import reservations and gallery installs cannot collide on the same slug. 063 exposes a `tryReserveSlug(slug, owner)` / `releaseSlug(slug)` API for this purpose; the addition is documented in §Dependencies.
- `correlationStore` is a 064-local singleton (`packages/gateway/src/app-runtime/import/correlation-store.ts`), bounded to 32 entries, with TTL cleanup driven by the same gateway tick that reaps stale temp dirs.
- `github-ownership.ts` checks for the `gh` binary at module load via `spawnSync("gh", ["--version"])`. Result cached for the process lifetime. If missing, GitHub imports fail fast with `gh_not_available` instead of a confusing spawn error. The same probe also verifies `gh api --help` includes the `--jq` flag (present in gh ≥ 2.0), so the pre-clone size probe is guaranteed to work.
- `temp-dir.ts::reapStaleTempDirs()` is called from the gateway startup hook, right after it binds the port but before the first request. Runs asynchronously so it doesn't block startup on slow filesystems. On first reap, also reconciles the correlation store and slug reservation table (clear any entries whose temp dir is gone).
- `shell/src/components/AppImportDialog.tsx` is the shell-side client. It owns multipart upload, GitHub URL input, streaming NDJSON consumption, error card rendering, the "removed N env files" notice, the active-import reconnect flow on 409, and the hand-off to the ack modal from spec 058 on `{"step":"gated"}`. Contract between shell and gateway is defined here; the UI layout lives in the shell repo and is not gated by this spec.

## Quality Gates Checklist

- [x] **Security architecture**: full §Authorization route matrix covering `/api/apps/import`, `/api/apps/import/resume`, and the deferred `/api/apps/ack-import` (owned by 058); principal binding on correlation store entries; single-use ack tokens with 058's verifier; typed `ImportError` taxonomy; slug regex; GitHub URL regex; tarball path-traversal filter; `bodyLimit`; `.env*` stripping emitted over the stream (filenames only, never contents); correlation IDs on every stream event and error; `importSafeEnv()` whitelist; `NODE_OPTIONS` scrub; ack token reuse from spec 058 for community classification; subprocess argv (never shell interpolation) for all `gh`/`tar`/`pnpm` calls
- [x] **Pre-gate invariant**: Phase A runs no user code, no `pnpm install` / lifecycle scripts. The no-lockfile path uses `pnpm install --lockfile-only --ignore-scripts` in Phase C, after the trust gate clears. 064 never writes into `~/apps/`; the atomic rename from staging to the live app directory is owned by `installFlow.installFromStagingDir` in 063.
- [x] **Integration wiring**: endpoint mounted after authMiddleware, pipeline built at gateway startup with `installFlow` + `correlationStore` + `slugReservationTable` injected, `gh` availability + `gh api --jq` probed at module load, startup temp-dir reaper hook reconciles correlation store + slug reservations
- [x] **Failure modes**: table covers upload/clone/parse/build/install/disk/race/concurrency/gated/resume/eviction paths with typed responses
- [x] **Resource management**: per-user Phase-A mutex returning active-import status (not dead 429), per-user Phase-B gated-import quota (3), global 32-slot correlation store with LRU, 1-hour temp-dir TTL + startup reaper, 100 MB upload / 500 MB unpacked tarball / 500 MB clone (two-guard: pre-probe + streaming watcher), all subprocess calls under `AbortSignal.timeout`
- [ ] **Runtime permission enforcement**: inherited from spec 063 — `permissions` is advisory metadata until spec 025 lands. Imported apps stamp the default `["network", "data:read", "data:write"]` set. The community tier flips from `gated` to `installable` automatically when 025 lands, with no 064 code changes.

## Open Questions

1. **Benchmark checkpoint (Phase 1 exit criterion, blocking)** — the `memoryMb: 512`, Vite `timeout: 300`, and Next `timeout: 600` defaults are pessimistic starting values, not doctrine. Phase 1 must run 5–10 real imports across a deliberately diverse corpus (small Vite portfolio, medium Next.js dashboard, large Next.js with image optimization, plain Node HTTP server, full-stack starter) and record p50/p95 build wallclock + peak memory. Tune the defaults in the synthesizer from data. No plan.md task closes on these defaults until the benchmark is done and this section is updated with the measurements.
2. **Monorepo subpath import** — rejected in v1. Obvious next step is `{ source: "github", url, subpath: "apps/web" }`. Thin extension to the fetcher (pass subpath to the detector and set `cwd` accordingly). Defer to a follow-up; not worth expanding 064's validation/UX/test matrix before the base importer is stable.
3. **Re-import semantics (product behavior, not open)** — v1 produces a new slug (`my-app-2`). This is intentional and documented: safer than silent in-place update, predictable for users, no state loss. The synthesized manifest records the source (local upload hash or GitHub URL + ref + resolved commit SHA) in a new `importSource` field, so a future spec can add "update in place" without a schema migration. Spec 064 does not ship the update flow.
4. **AI-assisted fix-ups** — detector rejections (CRA, missing build script) are obvious spots where an AI could offer to rewrite the project. Tempting but risky: users expect their source unchanged. Defer to a future spec with explicit opt-in.
5. **Branch / ref selection UI** — schema accepts `ref`, Phase 1 UI defaults to the repo's default branch. Power-user branch selection can come later via a simple input field.
6. **GitLab / Bitbucket / self-hosted forges** — 064 Phase 1 is GitHub-only via `gh`. The pipeline downstream of the fetcher is source-agnostic, so the cost of adding a new forge is isolated to one new `source-fetcher-*.ts` module. Separate spec.

## Implementation Phases

**Phase 1 — Local tarball upload**: import-endpoint (streaming NDJSON), source-fetcher-local, project-detector, lockfile-normalizer, manifest-synthesizer, basepath-patcher, slug-resolver, temp-dir, errors, per-user mutex, hand-off to 063's installFlow. Covers the most common case (user has a project on their laptop) without taking on `gh` complexity. Ships independently.

**Phase 2 — GitHub clone**: source-fetcher-github, github-ownership, gh-availability probe. Adds the second source without touching the downstream pipeline. Depends on Phase 1.

**Phase 3 — Shell UX**: `AppImportDialog.tsx`, drag-and-drop zone, streaming progress renderer, error card, gated-install ack handshake. Depends on Phases 1 and 2 being complete on the gateway side, but can land in parallel with Phase 2 once the endpoint contract is frozen.

Phase 1 can ship with a minimal curl-based workflow ("here's the API, use it from the terminal") before Phase 3 lands, which shortens the critical path for getting real imports working in production.

## Dependencies

### Spec 063 — required additions

064 depends on three additions to 063's install-flow that are not in 063's current draft. Each is small and isolated; they should land as a prerequisite patch to 063 before 064 Phase 1 ships:

1. **`installFromStagingDir(opts)` entry point** — accepts a pre-prepared staging directory (matrix.json written, config patched, lockfile present, no node_modules) and runs the existing install-flow's validation → atomic rename → build pipeline against it. Signature in §Staging & Hand-off. This is a parallel entry point to the existing `installFlow.install()` and shares internal helpers (manifest re-validation, rename, build orchestrator invocation, build-stamp write, catalog registration). Estimated 60–100 new LOC in 063, no schema changes.
2. **Shared slug reservation table** — expose `tryReserveSlug(slug, owner)` / `releaseSlug(slug)` / `isReserved(slug)` on a gateway singleton that both 063's install-flow slot acquisition and 064's slug-resolver consult. Prevents a gallery install and a local import from picking the same slug between reservation and rename. Estimated 30–50 LOC in 063.
3. **Ack token verifier API exposed from 058 module, called by 063** — 063's `installFromStagingDir` must verify the ack token for community imports. Spec 058 already owns issuance; 063 gains a dependency on 058's verifier module. 058 exposes `verifyAckToken({ token, correlationId, principalUserId }): { ok } | { error }`. No new spec work in 058, but the module boundary must be settled.

These are listed in the 063 plan as blockers for 064 Phase 1 — they can land in a small PR to 063 ahead of any 064 code.

### Other specs

- **Spec 063** — install-flow, manifest schema, trust tiers, `listingTrust` / `distributionStatus` policy function, `AppSession` cookies. Must be at Phase 1 complete (plus the three additions above) before 064 Phase 1 can ship; must be at Phase 2 complete (process manager + reverse proxy) before 064 can import Next.js apps end-to-end.
- **Spec 056** — terminal sessions. Users run `gh auth login` here before GitHub imports of private repos work. No code dependency — just a UX dependency for the documented workflow.
- **Spec 058** — gallery ack token format, issuer, and verifier. 064 never mints or verifies ack tokens directly; 063 is the consumer via the verifier API. The shell's "I understand the risk" modal is owned by 058 and imported by 064's `AppImportDialog.tsx`.
- **Spec 025** — runtime permission enforcement. When it lands, community-classified imports flip from `gated` to `installable` automatically via 063's policy function. Not gated work for this spec.
