import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

  it("enforces build timeout", async () => {
    const result = await orch.build("hello-vite", appDir, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as BuildError).code).toBe("timeout");
    }
  }, 30_000);

  it("resolves promptly when a timed-out child ignores SIGTERM", async () => {
    const manifestPath = join(appDir, "matrix.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    manifest.build.install = "node -e \"\"";
    manifest.build.command = `node -e ${JSON.stringify(script)}`;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const startedAt = Date.now();
    const result = await orch.build("hello-vite-ignore-term", appDir, { timeoutMs: 100 });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(2_000);
    if (!result.ok) {
      expect((result.error as BuildError).code).toBe("timeout");
    }
  }, 5_000);

  it("kills descendants from timed-out build commands", async () => {
    const manifestPath = join(appDir, "matrix.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const childPidPath = join(tmpDir, "child.pid");
    const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const script = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    manifest.build.install = "node -e \"\"";
    manifest.build.command = `node -e ${JSON.stringify(script)}`;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const result = await orch.build("hello-vite-descendant-timeout", appDir, { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as BuildError).code).toBe("timeout");
    }

    const childPid = Number(await readFile(childPidPath, "utf8"));
    await delay(1_200);
    expect(isProcessAlive(childPid)).toBe(false);
  }, 5_000);

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = err instanceof Error && "code" in err
      ? (err as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ESRCH") {
      return false;
    }
    throw err;
  }
}
