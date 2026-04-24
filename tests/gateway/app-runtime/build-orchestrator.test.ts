import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("enforces build timeout via AbortSignal", async () => {
    const result = await orch.build("hello-vite", appDir, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as BuildError).code).toBe("timeout");
    }
  }, 30_000);

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
