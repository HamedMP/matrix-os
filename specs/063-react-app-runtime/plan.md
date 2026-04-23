# React App Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a React app runtime with three modes — `static` (existing HTML), `vite` (SPA built to `dist/`), `node` (long-running server, Next.js blessed) — so default apps and user-built apps can be authored as idiomatic React/TypeScript projects with access to the full npm ecosystem.

**Architecture:** Gateway owns three subsystems living under `packages/gateway/src/app-runtime/`: a build orchestrator (installs + builds on demand with lockfile + source hash caching), a process manager (spawn / health check / idle shutdown / crash recovery / LRU eviction), and a reverse proxy (Hono middleware forwarding HTTP + WebSocket to child processes). Shell adds a manifest-aware `AppViewer` that picks the iframe src based on runtime mode. pnpm's content-addressable store keeps per-app `node_modules` cheap.

**Tech Stack:** Node 24 + TypeScript 5.5 strict, Hono (HTTP + WS), Zod 4, pnpm (content-addressable store), Vitest, node:child_process, AbortSignal timeouts per CLAUDE.md, typed errors, no bare catches.

**Constitution gates:** Everything Is a File (source on disk, no in-memory state outside process manager), TDD (failing tests first), Defense in Depth (env whitelist, resource limits, bodyLimit, sanitized proxy errors).

---

## Phase Order

```
Phase 1: Static + Vite (no process)      -- unblocks spec 060 app development
  |
  +--> Phase 2: Node runtime              -- unblocks Next.js apps in spec 060
        |
        +--> Phase 3: App store wiring    -- trusted + verified install paths
              |
              +--> Phase 4: Dev mode      -- out of scope for this spec, stubbed only
```

Phase 1 must land on `main` before Wave 2 agents in spec 060 start. Phase 2 can land in parallel with Wave 2 Vite app development.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/gateway/src/app-runtime/manifest-schema.ts` | **NEW** — Zod schema for matrix.json runtime fields (runtime, runtimeVersion, build, serve, resources, scope) |
| `packages/gateway/src/app-runtime/manifest-loader.ts` | **NEW** — reads + validates matrix.json, caches by mtime |
| `packages/gateway/src/app-runtime/build-cache.ts` | **NEW** — `.build-stamp` read/write, source + lockfile hashing |
| `packages/gateway/src/app-runtime/build-orchestrator.ts` | **NEW** — install + build + cache + per-slug mutex + build log streaming |
| `packages/gateway/src/app-runtime/install-flow.ts` | **NEW** — trusted + verified install paths |
| `packages/gateway/src/app-runtime/port-pool.ts` | **NEW** — 40000-49999 allocation/release |
| `packages/gateway/src/app-runtime/safe-env.ts` | **NEW** — env whitelist for child processes |
| `packages/gateway/src/app-runtime/process-manager.ts` | **NEW** — ProcessRecord, spawn, health check, idle shutdown, crash retry, LRU eviction, startupPromise dedup |
| `packages/gateway/src/app-runtime/dispatcher.ts` | **NEW** — single Hono handler for `/apps/{slug}/*` that dispatches to static-file, vite-dist, or reverse-proxy branches based on manifest `runtime`; handles HTTP + WebSocket upgrades |
| `packages/gateway/src/app-runtime/serve-static.ts` | **NEW** — thin wrapper reusing `server.ts` file-serving helpers, scoped via `resolveWithinHome` |
| `packages/gateway/src/app-runtime/app-session.ts` | **NEW** — HMAC signer/verifier, HKDF key derivation, `buildSetCookie` with `Path=/apps/{slug}/` |
| `packages/gateway/src/app-runtime/app-session-middleware.ts` | **NEW** — Hono middleware on `/apps/:slug/*` verifying the signed cookie |
| `packages/gateway/src/app-runtime/distribution-policy.ts` | **NEW** — `computeDistributionStatus(listingTrust, sandboxCapabilities())` |
| `packages/gateway/src/app-runtime/runtime-state.ts` | **NEW** — maps build-stamp + process-record state to the manifest API envelope |
| `packages/gateway/src/app-runtime/errors.ts` | **NEW** — typed errors (BuildError, SpawnError, HealthCheckError, ProxyError, ManifestError) |
| `packages/gateway/src/app-runtime/index.ts` | **NEW** — public API exports + gateway integration |
| `packages/gateway/src/server.ts` | **MODIFY** — mount manifest API + app-session middleware + app-runtime dispatcher; graceful shutdown hook |
| `shell/src/lib/app-manifest-cache.ts` | **NEW** — client-side 60s TTL cache |
| `shell/src/components/AppViewer.tsx` | **MODIFY** — three-mode iframe src decision |
| `home/apps/_template-vite/` | **NEW** — Vite React scaffold (package.json, vite.config.ts, src/, matrix.json, index.html, tsconfig.json, src/matrix-os.d.ts) |
| `home/apps/_template-next/` | **NEW** — Next.js scaffold with generated next.config wrapper |
| `home/agents/skills/build-vite-app.md` | **NEW** — AI skill |
| `home/agents/skills/build-next-app.md` | **NEW** — AI skill |
| `home/agents/skills/pick-app-runtime.md` | **NEW** — AI decision tree |
| `tests/fixtures/apps/hello-vite/` | **NEW** — minimal Vite fixture |
| `tests/fixtures/apps/hello-next/` | **NEW** — minimal Next.js fixture |
| `tests/fixtures/apps/crash-on-request/` | **NEW** — fixture that crashes on first request |
| `tests/gateway/app-runtime/manifest-schema.test.ts` | **NEW** |
| `tests/gateway/app-runtime/build-cache.test.ts` | **NEW** |
| `tests/gateway/app-runtime/build-orchestrator.test.ts` | **NEW** |
| `tests/gateway/app-runtime/install-flow.test.ts` | **NEW** |
| `tests/gateway/app-runtime/port-pool.test.ts` | **NEW** |
| `tests/gateway/app-runtime/safe-env.test.ts` | **NEW** |
| `tests/gateway/app-runtime/process-manager.test.ts` | **NEW** |
| `tests/gateway/app-runtime/dispatcher.test.ts` | **NEW** — static / vite / node branches + header sanitization |
| `tests/gateway/app-runtime/app-session.test.ts` | **NEW** — signer/verifier round-trip, version rejection, expiry |
| `tests/gateway/app-runtime/app-session-middleware.test.ts` | **NEW** — cookie path assertion, cross-slug rejection, ack token flow |
| `tests/gateway/app-runtime/distribution-policy.test.ts` | **NEW** — trust-tier policy table |
| `tests/gateway/app-runtime-phase1.test.ts` | **NEW** — end-to-end static + vite |
| `tests/gateway/app-runtime-phase2.test.ts` | **NEW** — end-to-end node spawn + proxy |
| `tests/shell/app-manifest-cache.test.ts` | **NEW** |
| `tests/shell/app-viewer-runtime-modes.test.ts` | **NEW** |

---

## Phase 1 — Static + Vite Runtime

### Task 1: Manifest Schema

**Files:**
- Create: `packages/gateway/src/app-runtime/manifest-schema.ts`
- Create: `tests/gateway/app-runtime/manifest-schema.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/gateway/app-runtime/manifest-schema.test.ts
import { describe, it, expect } from "vitest";
import { AppManifestSchema, parseManifest, type AppManifest } from "../../../packages/gateway/src/app-runtime/manifest-schema.js";

describe("AppManifestSchema", () => {
  it("parses a valid static app manifest", () => {
    const input = {
      name: "Calculator",
      slug: "calculator",
      version: "1.0.0",
      runtime: "static",
      runtimeVersion: "^1.0.0",
    };
    const result = AppManifestSchema.parse(input);
    expect(result.runtime).toBe("static");
    expect(result.scope).toBe("personal"); // default
  });

  it("parses a valid vite app manifest with build section", () => {
    const input = {
      name: "Notes",
      slug: "notes",
      version: "2.0.0",
      runtime: "vite",
      runtimeVersion: "^1.0.0",
      build: {
        install: "pnpm install --frozen-lockfile",
        command: "pnpm build",
        output: "dist",
        timeout: 120,
      },
    };
    const result = AppManifestSchema.parse(input);
    expect(result.runtime).toBe("vite");
    expect(result.build?.timeout).toBe(120);
  });

  it("parses a valid node app manifest with serve section", () => {
    const input = {
      name: "Mail",
      slug: "mail",
      version: "1.0.0",
      runtime: "node",
      runtimeVersion: "^1.0.0",
      build: { command: "pnpm build", output: ".next" },
      serve: {
        start: "pnpm start",
        healthCheck: "/api/health",
        startTimeout: 10,
        idleShutdown: 300,
      },
    };
    const result = AppManifestSchema.parse(input);
    expect(result.serve?.healthCheck).toBe("/api/health");
  });

  it("rejects vite manifest without build section", () => {
    const input = { name: "X", slug: "x", version: "1.0.0", runtime: "vite", runtimeVersion: "^1.0.0" };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("rejects node manifest without serve section", () => {
    const input = {
      name: "X",
      slug: "x",
      version: "1.0.0",
      runtime: "node",
      runtimeVersion: "^1.0.0",
      build: { command: "pnpm build", output: "dist" },
    };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("rejects slug with invalid characters", () => {
    const input = { name: "X", slug: "../../etc/passwd", version: "1.0.0", runtime: "static", runtimeVersion: "^1.0.0" };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("rejects invalid semver runtimeVersion", () => {
    const input = { name: "X", slug: "x", version: "1.0.0", runtime: "static", runtimeVersion: "not-a-semver" };
    expect(() => AppManifestSchema.parse(input)).toThrow();
  });

  it("applies default resource limits when omitted", () => {
    const input = { name: "X", slug: "x", version: "1.0.0", runtime: "static", runtimeVersion: "^1.0.0" };
    const result = AppManifestSchema.parse(input);
    expect(result.resources).toEqual({ memoryMb: 256, cpuShares: 512, maxFileHandles: 128 });
  });

  it("parseManifest wraps Zod errors in typed ManifestError", async () => {
    const result = await parseManifest({ name: "X" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_manifest");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `bun run test -- tests/gateway/app-runtime/manifest-schema.test.ts` (expect red)

- [ ] **Step 3: Implement schema**

```typescript
// packages/gateway/src/app-runtime/manifest-schema.ts
import { z } from "zod/v4";
import { ManifestError } from "./errors.js";

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER_RANGE = /^[\^~]?\d+\.\d+\.\d+$|^\d+\.\d+\.\d+$/;

const RuntimeEnum = z.enum(["static", "vite", "node"]);

const BuildSchema = z.object({
  install: z.string().default("pnpm install --frozen-lockfile"),
  command: z.string(),
  output: z.string(),
  timeout: z.number().int().positive().default(120),
  sourceGlobs: z.array(z.string()).default(["src/**", "public/**", "*.config.*", "index.html", "matrix.json"]),
});

const ServeSchema = z.object({
  start: z.string(),
  healthCheck: z.string().default("/"),
  startTimeout: z.number().int().positive().default(10),
  idleShutdown: z.number().int().positive().default(300),
});

const ResourcesSchema = z.object({
  memoryMb: z.number().int().positive().default(256),
  cpuShares: z.number().int().positive().default(512),
  maxFileHandles: z.number().int().positive().default(128),
}).default({ memoryMb: 256, cpuShares: 512, maxFileHandles: 128 });

export const AppManifestSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(SAFE_SLUG, "slug must match ^[a-z0-9][a-z0-9-]{0,63}$"),
  description: z.string().optional(),
  category: z.string().optional(),
  icon: z.string().optional(),
  author: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  runtime: RuntimeEnum,
  runtimeVersion: z.string().regex(SEMVER_RANGE, "runtimeVersion must be semver range"),
  scope: z.enum(["personal", "shared"]).default("personal"),
  build: BuildSchema.optional(),
  serve: ServeSchema.optional(),
  resources: ResourcesSchema,
  permissions: z.array(z.string()).default([]),
  storage: z.unknown().optional(),
}).refine(
  (m) => m.runtime === "static" || m.build !== undefined,
  { message: "runtime 'vite' and 'node' require 'build' section", path: ["build"] }
).refine(
  (m) => m.runtime !== "node" || m.serve !== undefined,
  { message: "runtime 'node' requires 'serve' section", path: ["serve"] }
);

export type AppManifest = z.infer<typeof AppManifestSchema>;

export type ParseResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; error: ManifestError };

export async function parseManifest(input: unknown): Promise<ParseResult> {
  try {
    const manifest = AppManifestSchema.parse(input);
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, error: new ManifestError("invalid_manifest", String(err)) };
  }
}
```

- [ ] **Step 4: Create typed errors module**

```typescript
// packages/gateway/src/app-runtime/errors.ts
export class ManifestError extends Error {
  constructor(public code: "invalid_manifest" | "runtime_version_mismatch" | "not_found", message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export class BuildError extends Error {
  constructor(
    public code: "install_failed" | "build_failed" | "timeout" | "lockfile_tampered" | "disk_full",
    public stage: "install" | "build" | "prepare",
    public exitCode: number | null,
    public stderrTail: string,
  ) {
    super(`${code} during ${stage} (exit ${exitCode}): ${stderrTail.slice(-200)}`);
    this.name = "BuildError";
  }
}

export class SpawnError extends Error {
  constructor(public code: "spawn_failed" | "startup_timeout" | "health_check_failed" | "port_exhausted", message: string) {
    super(message);
    this.name = "SpawnError";
  }
}

export class HealthCheckError extends Error {
  constructor(public status: number | null, message: string) {
    super(message);
    this.name = "HealthCheckError";
  }
}

export class ProxyError extends Error {
  constructor(
    public code: "backend_timeout" | "backend_unreachable" | "backend_5xx" | "upstream_closed",
    public correlationId: string,
    message: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}
```

- [ ] **Step 5: Run tests, confirm green**

- [ ] **Step 6: Commit**

```
git add packages/gateway/src/app-runtime/manifest-schema.ts \
        packages/gateway/src/app-runtime/errors.ts \
        tests/gateway/app-runtime/manifest-schema.test.ts
git commit -m "feat(gateway): add matrix.json runtime schema + typed errors"
```

---

### Task 2: Manifest Loader

**Files:**
- Create: `packages/gateway/src/app-runtime/manifest-loader.ts`
- Extend: `tests/gateway/app-runtime/manifest-schema.test.ts` or new file

- [ ] **Step 1: Write failing tests**

```typescript
// tests/gateway/app-runtime/manifest-loader.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, invalidateManifestCache } from "../../../packages/gateway/src/app-runtime/manifest-loader.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-manifest-"));
  invalidateManifestCache();
});

describe("loadManifest", () => {
  it("loads and validates matrix.json", async () => {
    const appDir = join(tmpDir, "notes");
    await rm(appDir, { recursive: true, force: true });
    await writeFile(join(appDir, "matrix.json"), JSON.stringify({
      name: "Notes", slug: "notes", version: "1.0.0",
      runtime: "vite", runtimeVersion: "^1.0.0",
      build: { command: "pnpm build", output: "dist" },
    }), { flag: "wx" });
    // ...
  });

  it("returns ManifestError on missing file", async () => { /* ... */ });
  it("returns ManifestError on invalid JSON", async () => { /* ... */ });
  it("rejects slug mismatch between dir name and manifest.slug", async () => { /* ... */ });
  it("caches by mtime and re-reads on change", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run tests, confirm red**

- [ ] **Step 3: Implement loader with mtime cache**

Key points:
- Uses `resolveWithinHome()` before reading (CLAUDE.md path-safety rule)
- Caches `Map<slug, { mtime, manifest }>` with explicit invalidation
- Returns `Result<AppManifest, ManifestError>` pattern (no throws)
- Verifies `manifest.slug === dirname(path)` to prevent slug spoofing

- [ ] **Step 4: Run tests, confirm green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add manifest loader with mtime cache"
```

---

### Task 3: Build Cache (hash + stamp)

**Files:**
- Create: `packages/gateway/src/app-runtime/build-cache.ts`
- Create: `tests/gateway/app-runtime/build-cache.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/gateway/app-runtime/build-cache.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashSources,
  hashLockfile,
  readBuildStamp,
  writeBuildStamp,
  isBuildStale,
} from "../../../packages/gateway/src/app-runtime/build-cache.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-build-cache-"));
});

describe("build-cache", () => {
  it("hashSources produces deterministic output for same file set", async () => {
    await writeFile(join(tmpDir, "a.ts"), "const a = 1;");
    await writeFile(join(tmpDir, "b.ts"), "const b = 2;");
    const h1 = await hashSources(tmpDir, ["*.ts"]);
    const h2 = await hashSources(tmpDir, ["*.ts"]);
    expect(h1).toBe(h2);
  });

  it("hashSources changes when file content changes", async () => {
    await writeFile(join(tmpDir, "a.ts"), "const a = 1;");
    const h1 = await hashSources(tmpDir, ["*.ts"]);
    await writeFile(join(tmpDir, "a.ts"), "const a = 2;");
    const h2 = await hashSources(tmpDir, ["*.ts"]);
    expect(h1).not.toBe(h2);
  });

  it("isBuildStale returns true when stamp missing", async () => {
    expect(await isBuildStale(tmpDir, ["src/**"])).toBe(true);
  });

  it("isBuildStale returns false after writeBuildStamp with matching hashes", async () => {
    await writeFile(join(tmpDir, "src.ts"), "x");
    await writeBuildStamp(tmpDir, {
      sourceHash: await hashSources(tmpDir, ["*.ts"]),
      lockfileHash: "abc",
      builtAt: Date.now(),
      exitCode: 0,
    });
    // create pnpm-lock.yaml to satisfy lockfile check
    await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
    expect(await isBuildStale(tmpDir, ["*.ts"])).toBe(false);
  });

  it("isBuildStale returns true when lockfile changes", async () => { /* ... */ });
  it("isBuildStale returns true when source file mtime advances", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run tests, confirm red**

- [ ] **Step 3: Implement `build-cache.ts`**

Uses `node:crypto` createHash('sha256'), reads files via glob pattern, sorts paths for determinism, writes stamp as JSON at `.build-stamp`. Lockfile hash is computed separately and compared to stamp.lockfileHash.

- [ ] **Step 4: Run tests, confirm green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add build cache with source + lockfile hashing"
```

---

### Task 4: Build Orchestrator

**Files:**
- Create: `packages/gateway/src/app-runtime/build-orchestrator.ts`
- Create: `tests/gateway/app-runtime/build-orchestrator.test.ts`
- Create fixture: `tests/fixtures/apps/hello-vite/` (minimal Vite template committed as-is, pre-built `dist/` NOT included)

- [ ] **Step 1: Write failing tests**

```typescript
// tests/gateway/app-runtime/build-orchestrator.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildOrchestrator } from "../../../packages/gateway/src/app-runtime/build-orchestrator.js";
import { BuildError } from "../../../packages/gateway/src/app-runtime/errors.js";

let tmpDir: string;
let appDir: string;
let orch: BuildOrchestrator;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-build-orch-"));
  appDir = join(tmpDir, "hello-vite");
  await cp("tests/fixtures/apps/hello-vite", appDir, { recursive: true });
  orch = new BuildOrchestrator({ concurrency: 2, storeDir: join(tmpDir, ".pnpm-store") });
});

describe("BuildOrchestrator", () => {
  it("builds a fresh app from scratch", async () => {
    const result = await orch.build("hello-vite", appDir);
    expect(result.ok).toBe(true);
    // dist/ should exist
    const html = await readFile(join(appDir, "dist", "index.html"), "utf8");
    expect(html).toContain("<html");
  }, 120_000);

  it("skips rebuild when cache is warm", async () => {
    await orch.build("hello-vite", appDir);
    const start = Date.now();
    const result = await orch.build("hello-vite", appDir);
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(500); // cache hit, no pnpm invocation
  }, 120_000);

  it("rebuilds when source changes", async () => {
    await orch.build("hello-vite", appDir);
    await writeFile(join(appDir, "src", "App.tsx"), "export default () => <div>changed</div>");
    const result = await orch.build("hello-vite", appDir);
    expect(result.ok).toBe(true);
    const html = await readFile(join(appDir, "dist", "assets", await firstJsAsset(appDir)), "utf8");
    expect(html).toContain("changed");
  }, 120_000);

  it("returns BuildError on install failure", async () => {
    // corrupt package.json
    await writeFile(join(appDir, "package.json"), "{ not valid json");
    const result = await orch.build("hello-vite", appDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(BuildError);
  }, 60_000);

  it("enforces build timeout via AbortSignal", async () => {
    // override timeout to 100ms
    const result = await orch.build("hello-vite", appDir, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as BuildError).code).toBe("timeout");
  }, 30_000);

  it("serializes concurrent builds for same slug", async () => {
    const [r1, r2, r3] = await Promise.all([
      orch.build("hello-vite", appDir),
      orch.build("hello-vite", appDir),
      orch.build("hello-vite", appDir),
    ]);
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    // mutex: only one actual build should have run (inspect build log)
  }, 180_000);

  it("writes build log to .build.log capped at 10MB", async () => {
    await orch.build("hello-vite", appDir);
    const log = await readFile(join(appDir, ".build.log"), "utf8");
    expect(log.length).toBeGreaterThan(0);
  }, 120_000);
});
```

- [ ] **Step 2: Create minimal `tests/fixtures/apps/hello-vite/`** — bare Vite React TS template with pinned versions in pnpm-lock.yaml

- [ ] **Step 3: Run tests, confirm red**

- [ ] **Step 4: Implement `BuildOrchestrator`**

Key logic:
- Per-slug Mutex map (`Map<slug, Promise<BuildResult>>`)
- Concurrent build semaphore (N=4 across different slugs)
- Calls manifest loader, inspects `build.*` fields
- `pnpm install --frozen-lockfile` when lockfile changed
- `pnpm build` when source changed
- `spawn` with `{ timeout: AbortSignal.timeout(ms), stdio: ['ignore', 'pipe', 'pipe'] }`
- Streams stdout+stderr to `~/apps/{slug}/.build.log`, truncated when >10MB
- On success: calls `writeBuildStamp()` with new hashes + exit code 0
- On failure: returns `{ ok: false, error: new BuildError(...) }` — does NOT throw

- [ ] **Step 5: Run tests, confirm green**

- [ ] **Step 6: Commit**

```
git commit -m "feat(gateway): add build orchestrator (install + build + cache)"
```

---

### Task 5: Install Flow (Trusted Path Only for Phase 1)

**Files:**
- Create: `packages/gateway/src/app-runtime/install-flow.ts`
- Create: `tests/gateway/app-runtime/install-flow.test.ts`

- [ ] **Step 1: Write failing tests** for `installApp(sourceDir, targetDir)` covering:
  - Extract source from a tarball fixture, validate manifest, trigger build, register in catalog
  - Reject when manifest slug ≠ directory name
  - Reject when `runtimeVersion` incompatible with current runtime version constant
  - Cleanup partial install on failure (use `{ flag: 'wx' }` for atomicity per CLAUDE.md)
  - Idempotent re-run (reinstall over existing dir)

- [ ] **Step 2: Run red**

- [ ] **Step 3: Implement `installApp()`**

For Phase 1, only the "trusted path" is implemented — extract source, verify manifest, run build via BuildOrchestrator. Verified path (Phase 3) is stubbed with `throw new Error("verified install — phase 3")`.

Uses:
- `resolveWithinHome()` on all paths
- `mkdir({ recursive: true })` + `writeFile({ flag: 'wx' })` for atomic extract
- Rollback: on any error, `rm(targetDir, { recursive: true, force: true })` if we created it fresh

- [ ] **Step 4: Run green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add install flow trusted path"
```

---

### Task 6: Manifest API + Shell Cache

**Files:**
- Modify: `packages/gateway/src/server.ts` — add `GET /api/apps/:slug/manifest` route
- Create: `shell/src/lib/app-manifest-cache.ts`
- Create: `tests/shell/app-manifest-cache.test.ts`
- Create: `tests/gateway/app-manifest-api.test.ts`

**Response envelope (matches spec §Shell Changes "Failure display" and §Authorization):**

```typescript
type ManifestResponse = {
  manifest: AppManifest;                                        // parsed matrix.json (no distributionStatus)
  runtimeState:
    | { status: "ready" }                                       // static/vite: dist exists and is fresh
    | { status: "needs_build" }                                 // vite/node: source present, no .build-stamp yet
    | { status: "build_failed"; stage: "install" | "build"; exitCode: number; stderrTail: string }
    | { status: "process_idle" }                                // node: manifest ok, process not spawned yet
    | { status: "process_failed"; lastError: { code: string; stderrTail: string }; restartCount: number };
  distributionStatus: "installable" | "gated" | "blocked";      // computed server-side on every read
};
```

Shell reads `runtimeState` to decide between rendering the iframe and rendering an error card, and reads `distributionStatus` to decide whether to show the ack UI. The gateway composes `runtimeState` from `buildCache.readStamp(slug)` and `processManager.inspect(slug)`, and computes `distributionStatus` from `computeDistributionStatus(manifest.listingTrust, sandboxCapabilities())` — **never** reads it from the stored manifest.

**Manifest schema invariant:** `packages/gateway/src/app-runtime/manifest-schema.ts` MUST reject a `distributionStatus` field if present in the input file (Zod `z.strictObject(...).refine(m => !("distributionStatus" in m), ...)`). A malicious publisher setting `distributionStatus: "installable"` in their own `matrix.json` must fail install with `ManifestError.code = "computed_field_not_authored"`.

- [ ] **Step 1: Write failing tests**

Gateway side:
- `GET /api/apps/notes/manifest` → 200 with `{ manifest, runtimeState: { status: "ready" }, distributionStatus: "installable" }` when `dist/` is fresh and app is `listingTrust: "first_party"`
- `GET /api/apps/notes/manifest` → 200 with `runtimeState.status = "needs_build"` when `.build-stamp` is missing
- `GET /api/apps/notes/manifest` → 200 with `runtimeState.status = "build_failed"` when the last build stamp records a failure
- `GET /api/apps/hello-next/manifest` → 200 with `runtimeState.status = "process_failed"` when the process manager has a failed record
- `GET /api/apps/community-app/manifest` → 200 with `distributionStatus: "blocked"` when the app has `listingTrust: "community"` and `ALLOW_COMMUNITY_INSTALLS` is unset (production default — no ack UI must be shown)
- `GET /api/apps/community-app/manifest` → 200 with `distributionStatus: "gated"` when `ALLOW_COMMUNITY_INSTALLS=1` and sandbox capabilities absent (ack unlocks)
- `GET /api/apps/community-app/manifest` → 200 with `distributionStatus: "installable"` when the simulated sandbox capability flag is set (future-proofing for spec 025)
- `GET /api/apps/bad-manifest/manifest` → 500 with `ManifestError.code = "computed_field_not_authored"` when the on-disk `matrix.json` tries to set `distributionStatus`
- `GET /api/apps/missing/manifest` → 404
- `GET /api/apps/../etc/passwd/manifest` → 400 (slug regex rejects)
- Does not leak filesystem errors (generic 500 with correlation id)
- `stderrTail` is capped at 2 KB and stripped of any bearer token substrings

Shell side:
- `fetchAppManifest("notes")` returns `{ manifest, runtimeState }` on first call and caches the envelope
- `fetchAppManifest("notes")` re-fetches after 60s TTL expires
- `fetchAppManifest("notes")` re-fetches immediately when `runtimeState.status !== "ready"` (so the UI recovers after a retry-build) — implemented as a short (2s) TTL on non-ready envelopes
- Cache is LRU-capped at 32 entries
- `invalidateManifest("notes")` forces re-fetch

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement gateway route**

```typescript
// in server.ts, mounted at /api/apps/:slug/manifest
app.get("/api/apps/:slug/manifest", async (c) => {
  const slug = c.req.param("slug");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    return c.json({ error: "invalid slug" }, 400);
  }
  const appDir = resolveWithinHome(`apps/${slug}`);
  const result = await loadManifest(appDir);   // Zod rejects distributionStatus if present in file
  if (!result.ok) {
    if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
    c.get("logger").error({ error: result.error }, "manifest load failed");
    return c.json({ error: "internal", correlationId: c.get("requestId") }, 500);
  }
  const runtimeState = await computeRuntimeState(result.manifest, {
    buildCache,
    processManager,
  });
  const distributionStatus = computeDistributionStatus(
    result.manifest.listingTrust,
    sandboxCapabilities(),   // reads env flags, future: reads spec 025 enforcement hooks
  );
  return c.json({ manifest: result.manifest, runtimeState, distributionStatus });
});
```

`computeRuntimeState` lives in `packages/gateway/src/app-runtime/runtime-state.ts` (new file). `computeDistributionStatus` lives in `packages/gateway/src/app-runtime/distribution-policy.ts` (new file). Both are single-source helpers so the shell never has to re-derive anything, and the distribution policy is the one place to patch when spec 025 lands.

- [ ] **Step 4: Implement `app-manifest-cache.ts`**

Simple Map + LRU + TTL. Entry shape: `{ manifest, expiresAt }`. Max size 32.

- [ ] **Step 5: Run green**

- [ ] **Step 6: Commit**

```
git commit -m "feat(gateway,shell): add manifest api + client cache"
```

---

### Task 7: AppViewer Runtime Mode Switch

**Files:**
- Modify: `shell/src/components/AppViewer.tsx`
- Create: `tests/shell/app-viewer-runtime-modes.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/shell/app-viewer-runtime-modes.test.ts
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { AppViewer } from "../../shell/src/components/AppViewer.js";

vi.mock("../../shell/src/lib/app-manifest-cache.js", () => ({
  fetchAppManifest: vi.fn(),
}));
vi.mock("../../shell/src/lib/app-session.js", () => ({
  openAppSession: vi.fn(),
}));

describe("AppViewer unified /apps/:slug/ navigation", () => {
  it("uses /apps/{slug}/ for static runtime", async () => {
    vi.mocked(fetchAppManifest).mockResolvedValue({
      manifest: { slug: "calculator", runtime: "static", /* ... */ },
      runtimeState: { status: "ready" },
      distributionStatus: "installable",
    });
    vi.mocked(openAppSession).mockResolvedValue({ expiresAt: Date.now() + 600_000 });
    const { container } = render(<AppViewer slug="calculator" />);
    await waitFor(() => {
      const iframe = container.querySelector("iframe");
      expect(iframe?.src).toMatch(/\/apps\/calculator\/$/);
    });
    expect(openAppSession).toHaveBeenCalledWith("calculator");
  });

  it("uses the SAME /apps/{slug}/ for vite runtime — no /files/apps/ path", async () => {
    // assert iframe.src === `/apps/${slug}/` and does NOT contain "/files/apps/"
  });
  it("uses the SAME /apps/{slug}/ for node runtime", async () => { /* ... */ });
  it("does NOT call openAppSession before the iframe src is assigned — ordering is session-then-src", async () => { /* ... */ });
  it("renders ack UI instead of iframe when distributionStatus === 'gated'", async () => { /* ... */ });
  it("renders read-only card when distributionStatus === 'blocked' and never calls openAppSession", async () => { /* ... */ });
  it("renders error card when manifest load fails", async () => { /* ... */ });
  it("renders build-failed card when runtimeState.status === 'build_failed'", async () => { /* ... */ });
  it("refreshes session and reloads iframe on matrix-os:session-expired postMessage from the interstitial", async () => {
    // Simulate: iframe navigation got the gateway's 401 interstitial, which posts to window.parent.
    // Send the message on the window where AppViewer is mounted and assert the recovery path runs.
    vi.mocked(openAppSession)
      .mockResolvedValueOnce({ expiresAt: Date.now() + 600_000 })  // initial mount
      .mockResolvedValueOnce({ expiresAt: Date.now() + 600_000 }); // refresh after expiry

    const { container, rerender } = render(<AppViewer slug="notes" />);
    await waitFor(() => {
      expect(container.querySelector("iframe")?.src).toMatch(/\/apps\/notes\/$/);
    });

    const iframe = container.querySelector("iframe")!;
    // Dispatch a message that SHOULD trigger the refresh path
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "matrix-os:session-expired", slug: "notes" },
      origin: window.location.origin,
      source: iframe.contentWindow,
    }));

    await waitFor(() => {
      expect(openAppSession).toHaveBeenCalledTimes(2);
    });
  });

  it("ignores matrix-os:session-expired from a different event.source (spoofing defense)", async () => {
    // Dispatch a message with event.source = some other window
    // Assert openAppSession was NOT called a second time
  });

  it("ignores matrix-os:session-expired from a different event.origin", async () => { /* ... */ });

  it("ignores matrix-os:session-expired naming a different slug than this viewer owns", async () => { /* ... */ });

  it("debounces two session-expired messages within 2 seconds — openAppSession called exactly once", async () => {
    vi.useFakeTimers();
    // dispatch twice within 500ms, advance time, assert single refresh
    vi.useRealTimers();
  });

  it("does NOT observe iframe.onload as a failure probe (the only refresh signal is postMessage)", () => {
    // ensure there is no onload-based refresh path; this is a code-review test
  });
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Modify `AppViewer.tsx`**

Replace the hard-coded `/files/${path}` src with:

```typescript
// --- mount ---
const { manifest, runtimeState, distributionStatus } = await fetchAppManifest(slug);
if (distributionStatus === "blocked") return <BlockedCard manifest={manifest} />;
if (distributionStatus === "gated") {
  const ack = await showAckDialog({ slug, listingTrust: manifest.listingTrust, permissions: manifest.permissions });
  if (!ack) return <DismissedCard />;
  await openAppSession(slug, { ack });
} else {
  await openAppSession(slug);
}
if (runtimeState.status === "build_failed") return <BuildFailedCard ... />;
if (runtimeState.status === "process_failed") return <ProcessFailedCard ... />;
if (runtimeState.status === "needs_build") return <NeedsBuildCard onBuild={...} />;
iframe.src = `/apps/${slug}/`;   // SAME shape for static, vite, node

// --- session refresh on expiry (the only recovery signal is postMessage) ---
let refreshInFlight = false;
let lastRefreshAt = 0;
useEffect(() => {
  const handler = async (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (event.source !== iframeRef.current?.contentWindow) return;
    if (event.data?.type !== "matrix-os:session-expired") return;
    if (event.data?.slug !== slug) return;
    if (refreshInFlight) return;
    if (Date.now() - lastRefreshAt < 2000) return;  // debounce duplicates
    refreshInFlight = true;
    try {
      await openAppSession(slug);
      lastRefreshAt = Date.now();
      // Reassign to same URL to trigger the browser to reload the iframe with the new cookie
      iframeRef.current!.src = `/apps/${slug}/`;
    } finally {
      refreshInFlight = false;
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}, [slug]);
```

Keep bridge script injection unchanged — it applies to all three modes since they all run same-origin under the same `/apps/{slug}/` path. No mode-specific URL construction anywhere in AppViewer. **Do not add an `iframe.onload` observer** for session expiry — onload fires on the 401 HTML body too, so it is not a reliable failure probe. The postMessage from the gateway's interstitial is the only recovery signal.

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(shell): AppViewer supports static and vite runtime modes"
```

---

### Task 8: Vite Template `_template-vite/`

**Files:**
- Create: `home/apps/_template-vite/package.json`
- Create: `home/apps/_template-vite/vite.config.ts`
- Create: `home/apps/_template-vite/tsconfig.json`
- Create: `home/apps/_template-vite/index.html`
- Create: `home/apps/_template-vite/src/main.tsx`
- Create: `home/apps/_template-vite/src/App.tsx`
- Create: `home/apps/_template-vite/src/matrix-os.d.ts`
- Create: `home/apps/_template-vite/matrix.json`
- Create: `tests/gateway/template-builds.test.ts`

- [ ] **Step 1: Write failing fixture build test** — copies `_template-vite` to tmp dir, runs BuildOrchestrator, asserts `dist/index.html` exists with expected content

- [ ] **Step 2: Red**

- [ ] **Step 3: Write the template files**

Key points:
- `matrix.json`: `{ runtime: "vite", runtimeVersion: "^1.0.0", build: { command: "pnpm build", output: "dist" } }`
- `vite.config.ts`: `base: './'` so asset URLs are relative (works regardless of mount path)
- React 19 + TypeScript strict
- Pinned `pnpm-lock.yaml` so first build is fast
- `src/matrix-os.d.ts` declares typed `window.MatrixOS` surface matching the existing bridge
- Minimal `App.tsx` renders "Hello from Matrix OS" with theme CSS vars

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(apps): add Vite React template for app authoring"
```

---

### Task 8b: App Session Middleware + POST /api/apps/:slug/session

**Why this task exists:** the app-runtime dispatcher (Task 17) is the single handler for `/apps/:slug/*` across all runtime modes, and it depends on the signed-cookie verifier. Shipping the verifier here, before Task 9/10, means Phase 1 integration tests can exercise the full cookie path on static + vite apps before Phase 2 lands the node reverse-proxy branch.

**Files:**
- Create: `packages/gateway/src/app-runtime/app-session.ts` — HMAC signer + verifier, Zod schema for payload v1, HKDF key derivation from gateway token
- Create: `packages/gateway/src/app-runtime/app-session-middleware.ts` — Hono middleware that parses the `matrix_app_session__{slug}` cookie, verifies HMAC + version + slug match + expiry + scope, injects `c.set("appSession", verified)` on success, or on failure returns **one of two** 401 shapes via content negotiation on `Accept`: (a) HTML interstitial for navigation requests (see spec §Authorization "401 interstitial"), (b) JSON `401` with `Matrix-Session-Refresh` header for XHR/fetch requests. The HTML body is loaded from a fixed constant at module load time — no per-request templating, no slug interpolation into HTML — so the body is byte-identical across slugs.
- Create: `packages/gateway/src/app-runtime/session-interstitial.html` — the exact static HTML served on 401 navigation responses. Byte-for-byte identical every time. Checked in as a fixture and loaded at module init.
- Create: `packages/gateway/src/app-runtime/distribution-policy.ts` — pure `computeDistributionStatus(listingTrust, caps)` (no side effects, no env reads), plus a separate `sandboxCapabilities()` helper that reads `ALLOW_COMMUNITY_INSTALLS` env and the (stubbed, false in this spec) spec-025 `sandboxEnforced` flag and returns a `{ sandboxEnforced, allowCommunityInstalls }` object. Every caller (manifest API, session endpoint, install endpoint) invokes both helpers; the policy function is the single source of truth so they can never drift.
- Modify: `packages/gateway/src/server.ts` — register `POST /api/apps/:slug/session` (uses `authMiddleware`) and mount `appSessionMiddleware` before the `/apps/:slug/*` dispatcher
- Modify: `packages/gateway/src/auth.ts` — add `APP_IFRAME_PREFIXES = ["/apps/"]` that `authMiddleware` delegates to `appSessionMiddleware` instead of requiring bearer auth. **Single prefix** — no `/files/apps/` entry, because this spec unifies runtime access under `/apps/:slug/*` (see spec §Architecture Overview).
- Create: `tests/gateway/app-runtime/app-session.test.ts`
- Create: `tests/gateway/app-runtime/app-session-middleware.test.ts`
- Create: `tests/gateway/app-runtime/distribution-policy.test.ts`
- Modify: `shell/src/components/AppViewer.tsx` (Task 7 code path) — before setting iframe src, `await openAppSession(slug, { ack? })` which calls `POST /api/apps/:slug/session`; install a `window.addEventListener("message", ...)` that listens for `{ type: "matrix-os:session-expired", slug }` posted by the gateway's 401 HTML interstitial, verifies `event.origin === window.location.origin` and `event.source === iframeRef.current?.contentWindow` and `data.slug === this.slug`, debounces duplicate messages within 2s, calls `openAppSession(slug)`, then reassigns `iframe.src` to trigger reload. Remove the `iframe.onload` failure probe from earlier drafts — it is unreliable and the postMessage path is the only recovery signal.
- Create: `shell/src/lib/app-session.ts` — the `openAppSession` client wrapper

**Cookie payload (v1):**

```typescript
// packages/gateway/src/app-runtime/app-session.ts
import { z } from "zod/v4";

export const AppSessionPayload = z.object({
  v: z.literal(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  principal: z.literal("gateway-owner"), // spec 062 promotes this to a Matrix handle in v2
  scope: z.literal("personal"),          // spec 062 adds "shared" in v2
  expiresAt: z.number().int().positive(),
});
export type AppSessionPayload = z.infer<typeof AppSessionPayload>;

// HKDF-SHA256(gatewayToken, info="matrix-os/app-session/v1") -> Buffer
export function deriveAppSessionKey(gatewayToken: string): Buffer { /* ... */ }

export function signAppSession(payload: AppSessionPayload, key: Buffer): string { /* HMAC-SHA256 */ }
export function verifyAppSession(cookie: string, key: Buffer, now: number): AppSessionPayload | null { /* ... */ }

// Serializes the full Set-Cookie header with path scoping. Called by POST /api/apps/:slug/session.
export function buildSetCookie(slug: string, cookieValue: string, opts: { maxAge: number; secure: boolean }): string {
  return [
    `matrix_app_session__${slug}=${cookieValue}`,
    `Path=/apps/${slug}/`,                 // <-- path-scoped, NOT "/"
    "HttpOnly",
    "SameSite=Strict",
    opts.secure ? "Secure" : null,
    `Max-Age=${opts.maxAge}`,
  ].filter(Boolean).join("; ");
}
```

- [ ] **Step 1: Write failing tests**

```typescript
// app-session.test.ts
it("round-trips a v1 payload", () => { /* sign -> verify -> same payload */ });
it("rejects a tampered payload", () => { /* flip one byte in the signature */ });
it("rejects an expired payload", () => { /* now > expiresAt */ });
it("rejects unknown version", () => { /* v2 cookie in a v1-only verifier */ });
it("verify is constant-time", () => { /* exercise timingSafeEqual path */ });
```

```typescript
// app-session-middleware.test.ts
it("401 without cookie + Accept: text/html → HTML interstitial body with postMessage script", async () => {
  const res = await app.request("/apps/notes/", { headers: { Accept: "text/html" }});
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toContain("matrix-os:session-expired");
  expect(body).toContain("window.parent.postMessage");
  expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  expect(res.headers.get("matrix-session-refresh")).toBe("/api/apps/notes/session");
});
it("401 without cookie + Accept: application/json → JSON body with session_expired + refresh header", async () => { /* ... */ });
it("interstitial body is byte-identical across slugs (no server-side string interpolation)", async () => {
  const a = await (await app.request("/apps/notes/", { headers: { Accept: "text/html" }})).text();
  const b = await (await app.request("/apps/calendar/", { headers: { Accept: "text/html" }})).text();
  expect(a).toBe(b);
});
it("interstitial script only posts message when in an iframe (window.parent !== window)", async () => { /* load in jsdom top-level, expect silence */ });
it("interstitial script derives slug from location.pathname, not from server", async () => { /* ... */ });
it("401 without cookie + Accept: text/html → also includes Matrix-Session-Refresh header for test observability", async () => { /* ... */ });
it("401 when cookie signed for another slug", async () => { /* ... */ });
it("401 when cookie version is unknown (no silent downgrade)", async () => { /* ... */ });
it("401 when cookie expired", async () => { /* ... */ });
it("200 and populates c.get('appSession') when cookie valid", async () => { /* ... */ });
it("POST /api/apps/:slug/session returns 409 scope_mismatch for shared-scope app", async () => { /* ... */ });
it("POST /api/apps/:slug/session returns 409 install_gated for community-tier app without ack", async () => { /* ... */ });
it("POST /api/apps/:slug/session returns 403 install_blocked_by_policy for blocked app", async () => { /* ... */ });
it("POST /api/apps/:slug/session sets Path=/apps/{slug}/ (NOT Path=/)", async () => {
  const res = await app.request(`/api/apps/notes/session`, { method: "POST", headers: { Authorization: `Bearer ${token}` }});
  const cookieHeader = res.headers.get("set-cookie")!;
  expect(cookieHeader).toContain("Path=/apps/notes/");
  expect(cookieHeader).not.toContain("Path=/;");
  expect(cookieHeader).not.toContain("Path=/,");
  expect(cookieHeader).toContain("HttpOnly");
  expect(cookieHeader).toContain("SameSite=Strict");
});
it("POST /api/apps/:slug/session recomputes distributionStatus server-side and ignores any client hint", async () => {
  // send the POST with a body claiming {distributionStatus: "installable"} for a community app
  // assert server responds 409 install_gated anyway
});
it("cookie name embeds slug to allow multiple concurrent open apps", async () => { /* ... */ });
it("browser cookie jar: cookie for /apps/notes/ is NOT sent to /apps/calendar/ (path-scoping correctness)", async () => {
  // use tough-cookie (or manual Cookie header simulation) to verify path-scoping is enforced by the jar,
  // not just by our middleware
});
```

```typescript
// distribution-policy.test.ts
it("first_party -> installable (independent of env flags)", () => { /* ... */ });
it("verified_partner -> installable (independent of env flags)", () => { /* ... */ });
it("community + no flags (production default) -> blocked (no ack UI)", () => {
  expect(computeDistributionStatus("community", { sandboxEnforced: false, allowCommunityInstalls: false }))
    .toBe("blocked");
});
it("community + ALLOW_COMMUNITY_INSTALLS=1 -> gated (ack will unlock)", () => {
  expect(computeDistributionStatus("community", { sandboxEnforced: false, allowCommunityInstalls: true }))
    .toBe("gated");
});
it("community + sandboxEnforced -> installable (post-025 case, flag irrelevant)", () => {
  expect(computeDistributionStatus("community", { sandboxEnforced: true, allowCommunityInstalls: false }))
    .toBe("installable");
});
it("unknown listingTrust -> blocked (fail-closed default)", () => { /* ... */ });
it("is pure and deterministic (same inputs -> same output)", () => { /* property test */ });

// The contract invariant that ties it all together:
it("INVARIANT: every 'gated' result from the policy function must be unlockable by an ack at the session endpoint", () => {
  // For every (listingTrust, caps) combination that returns "gated", assert that
  // POST /api/apps/:slug/session with a valid ack token returns 200 (not 403/409).
  // This is the "no confirm UI that can't succeed" guarantee.
  for (const listingTrust of ALL_LISTING_TRUSTS) {
    for (const caps of ALL_CAPS_COMBINATIONS) {
      if (computeDistributionStatus(listingTrust, caps) === "gated") {
        // simulate the session endpoint with this env and a valid ack — must succeed
      }
    }
  }
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement**

Key points:
- Signing key is derived from the existing gateway token via `HKDF-SHA256(gatewayToken, "matrix-os/app-session/v1")` so we do not reuse the bearer token as a raw HMAC key
- `appSessionMiddleware` MUST run before the app-runtime dispatcher (Task 17). Mount order in `server.ts`: `authMiddleware` (which delegates to `appSessionMiddleware` for `/apps/*`) → `appSessionMiddleware` → `appRuntimeDispatcher`.
- `authMiddleware` in `auth.ts` recognizes `APP_IFRAME_PREFIXES = ["/apps/"]` and hands off to `appSessionMiddleware` instead of rejecting the request for missing `Authorization` header. **This is a single prefix** — `/files/apps/` is NOT in the list because iframe navigation never uses `/files/apps/` after this spec.
- On 401, the middleware picks between the HTML interstitial (navigation) and JSON (XHR) via `Accept` header content negotiation:
  ```typescript
  function sessionExpiredResponse(c, slug, correlationId) {
    const accept = c.req.header("accept") ?? "";
    const wantsHtml = accept.includes("text/html");
    const headers = {
      "WWW-Authenticate": "MatrixAppSession",
      "Matrix-Session-Refresh": `/api/apps/${slug}/session`,
      "Cache-Control": "no-store",
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'",
    };
    if (wantsHtml) {
      return new Response(SESSION_INTERSTITIAL_HTML, {
        status: 401,
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return c.json({ error: "session_expired", correlationId }, 401, headers);
  }
  ```
- `SESSION_INTERSTITIAL_HTML` is loaded once at module init from `session-interstitial.html`. No per-request string building — that is the byte-identical-body invariant.
- `session-interstitial.html` runs a fixed 6-line IIFE that reads `location.pathname`, matches `/^\/apps\/([a-z0-9][a-z0-9-]{0,63})\//`, and if in an iframe posts `{ type: "matrix-os:session-expired", slug: match[1] }` to `window.parent` with `targetOrigin = window.location.origin`. No slug interpolation from the server — the script derives it from the browser's own URL so the HTML body never varies.
- `POST /api/apps/:slug/session` is a normal bearer-authenticated route; it calls `loadManifest`, asserts `scope === "personal"`, **re-computes `distributionStatus` server-side** by calling the same `computeDistributionStatus(manifest.listingTrust, sandboxCapabilities())` used by the manifest API (never trusts a client-supplied value in the request body), signs a fresh payload, emits `Set-Cookie` via `buildSetCookie(slug, ...)` with `Path=/apps/{slug}/`, and returns `200 { expiresAt }`
- The `distributionStatus` gate runs inside this route: `installable` → issue cookie; `gated` → require valid `ack` in request body (and a valid ack MUST succeed — this is the invariant from §Trust tiers) OR return `409 install_gated`; `blocked` → return `403 install_blocked_by_policy` (race-defense; shell is expected to not render an ack UI for `blocked` apps, so this code path is hit only if the env flag flipped between manifest fetch and session POST)
- Ack tokens for gated installs are opaque, one-time, 5-minute TTL, stored in a bounded in-memory map (cap 32, LRU) keyed by slug. Issued by a separate `POST /api/apps/:slug/ack` route (documented in Task 8b step 3, tests in `app-session-middleware.test.ts`)

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add app-session cookie middleware for iframe auth"
```

**Locked-in design decisions (from the confirmed auth call):**
- Per-slug HMAC-signed cookie. `AppSessionPayload` is the v1 schema above.
- `Path=/apps/{slug}/` — not `Path=/`. `buildSetCookie` is the single place this is constructed; grep for it.
- `HttpOnly` + `SameSite=Strict` + `Secure` under TLS.
- `APP_IFRAME_PREFIXES = ["/apps/"]` — single prefix, no `/files/apps/` entry.
- `distributionStatus` is never trusted from client or from the on-disk manifest. `computeDistributionStatus` in `distribution-policy.ts` is the only writer.

---

### Task 9: AI Skills

**Files:**
- Create: `home/agents/skills/build-vite-app.md`
- Create: `home/agents/skills/pick-app-runtime.md`

- [ ] **Step 1: Write `pick-app-runtime.md`** — decision tree:
  - Does it need a server (API routes, SSR, background job)? → `node` (Next.js)
  - Does it need React ecosystem + build step? → `vite`
  - Is it a single HTML file with inline JS? → `static`

- [ ] **Step 2: Write `build-vite-app.md`** — covers:
  - `cp -r ~/apps/_template-vite ~/apps/{slug}`
  - Edit `matrix.json` (name, slug, description, category)
  - Edit `src/App.tsx`
  - Run `pnpm install && pnpm build`
  - Test locally via AppViewer hot-reload
  - Key patterns: using `useData`, `useKernel`, `useTheme` hooks from `matrix-os/client`

- [ ] **Step 3: Validate markdown** — no broken frontmatter, valid YAML

- [ ] **Step 4: Commit**

```
git commit -m "feat(skills): add build-vite-app and pick-app-runtime skills"
```

---

### Task 10: Phase 1 Integration Test

**Files:**
- Create: `tests/gateway/app-runtime-phase1.test.ts`

- [ ] **Step 1: Write end-to-end test**

```typescript
// tests/gateway/app-runtime-phase1.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestGateway } from "../helpers/gateway.js";

let tmpHome: string;
let gateway: Awaited<ReturnType<typeof buildTestGateway>>;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "matrix-os-phase1-"));
  gateway = await buildTestGateway({ home: tmpHome });
});
afterEach(async () => {
  await gateway.stop();
  await rm(tmpHome, { recursive: true, force: true });
});

describe("phase 1: static + vite runtime", () => {
  it("installs and serves a static app via the unified /apps/:slug/ dispatcher", async () => {
    await gateway.installAppFromFixture("calculator-static");
    const cookie = await gateway.openAppSession("calculator-static");
    const res = await fetch(`${gateway.url}/apps/calculator-static/`, { headers: { Cookie: cookie }});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Calculator");
  });

  it("serving an app without the session cookie returns 401", async () => {
    await gateway.installAppFromFixture("calculator-static");
    const res = await fetch(`${gateway.url}/apps/calculator-static/`);
    expect(res.status).toBe(401);
    expect(res.headers.get("matrix-session-refresh")).toBe("/api/apps/calculator-static/session");
  });

  it("installs, builds, and serves a Vite app through the same /apps/:slug/ route", async () => {
    await gateway.installAppFromFixture("hello-vite");
    const cookie = await gateway.openAppSession("hello-vite");
    const res = await fetch(`${gateway.url}/apps/hello-vite/`, { headers: { Cookie: cookie }});
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<html");
    expect(html).toMatch(/<script[^>]*src="[^"]*\.js"/);
  }, 180_000);

  it("session cookie issued for 'calculator-static' is rejected on /apps/hello-vite/ (path scoping)", async () => {
    const cookieA = await gateway.openAppSession("calculator-static");
    const res = await fetch(`${gateway.url}/apps/hello-vite/`, { headers: { Cookie: cookieA }});
    expect(res.status).toBe(401);
  });

  it("manifest API returns the expected runtime mode and distributionStatus", async () => {
    await gateway.installAppFromFixture("hello-vite");
    const res = await fetch(`${gateway.url}/api/apps/hello-vite/manifest`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    const body = await res.json();
    expect(body.manifest.runtime).toBe("vite");
    expect(body.distributionStatus).toBe("installable"); // first_party fixture
  });

  it("rebuild after source change reflects in served asset", async () => { /* ... */ }, 180_000);
});
```

- [ ] **Step 2: Implement `buildTestGateway()` helper** in `tests/helpers/gateway.ts`

- [ ] **Step 3: Run green**

- [ ] **Step 4: Commit**

```
git commit -m "test(app-runtime): phase 1 integration test (static + vite)"
```

---

### Phase 1 Completion Checklist

- [ ] All 10 tasks merged to main
- [ ] `bun run lint` clean
- [ ] `bun run build` succeeds
- [ ] `bun run test tests/gateway/app-runtime* tests/shell/app-*` all green
- [ ] Existing 11 static apps still load via AppViewer (smoke test in Docker)
- [ ] Update `CLAUDE.md` "Active Technologies" section with new dependencies
- [ ] Run `/update-docs` per project guidelines
- [ ] Announce Phase 1 unblock to spec 060 Wave 2 agents

---

## Phase 2 — Node Runtime

### Task 11: Port Pool

**Files:**
- Create: `packages/gateway/src/app-runtime/port-pool.ts`
- Create: `tests/gateway/app-runtime/port-pool.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/gateway/app-runtime/port-pool.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { PortPool } from "../../../packages/gateway/src/app-runtime/port-pool.js";
import { SpawnError } from "../../../packages/gateway/src/app-runtime/errors.js";

describe("PortPool", () => {
  it("allocates ports from the configured range", () => {
    const pool = new PortPool({ min: 40000, max: 40010 });
    const p1 = pool.allocate();
    const p2 = pool.allocate();
    expect(p1).toBeGreaterThanOrEqual(40000);
    expect(p1).toBeLessThanOrEqual(40010);
    expect(p2).not.toBe(p1);
  });

  it("releases ports back to the pool", () => {
    const pool = new PortPool({ min: 40000, max: 40001 });
    const p1 = pool.allocate();
    const p2 = pool.allocate();
    expect(() => pool.allocate()).toThrow(SpawnError);
    pool.release(p1);
    expect(pool.allocate()).toBe(p1);
  });

  it("throws port_exhausted when pool is empty", () => {
    const pool = new PortPool({ min: 40000, max: 40000 });
    pool.allocate();
    expect(() => pool.allocate()).toThrow(
      expect.objectContaining({ name: "SpawnError", code: "port_exhausted" })
    );
  });

  it("ignores release of unknown port (idempotent)", () => {
    const pool = new PortPool({ min: 40000, max: 40010 });
    pool.release(39999); // out of range, no throw
    pool.release(40005); // never allocated, no throw
  });

  it("tracks in-use ports", () => {
    const pool = new PortPool({ min: 40000, max: 40010 });
    const p = pool.allocate();
    expect(pool.inUse()).toContain(p);
    pool.release(p);
    expect(pool.inUse()).not.toContain(p);
  });
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement** using a `Set<number>` of available ports, LRU-style allocation

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add port pool 40000-49999"
```

---

### Task 12: Safe Env Builder

**Files:**
- Create: `packages/gateway/src/app-runtime/safe-env.ts`
- Create: `tests/gateway/app-runtime/safe-env.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("safeEnv", () => {
  it("includes only whitelisted vars", () => {
    process.env.CLAUDE_API_KEY = "secret";
    process.env.CLERK_SECRET_KEY = "also-secret";
    const env = safeEnv({ slug: "notes", port: 40000, homeDir: "/tmp/notes" });
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
    expect(env.PORT).toBe("40000");
    expect(env.MATRIX_APP_SLUG).toBe("notes");
    expect(env.MATRIX_APP_DATA_DIR).toBe("/tmp/notes/data");
  });

  it("sets NODE_ENV to production", () => { /* ... */ });
  it("omits NODE_OPTIONS to prevent debugger injection", () => { /* ... */ });
  it("provides a minimal PATH (no ~/.local/bin leakage)", () => { /* ... */ });
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add safe env whitelist for child processes"
```

---

### Task 13: Process Manager — Spawn + Health Check

**Files:**
- Create: `packages/gateway/src/app-runtime/process-manager.ts`
- Create: `tests/gateway/app-runtime/process-manager.test.ts`
- Create fixture: `tests/fixtures/apps/hello-next/` (minimal Next.js app with `/api/health` returning 200)

- [ ] **Step 1: Write failing tests** for `ProcessManager.ensureRunning(slug)` covering:
  - Spawns process with safe env
  - Polls health check endpoint until 200 or timeout
  - Transitions `starting` → `healthy` → `running`
  - Returns `SpawnError('startup_timeout')` on health check never succeeding
  - Returns `SpawnError('spawn_failed')` when binary doesn't exist
  - Sets `lastUsedAt` on success

- [ ] **Step 2: Create `hello-next/` fixture** (small Next 16 app with API route)

- [ ] **Step 3: Red**

- [ ] **Step 4: Implement spawn logic**

Key invariants:
- Insert `ProcessRecord` into map in `state: "starting"` BEFORE calling `spawn()`
- Attach `exit` + `error` handlers before `startupPromise` is awaited
- Health check uses `fetch(healthUrl, { signal: AbortSignal.timeout(startTimeout * 1000) })`
- On failure: kill child, release port, transition to `startup_failed`, remove from map

- [ ] **Step 5: Green**

- [ ] **Step 6: Commit**

```
git commit -m "feat(gateway): add process manager spawn + health check"
```

---

### Task 14: Process Manager — Concurrent ensureRunning Dedup

**Files:**
- Extend: `tests/gateway/app-runtime/process-manager.test.ts`
- Extend: `packages/gateway/src/app-runtime/process-manager.ts`

- [ ] **Step 1: Write test**

```typescript
it("dedupes concurrent ensureRunning calls via startupPromise", async () => {
  const spawnSpy = vi.spyOn(pm, "spawnInternal" as any);
  const [r1, r2, r3] = await Promise.all([
    pm.ensureRunning("hello-next"),
    pm.ensureRunning("hello-next"),
    pm.ensureRunning("hello-next"),
  ]);
  expect(spawnSpy).toHaveBeenCalledTimes(1);
  expect(r1.pid).toBe(r2.pid);
  expect(r2.pid).toBe(r3.pid);
});

it("rejects all callers when startup fails", async () => {
  // use a fixture that crashes on startup
  const results = await Promise.allSettled([
    pm.ensureRunning("crash-on-start"),
    pm.ensureRunning("crash-on-start"),
  ]);
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("rejected");
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement** — store `startupPromise` on `ProcessRecord`, return it to subsequent callers while state is `starting`

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): dedupe concurrent ensureRunning via startupPromise"
```

---

### Task 15: Process Manager — Idle Shutdown + LRU Eviction

**Files:**
- Extend: process-manager test + impl

- [ ] **Step 1: Write tests using fake timers**

```typescript
it("shuts down processes after idleShutdown seconds", async () => {
  vi.useFakeTimers();
  await pm.ensureRunning("hello-next");
  expect(pm.inspect("hello-next")?.state).toBe("running");
  vi.advanceTimersByTime(300_000 + 1_000);
  await vi.runAllTimersAsync();
  expect(pm.inspect("hello-next")?.state).toBe("idle");
  vi.useRealTimers();
});

it("resets idle timer when lastUsedAt updates", async () => { /* ... */ });

it("evicts LRU process when slot cap reached", async () => {
  pm = new ProcessManager({ maxProcesses: 2 });
  await pm.ensureRunning("app-a");
  await pm.ensureRunning("app-b");
  pm.markUsed("app-a"); // make B the LRU
  await pm.ensureRunning("app-c");
  expect(pm.inspect("app-b")?.state).toBe("stopping");
  expect(pm.inspect("app-a")?.state).toBe("running");
  expect(pm.inspect("app-c")?.state).toBe("running");
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement** with `setInterval` reaper at 30s tick cadence, `lastUsedAt` comparison, LRU eviction in `ensureRunning` when at cap

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): idle shutdown + LRU eviction for child processes"
```

---

### Task 16: Process Manager — Crash Recovery

**Files:**
- Extend: process-manager test + impl
- Create fixture: `tests/fixtures/apps/crash-on-request/` (responds once, then `process.exit(1)`)

- [ ] **Step 1: Write tests**

```typescript
it("restarts crashed process with exponential backoff", async () => {
  vi.useFakeTimers();
  await pm.ensureRunning("crash-once");
  // simulate crash after serving one request
  pm.onChildExit("crash-once", 1, null);
  expect(pm.inspect("crash-once")?.state).toBe("restarting");
  vi.advanceTimersByTime(1_000);
  await vi.runAllTimersAsync();
  expect(pm.inspect("crash-once")?.state).toBe("running");
  vi.useRealTimers();
});

it("gives up after max retries and transitions to failed", async () => {
  // use crash-on-startup fixture
  const result = await pm.ensureRunning("always-crash").catch((e) => e);
  expect(result).toBeInstanceOf(SpawnError);
  expect(pm.inspect("always-crash")?.state).toBe("failed");
  expect(pm.inspect("always-crash")?.restartCount).toBe(3);
});

it("detects OOM via SIGKILL exit code 137", async () => { /* ... */ });
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement crash handler**

On `child.on("exit", (code, signal))`:
- If `state === "running"` and code !== 0 → transition to `crashed`
- Schedule restart with `setTimeout(attempt === 0 ? 1000 : attempt === 1 ? 4000 : 16000)`
- After 3 failed restarts → `failed`, release port, emit `app:failed` event

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): crash recovery with exponential backoff"
```

---

### Task 17: App-Runtime Dispatcher (static + vite + node)

**Rename note:** originally scoped as "Reverse Proxy HTTP" — now covers all three runtime modes behind a single `/apps/:slug/*` handler, because spec §Architecture Overview unifies the URL prefix. File moves from `reverse-proxy.ts` to `dispatcher.ts`; the upstream-fetch code for node mode stays but is wrapped in a mode switch.

**Files:**
- Create: `packages/gateway/src/app-runtime/dispatcher.ts`
- Create: `tests/gateway/app-runtime/dispatcher.test.ts`
- The file-serving branches reuse the existing `resolveWithinHome` + streaming-file helpers from `server.ts`; do NOT reinvent static file serving.

- [ ] **Step 1: Write failing tests**

```typescript
describe("app-runtime dispatcher", () => {
  describe("static mode", () => {
    it("GET /apps/calculator/ serves ~/apps/calculator/index.html", async () => { /* ... */ });
    it("GET /apps/calculator/style.css serves ~/apps/calculator/style.css", async () => { /* ... */ });
    it("rejects path traversal (/apps/calculator/../../etc/passwd) with 400", async () => { /* ... */ });
    it("does NOT spawn a child process for static apps", async () => {
      // assert processManager.inspect(slug) is undefined after the request
    });
    it("returns 400 on WebSocket upgrade attempt in static mode", async () => { /* ... */ });
  });

  describe("vite mode", () => {
    it("GET /apps/notes/ serves ~/apps/notes/dist/index.html", async () => { /* ... */ });
    it("GET /apps/notes/assets/main.js serves ~/apps/notes/dist/assets/main.js", async () => { /* ... */ });
    it("returns 503 needs_build when dist/ is missing", async () => { /* ... */ });
    it("does NOT spawn a child process for vite apps", async () => { /* ... */ });
  });

  describe("node mode", () => {
    it("forwards GET to child process", async () => {
      const res = await fetch(`${gateway.url}/apps/hello-next/api/hello`, { headers: { Cookie: validCookie("hello-next") }});
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("hello");
    });
    it("forwards POST with body", async () => { /* ... */ });
    it("forwards headers (minus hop-by-hop)", async () => { /* ... */ });
    it("strips Server and X-Powered-By from response", async () => { /* ... */ });
    it("replaces client-supplied X-Forwarded-Host with canonical gateway host", async () => {
      // send a request with a poisoned Host header and X-Forwarded-Host, assert
      // the upstream child sees cfg.publicHost (not "evil.example"). Exercises
      // the CLIENT_CONTROLLED_FORWARDED strip list.
    });
    it("strips X-Real-IP and Forwarded headers from inbound requests", async () => { /* ... */ });
    it("rejects inbound X-Matrix-App-Slug and sets its own", async () => { /* ... */ });
    it("returns 502 with correlation id on backend error", async () => { /* ... */ });
    it("returns 503 when app is in failed state", async () => { /* ... */ });
    it("returns 504 on backend timeout (30s)", async () => { /* ... */ });
    it("respects bodyLimit 10MB", async () => { /* ... */ });
    it("awaits startupPromise when process is starting", async () => { /* ... */ });
  });

  describe("dispatch invariants", () => {
    it("rejects invalid slug with 400 (before touching the filesystem or process manager)", async () => { /* ... */ });
    it("returns 404 when manifest is missing", async () => { /* ... */ });
    it("dispatches to static for `runtime: \"static\"`, vite for `runtime: \"vite\"`, node for `runtime: \"node\"`", async () => { /* ... */ });
    it("mode choice re-reads the manifest on every request (supports live mode migration without restart)", async () => { /* ... */ });
  });
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement dispatcher**

```typescript
// packages/gateway/src/app-runtime/dispatcher.ts
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ProcessManager } from "./process-manager.js";
import { loadManifest } from "./manifest-loader.js";
import { serveStaticFileWithin } from "./serve-static.js"; // thin wrapper over existing helpers
import { ProxyError } from "./errors.js";
import { resolveWithinHome } from "../fs-helpers.js";

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
]);
// Client-controlled forwarded headers MUST NOT be trusted. We strip every
// inbound occurrence and rewrite canonical values from gateway config before
// forwarding upstream. This blocks host-header injection, spoofed client IPs,
// and poisoned absolute URL generation in the child (Next.js, etc).
const CLIENT_CONTROLLED_FORWARDED = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "x-matrix-app-slug", // never honor an inbound claim about which app this is
]);
const STRIPPED_RESPONSE = new Set(["server", "x-powered-by"]);

export function mountAppRuntimeDispatcher(
  app: Hono,
  pm: ProcessManager,
  cfg: { publicHost: string },
) {
  app.use("/apps/:slug/*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));
  app.all("/apps/:slug/*", async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

    // appSessionMiddleware has already verified the signed cookie by the time
    // we get here — mount order is `appSessionMiddleware` → `mountAppRuntimeDispatcher`
    // in server.ts. See spec §Authorization.

    const manifestResult = await loadManifest(resolveWithinHome(`apps/${slug}`));
    if (!manifestResult.ok) {
      if (manifestResult.error.code === "not_found") return c.json({ error: "not found" }, 404);
      c.get("logger").error({ err: manifestResult.error, slug }, "manifest load failed");
      return c.json({ error: "internal", correlationId: c.get("requestId") }, 500);
    }
    const manifest = manifestResult.manifest;
    const rest = c.req.path.replace(`/apps/${slug}`, "") || "/";

    switch (manifest.runtime) {
      case "static":
        if (c.req.header("upgrade") === "websocket") return c.json({ error: "ws not supported for static runtime" }, 400);
        return serveStaticFileWithin(c, `apps/${slug}`, rest === "/" ? "/index.html" : rest);

      case "vite":
        if (c.req.header("upgrade") === "websocket") return c.json({ error: "ws not supported for vite runtime" }, 400);
        return serveStaticFileWithin(c, `apps/${slug}/dist`, rest === "/" ? "/index.html" : rest);

      case "node":
        return dispatchNode(c, slug, rest, pm, cfg);

      default:
        return c.json({ error: "unknown runtime" }, 500);
    }
  });
}

async function dispatchNode(c, slug: string, rest: string, pm: ProcessManager, cfg: { publicHost: string }) {
  let record;
  try {
    record = await pm.ensureRunning(slug);
  } catch (err) {
    c.get("logger").error({ err, slug }, "failed to start app");
    return c.json({ error: "app failed to start", correlationId: c.get("requestId") }, 503);
  }

  const upstreamUrl = `http://127.0.0.1:${record.port}${rest}${new URL(c.req.url).search}`;

  const reqHeaders = new Headers(c.req.raw.headers);
  HOP_BY_HOP.forEach((h) => reqHeaders.delete(h));
  // Strip ALL client-supplied forwarded headers before setting canonical ones.
  // Reading c.req.header("host") is NOT safe — it is user-controlled.
  CLIENT_CONTROLLED_FORWARDED.forEach((h) => reqHeaders.delete(h));
  reqHeaders.set("X-Forwarded-Host", cfg.publicHost);    // canonical, from gateway config
  reqHeaders.set("X-Forwarded-Proto", "https");          // gateway terminates TLS in prod
  reqHeaders.set("X-Forwarded-Prefix", `/apps/${slug}`); // for Next.js basePath reconstruction
  reqHeaders.set("X-Matrix-App-Slug", slug);             // set AFTER delete — our claim wins

  try {
    const upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers: reqHeaders,
      body: c.req.raw.body,
      signal: AbortSignal.timeout(30_000),
      // @ts-expect-error duplex for streaming body
      duplex: "half",
    });
    pm.markUsed(slug);
    const resHeaders = new Headers(upstream.headers);
    HOP_BY_HOP.forEach((h) => resHeaders.delete(h));
    STRIPPED_RESPONSE.forEach((h) => resHeaders.delete(h));
    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  } catch (err) {
    const correlationId = c.get("requestId") ?? crypto.randomUUID();
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    c.get("logger").error({ err, slug, correlationId }, "proxy error");
    return c.json(
      { error: "upstream error", correlationId },
      isTimeout ? 504 : 502,
    );
  }
}
```

`serveStaticFileWithin` is a thin wrapper that calls the existing `/files/*` handler logic in `server.ts` with a fixed base directory and `resolveWithinHome` on every read. Do NOT reimplement content-type sniffing, range requests, or ETag handling — reuse what `server.ts:1388-1397` already does.

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add app-runtime dispatcher for /apps/:slug/*"
```

---

### Task 18: Dispatcher — WebSocket Upgrade (node mode only)

**Files:**
- Extend: `packages/gateway/src/app-runtime/dispatcher.ts`
- Extend: `tests/gateway/app-runtime/dispatcher.test.ts`

- [ ] **Step 1: Write failing test** using a fixture Next.js app that echoes WebSocket frames

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement WS upgrade**

Uses `@hono/node-ws` upgrade callback. On upgrade request for `/apps/{slug}/*`:
1. `appSessionMiddleware` already verified the cookie (cookies are attached to WS handshakes)
2. Load manifest; if `runtime !== "node"`, reject with `400 ws_not_supported` (static and vite never proxy websockets — keeps the attack surface tight)
3. `pm.ensureRunning(slug)`, dial `ws://127.0.0.1:{port}{rest}` with `ws` library, pipe frames both directions, close downstream on upstream close and vice versa
4. Enforce 60s idle timeout

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add websocket upgrade to dispatcher (node mode)"
```

---

### Task 19: Next.js Template `_template-next/`

**Files:**
- Create: `home/apps/_template-next/*`
- Create: `tests/gateway/next-template.test.ts`

- [ ] **Step 1: Write failing test** — copy template to tmp dir, run full install + build + spawn + proxy via gateway, assert response

- [ ] **Step 2: Red**

- [ ] **Step 3: Write template files**

Key points:
- `next.config.ts` imports `MATRIX_APP_SLUG` from env and sets `basePath: \`/apps/\${process.env.MATRIX_APP_SLUG}\``
- `app/api/health/route.ts` returns `{ ok: true }` for health checks
- `matrix.json`: `{ runtime: "node", build: { command: "next build", output: ".next" }, serve: { start: "next start", healthCheck: "/api/health", idleShutdown: 300 } }`
- Pinned lockfile so builds are fast

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(apps): add Next.js template with basePath wiring"
```

---

### Task 20: Build-Next-App Skill

**Files:**
- Create: `home/agents/skills/build-next-app.md`

- [ ] **Step 1: Write skill** — covers scaffold, matrix.json conventions, basePath gotcha, api route patterns, using `@matrix-os/client` for kernel integration

- [ ] **Step 2: Commit**

```
git commit -m "feat(skills): add build-next-app skill"
```

---

### Task 21: Phase 2 Integration Test

**Files:**
- Create: `tests/gateway/app-runtime-phase2.test.ts`

- [ ] **Step 1: Write end-to-end test**

```typescript
describe("phase 2: node runtime", () => {
  it("installs, builds, spawns, and proxies a Next.js app", async () => {
    await gateway.installAppFromFixture("hello-next");
    const res = await fetch(`${gateway.url}/apps/hello-next/api/hello`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "hello from next" });
  }, 240_000);

  it("cold starts a shut-down app on next request", async () => { /* ... */ });
  it("survives a child crash and serves next request", async () => { /* ... */ });
  it("idle shutdown releases the port", async () => { /* ... */ });
  it("gateway graceful shutdown SIGTERMs all children", async () => { /* ... */ });
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Iterate until green**

- [ ] **Step 4: Commit**

```
git commit -m "test(app-runtime): phase 2 integration test (node runtime)"
```

---

### Phase 2 Completion Checklist

- [ ] Tasks 11–21 all on main
- [ ] Process manager handles SIGTERM → graceful shutdown of all children
- [ ] Reverse proxy passes HTTP + WS smoke test against hello-next fixture
- [ ] Crash recovery + LRU eviction verified with fake timers
- [ ] Docker build succeeds (pnpm install works inside container for hello-next)
- [ ] Coverage ≥ 95% on new files (per constitution TDD principle)
- [ ] Announce Phase 2 unblock to spec 060 Wave 3 agents

---

## Phase 3 — App Store Integration

### Task 22: Publish CLI

**Files:**
- Create: `packages/cli/src/commands/app-publish.ts`
- Create: `tests/cli/app-publish.test.ts`

- [ ] **Step 1: Write failing tests** — validate manifest, tar source, tar dist, compute hash, sign bundle, upload stub

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement** `matrix app publish` command

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(cli): add 'matrix app publish' command"
```

---

### Task 23: Verified Install Path

**Files:**
- Extend: `packages/gateway/src/app-runtime/install-flow.ts`
- Extend: `tests/gateway/app-runtime/install-flow.test.ts`

- [ ] **Step 1: Write tests** — trusted vs verified paths, hash mismatch rejection, tampering detection

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement verified path** — discard shipped dist, rebuild from source, hash output, compare to declared

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): verified install path with reproducible build hash"
```

---

### Task 24: Runtime Version Negotiation

**Files:**
- Create: `packages/gateway/src/app-runtime/runtime-version.ts`
- Extend: install-flow tests

- [ ] **Step 1: Write tests** — semver range matching, reject incompatible runtimeVersion, accept compatible

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement** using `semver` package

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): runtime version negotiation for app installs"
```

---

### Phase 3 Completion Checklist

- [ ] `matrix app publish` works end-to-end against local fixture store
- [ ] Verified install rejects tampered dist
- [ ] Runtime version mismatch produces clear UI error
- [ ] Trusted install completes in <5s on warm pnpm store
- [ ] Spec 063 archived as "complete" in `specs/` index

---

## Phase 4 — Dev Mode (stubbed)

Scoped out of this spec. Placeholder task:

- [ ] **T063-P4**: Add `dev: true` matrix.json flag, gateway runs `pnpm dev` instead of serving `dist/`, HMR WebSocket proxy. Separate follow-up spec required.

---

## Phase 3b — Prerequisites for Spec 064 (App Import)

Spec 064 (App Import) depends on three small additions to the install-flow / shared-state modules that are not needed by spec 063 on its own. They ship as an extension to 063's Phase 3 module — same files, narrow surface — so they land with 063 rather than as a surprise dependency when 064 implementation starts. Without these, spec 064 cannot begin Phase 1.

### Task 25: `installFromStagingDir` parallel entry point

**Files:**
- Modify: `packages/gateway/src/app-runtime/install-flow.ts`
- Extend: `tests/gateway/app-runtime/install-flow.test.ts`

- [ ] **Step 1: Extract helpers from the existing `installFlow.install()` so both entry points can share them.** Pull out `validateManifestOnDisk`, `atomicRenameIntoApps`, `runBuildPipeline`, `writeBuildStamp`, `registerInCatalog` into module-private functions that both callers consume. No behavior change.
- [ ] **Step 2: Add the new entry point with this exact signature (imports from 064 depend on this shape):**

```typescript
export async function installFromStagingDir(opts: {
  stagingDir: string;                // /tmp/matrix-import/{uuid}/app, fully prepared
  resolvedSlug: string;              // slug reservation held by caller via shared table
  listingTrust: "first_party" | "community";
  ackToken?: string;                 // required for community; undefined for first_party
  principalUserId: string;
}): Promise<{ slug: string; distributionStatus: "installable" }>;
```

- [ ] **Step 3: Implement the entry point:**
  1. Re-read `matrix.json` from `stagingDir/matrix.json` via the existing loader; fail on schema mismatch or if declared `slug` / `listingTrust` do not match `opts`.
  2. For `listingTrust === "community"`, call `verifyAckToken({ token: opts.ackToken!, correlationId: basename(stagingDir), principalUserId: opts.principalUserId })` from 058's verifier module. Fail with `InstallError("invalid_ack" | "ack_already_consumed" | "ack_expired")`.
  3. Compute `distributionStatus` via the existing policy function. If `gated` and no ack, this is a bug path — log at error and fail closed.
  4. `atomicRenameIntoApps(stagingDir, opts.resolvedSlug)`; on `EEXIST`, fail with `InstallError("slug_race")`.
  5. Run the shared build pipeline (pnpm install --frozen-lockfile, pnpm build, build-stamp, catalog registration) exactly as `install()` does.
  6. On any failure after the rename, clean up `~/apps/{slug}/` and release the slug reservation.

- [ ] **Step 4: Tests for the new entry point.** Happy path (first_party staging dir → installed), community with valid ack, community with wrong-principal ack rejected, community with consumed ack rejected, slug-race failure path, schema drift between `opts` and on-disk manifest rejected.

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add installFromStagingDir entry point for 064 app import"
```

### Task 26: Shared slug reservation table

**Files:**
- Create: `packages/gateway/src/app-runtime/slug-reservation-table.ts`
- Modify: `packages/gateway/src/app-runtime/install-flow.ts` (consult the table in both entry points)
- Create: `tests/gateway/app-runtime/slug-reservation-table.test.ts`

- [ ] **Step 1:** Define the module-scoped singleton:

```typescript
export interface SlugReservationTable {
  tryReserve(slug: string, owner: string): { ok: true; release: () => void } | { ok: false; heldBy: string };
  isReserved(slug: string): boolean;
  // For tests + startup reconciliation only:
  _entries(): ReadonlyMap<string, { owner: string; reservedAt: number }>;
}
```

- [ ] **Step 2:** Both `installFlow.install()` and `installFlow.installFromStagingDir()` must consult the table before their own `fs.rename` step. The check is: `isReserved(slug) || directoryExists(~/apps/{slug})`. The atomic rename happens under the reservation; the reservation is released after successful catalog registration or on failure cleanup.
- [ ] **Step 3:** Startup reconciliation — on gateway boot, clear any stale reservations (they are in-memory, so a restart naturally drops them). The table is NOT persisted to disk.
- [ ] **Step 4:** Tests: concurrent `tryReserve` for the same slug, one wins and one fails with `heldBy`; `release()` frees it; `isReserved` reflects state; wrong-owner release is a no-op.
- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): shared slug reservation table for install-flow + 064 import"
```

### Task 27: 058 ack-token verifier module boundary

**Files:**
- Modify: `packages/gateway/src/app-runtime/install-flow.ts` (import from 058)
- Coordinate: spec 058 exposes `verifyAckToken({ token, correlationId, principalUserId })`

- [ ] **Step 1:** Settle the module path and signature with spec 058's author. Target shape:

```typescript
// packages/gateway/src/app-gallery/ack-token-verifier.ts (owned by 058)
export function verifyAckToken(opts: {
  token: string;
  correlationId: string;
  principalUserId: string;
}): { ok: true } | { ok: false; code: "invalid" | "already_consumed" | "expired" | "principal_mismatch" };
```

- [ ] **Step 2:** Import it from `install-flow.ts::installFromStagingDir`. No new logic in 063 — just the module boundary. If spec 058 has not landed the verifier by the time Phase 3b starts, 063 stubs it with a function that always returns `{ ok: false, code: "invalid" }` and logs a `TODO(058)` warning. This lets Phase 3b land on time; the stub is swapped for the real verifier when 058 is ready.
- [ ] **Step 3:** Integration test: community import via `installFromStagingDir` rejects without a valid ack token under either the stub or the real verifier.
- [ ] **Step 4: Commit**

```
git commit -m "feat(gateway): wire 058 ack-token verifier into install-flow for community imports"
```

**Phase 3b done criteria:**
- [ ] All three tasks merged, tests green
- [ ] `installFromStagingDir` exports publicly from `packages/gateway/src/app-runtime/install-flow.ts`
- [ ] Slug reservation table is consulted by both install-flow entry points
- [ ] 058 verifier boundary is settled (stub or real)
- [ ] Spec 064 can import these from the gateway package without further changes to 063

---

## Global Done Criteria

- [ ] All phases 1-3 merged to main
- [ ] `bun run test` all green (unit + integration)
- [ ] `bun run lint` and `bun run build` clean
- [ ] Playwright smoke test (`tests/e2e/app-runtime.spec.ts`) passes in CI
- [ ] User can install a Vite app from the fixture app store in under 5 seconds
- [ ] User can install a Next.js app and first-request latency is under 5 seconds (cold) / under 100ms (warm)
- [ ] Process manager idle shutdown verified in Docker over 10 minutes
- [ ] `specs/060-default-apps/plan.md` Wave 2 can proceed

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| pnpm install time kills first-open UX | Bad first impression | Pre-resolve template lockfiles; use pnpm store; show build progress in UI |
| Child process memory leaks crash container | OOM kills the gateway | Memory limit via Node flag, idle shutdown, process monitoring |
| Port pool exhaustion under attack | DoS | LRU eviction, rate-limit install flow |
| Next.js basePath misconfig breaks asset loading | Apps render broken | Generated wrapper config, not hand-written |
| Concurrent build flood when installing default apps at startup | Gateway stalls | Serialize builds, concurrency cap of 4, backpressure install queue |
| Reverse proxy body buffering blows memory on large uploads | OOM | Stream via `duplex: "half"`, enforce `bodyLimit` |
| WS upgrade doesn't close upstream on client disconnect | Resource leak | Explicit close propagation, unit test |
| Build stamp corruption causes infinite rebuild loop | Slow UI | Stamp validity check + automatic recovery (delete + rebuild) |
| pnpm store tamper by malicious app | Supply chain | Frozen lockfile, hash comparison, future: sandbox install |

---

## Dependencies

- `zod` (already in package.json, v4)
- `hono` (already in)
- `@hono/node-ws` (already in)
- `ws` (for dispatcher node-mode WebSocket client — add to gateway package)
- `semver` (add to gateway package)
- `glob` (add for source glob matching in build-cache)

Run `pnpm install` from repo root after each new dependency addition per CLAUDE.md lockfile rule.
