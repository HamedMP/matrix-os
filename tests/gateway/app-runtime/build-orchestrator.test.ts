import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { BuildOrchestrator } from "../../../packages/gateway/src/app-runtime/build-orchestrator.js";
import { BuildError } from "../../../packages/gateway/src/app-runtime/errors.js";

let tmpDir: string;
let appDir: string;
let orch: BuildOrchestrator;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-build-orch-"));
  appDir = join(tmpDir, "hello-vite");
  await cp(
    join(process.cwd(), "tests/fixtures/apps/hello-vite"),
    appDir,
    { recursive: true },
  );
  orch = new BuildOrchestrator({ concurrency: 2, storeDir: join(tmpDir, ".pnpm-store") });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

// Polls on setImmediate so it keeps working while setTimeout is faked.
async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setImmediate(r));
  }
}

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("BuildOrchestrator", () => {
  it("builds a fresh app from scratch", async () => {
    const result = await orch.build("hello-vite", appDir);
    expect(result.ok).toBe(true);
    const indexPath = join(appDir, "dist", "index.html");
    expect(existsSync(indexPath)).toBe(true);
    const html = await readFile(indexPath, "utf8");
    expect(html).toContain("<html");
  }, 120_000);

  it("skips rebuild when cache is warm", async () => {
    await orch.build("hello-vite", appDir);
    const start = Date.now();
    const result = await orch.build("hello-vite", appDir);
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(500);
  }, 120_000);

  it("rebuilds when source changes", async () => {
    await orch.build("hello-vite", appDir);
    await writeFile(
      join(appDir, "src", "App.tsx"),
      'export default function App() { return <div>changed-content-marker</div>; }',
    );
    const result = await orch.build("hello-vite", appDir);
    expect(result.ok).toBe(true);
  }, 120_000);

  it("returns BuildError on install failure", async () => {
    await writeFile(join(appDir, "package.json"), "{ not valid json");
    const result = await orch.build("hello-vite", appDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BuildError);
    }
  }, 60_000);

  it("enforces build timeout", async () => {
    const result = await orch.build("hello-vite", appDir, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as BuildError).code).toBe("timeout");
    }
  }, 30_000);

  it("resolves timeout when abort fires before process close", async () => {
    await writeFile(join(appDir, "matrix.json"), JSON.stringify({
      name: "Hello Vite",
      slug: "hello-vite",
      version: "1.0.0",
      runtime: "vite",
      runtimeVersion: "^1.0.0",
      listingTrust: "first_party",
      build: {
        install: "node -e \"process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),2000)\"",
        command: "node -e \"process.exit(0)\"",
        output: "dist",
        timeout: 120,
        sourceGlobs: ["matrix.json"],
      },
    }));

    const start = Date.now();
    const result = await orch.build("hello-vite", appDir, { timeoutMs: 100 });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as BuildError).code).toBe("timeout");
    }
    expect(elapsed).toBeLessThan(1_000);
  }, 10_000);

  it("kills the whole build process tree before resolving a timeout", async () => {
    // `sh -c` forks the background writer as a grandchild of the gateway.
    // Signalling only the direct `sh` child would orphan it, leaving it to
    // keep writing into the app directory after the build reported timeout.
    await writeFile(join(appDir, "matrix.json"), JSON.stringify({
      name: "Hello Vite",
      slug: "hello-vite",
      version: "1.0.0",
      runtime: "vite",
      runtimeVersion: "^1.0.0",
      listingTrust: "first_party",
      build: {
        install: "sleep 30 & echo $! > grandchild.pid.tmp && mv grandchild.pid.tmp grandchild.pid; wait",
        command: "node -e \"process.exit(0)\"",
        output: "dist",
        timeout: 120,
        sourceGlobs: ["matrix.json"],
      },
    }));

    // Fake only the orchestrator's timers so the timeout fires exactly when
    // the test says, after the grandchild is known to be running.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const buildPromise = orch
        .build("hello-vite", appDir, { timeoutMs: 60_000 })
        .finally(() => {
          settled = true;
        });

      const pidPath = join(appDir, "grandchild.pid");
      await waitForFile(pidPath);
      const grandchildPid = Number(await readFile(pidPath, "utf8"));
      expect(grandchildPid).toBeGreaterThan(0);
      expect(isAlive(grandchildPid)).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      while (!settled) {
        await vi.advanceTimersByTimeAsync(20);
        await new Promise((r) => setImmediate(r));
      }

      const result = await buildPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.error as BuildError).code).toBe("timeout");
      }
      expect(isAlive(grandchildPid)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("serializes concurrent builds for same slug", async () => {
    const results = await Promise.all([
      orch.build("hello-vite", appDir),
      orch.build("hello-vite", appDir),
      orch.build("hello-vite", appDir),
    ]);
    // All should succeed
    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  }, 180_000);

  it("writes build log to .build.log", async () => {
    await orch.build("hello-vite", appDir);
    const logPath = join(appDir, ".build.log");
    expect(existsSync(logPath)).toBe(true);
    const log = await readFile(logPath, "utf8");
    expect(log.length).toBeGreaterThan(0);
  }, 120_000);
});
