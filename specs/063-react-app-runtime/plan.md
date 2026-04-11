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
| `packages/gateway/src/app-runtime/reverse-proxy.ts` | **NEW** — Hono middleware for `/apps/{slug}/*`, HTTP + WebSocket |
| `packages/gateway/src/app-runtime/errors.ts` | **NEW** — typed errors (BuildError, SpawnError, HealthCheckError, ProxyError, ManifestError) |
| `packages/gateway/src/app-runtime/index.ts` | **NEW** — public API exports + gateway integration |
| `packages/gateway/src/server.ts` | **MODIFY** — mount manifest API + reverse-proxy middleware; graceful shutdown hook |
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
| `tests/gateway/app-runtime/reverse-proxy.test.ts` | **NEW** |
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

- [ ] **Step 1: Write failing tests**

Gateway side:
- `GET /api/apps/notes/manifest` → 200 with manifest body
- `GET /api/apps/missing/manifest` → 404
- `GET /api/apps/../etc/passwd/manifest` → 400 (slug regex rejects)
- Does not leak filesystem errors (generic 500 with correlation id)

Shell side:
- `fetchAppManifest("notes")` hits network once, second call uses cache
- `fetchAppManifest("notes")` re-fetches after 60s TTL expires
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
  const result = await loadManifest(appDir);
  if (!result.ok) {
    if (result.error.code === "not_found") return c.json({ error: "not found" }, 404);
    c.get("logger").error({ error: result.error }, "manifest load failed");
    return c.json({ error: "internal", correlationId: c.get("requestId") }, 500);
  }
  return c.json(result.manifest);
});
```

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

describe("AppViewer runtime modes", () => {
  it("uses /files/apps/{slug}/index.html for static runtime", async () => {
    vi.mocked(fetchAppManifest).mockResolvedValue({
      slug: "calculator", runtime: "static", /* ... */
    });
    const { container } = render(<AppViewer path="apps/calculator" />);
    await waitFor(() => {
      const iframe = container.querySelector("iframe");
      expect(iframe?.src).toContain("/files/apps/calculator/index.html");
    });
  });

  it("uses /files/apps/{slug}/dist/index.html for vite runtime", async () => { /* ... */ });
  it("uses /apps/{slug}/ for node runtime", async () => { /* ... */ });
  it("renders error card when manifest load fails", async () => { /* ... */ });
  it("renders build-failed card when runtime state is build_failed", async () => { /* ... */ });
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Modify `AppViewer.tsx`**

Add state for manifest mode, replace hard-coded `/files/${path}` src with mode-dependent URL, show error cards on failure. Keep bridge script injection unchanged — it applies to all three modes since they all run same-origin.

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
  it("installs and serves a static app", async () => {
    await gateway.installAppFromFixture("calculator-static");
    const res = await fetch(`${gateway.url}/files/apps/calculator/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Calculator");
  });

  it("installs, builds, and serves a Vite app", async () => {
    await gateway.installAppFromFixture("hello-vite");
    const res = await fetch(`${gateway.url}/files/apps/hello-vite/dist/index.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<html");
    expect(html).toMatch(/<script[^>]*src="[^"]*\.js"/);
  }, 180_000);

  it("manifest API returns the expected runtime mode", async () => {
    await gateway.installAppFromFixture("hello-vite");
    const res = await fetch(`${gateway.url}/api/apps/hello-vite/manifest`);
    const m = await res.json();
    expect(m.runtime).toBe("vite");
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

### Task 17: Reverse Proxy — HTTP

**Files:**
- Create: `packages/gateway/src/app-runtime/reverse-proxy.ts`
- Create: `tests/gateway/app-runtime/reverse-proxy.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("reverseProxy", () => {
  it("forwards GET to child process", async () => {
    await pm.ensureRunning("hello-next");
    const res = await fetch(`${gateway.url}/apps/hello-next/api/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hello");
  });

  it("forwards POST with body", async () => { /* ... */ });
  it("forwards headers (minus hop-by-hop)", async () => { /* ... */ });
  it("strips Server and X-Powered-By from response", async () => { /* ... */ });
  it("returns 502 with correlation id on backend error", async () => { /* ... */ });
  it("returns 503 when app is in failed state", async () => { /* ... */ });
  it("returns 504 on backend timeout (30s)", async () => { /* ... */ });
  it("respects bodyLimit 10MB", async () => { /* ... */ });
  it("rejects invalid slug with 400", async () => { /* ... */ });
  it("awaits startupPromise when process is starting", async () => { /* ... */ });
});
```

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement Hono middleware**

```typescript
// packages/gateway/src/app-runtime/reverse-proxy.ts
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ProcessManager } from "./process-manager.js";
import { ProxyError } from "./errors.js";

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
]);
const STRIPPED_RESPONSE = new Set(["server", "x-powered-by"]);

export function mountReverseProxy(app: Hono, pm: ProcessManager) {
  app.use("/apps/:slug/*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));
  app.all("/apps/:slug/*", async (c) => {
    const slug = c.req.param("slug");
    if (!SAFE_SLUG.test(slug)) return c.json({ error: "invalid slug" }, 400);

    let record;
    try {
      record = await pm.ensureRunning(slug);
    } catch (err) {
      c.get("logger").error({ err, slug }, "failed to start app");
      return c.json({ error: "app failed to start", correlationId: c.get("requestId") }, 503);
    }

    const rest = c.req.path.replace(`/apps/${slug}`, "") || "/";
    const upstreamUrl = `http://127.0.0.1:${record.port}${rest}${new URL(c.req.url).search}`;

    const reqHeaders = new Headers(c.req.raw.headers);
    HOP_BY_HOP.forEach((h) => reqHeaders.delete(h));
    reqHeaders.set("X-Forwarded-Host", c.req.header("host") ?? "");
    reqHeaders.set("X-Forwarded-Proto", "http");
    reqHeaders.set("X-Matrix-App-Slug", slug);

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
  });
}
```

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add http reverse proxy for node apps"
```

---

### Task 18: Reverse Proxy — WebSocket Upgrade

**Files:**
- Extend: `packages/gateway/src/app-runtime/reverse-proxy.ts`
- Extend: `tests/gateway/app-runtime/reverse-proxy.test.ts`

- [ ] **Step 1: Write failing test** using a fixture Next.js app that echoes WebSocket frames

- [ ] **Step 2: Red**

- [ ] **Step 3: Implement WS upgrade**

Uses `@hono/node-ws` upgrade callback. On upgrade request for `/apps/{slug}/*`, dials `ws://127.0.0.1:{port}{rest}` with `ws` library, pipes frames both directions, closes downstream on upstream close and vice versa. Enforces 60s idle timeout.

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```
git commit -m "feat(gateway): add websocket upgrade to reverse proxy"
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
- `ws` (for reverse-proxy WebSocket client — add to gateway package)
- `semver` (add to gateway package)
- `glob` (add for source glob matching in build-cache)

Run `pnpm install` from repo root after each new dependency addition per CLAUDE.md lockfile rule.
