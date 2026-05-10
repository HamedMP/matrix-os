import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSymphonyRunner } from "../../packages/gateway/src/symphony-runner.js";

class FakeProcess extends EventEmitter {
  pid = 12345;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.exitCode = signal === "SIGKILL" ? 137 : 0;
    this.emit("exit", this.exitCode);
    return true;
  }
}

describe("Symphony runner", () => {
  let homePath: string;
  let serviceRoot: string;
  let workflowPath: string;
  let binPath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-symphony-runner-"));
    serviceRoot = join(homePath, "code", "symphony", "elixir");
    workflowPath = join(homePath, "WORKFLOW.md");
    binPath = join(serviceRoot, "bin", "symphony");
    await mkdir(join(serviceRoot, "bin"), { recursive: true });
    await writeFile(workflowPath, "---\ntracker:\n  kind: linear\n---\n");
    await writeFile(binPath, "#!/bin/sh\n");
    await chmod(binPath, 0o755);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("defaults to the Matrix Linear Symphony ticket contract", async () => {
    const runner = createSymphonyRunner({ homePath, env: {} });

    const status = await runner.status();

    expect(status.config.tracker).toEqual({
      kind: "linear",
      teamKey: "MAT",
      requiredLabels: ["symphony"],
      activeStates: ["Todo", "In Progress", "Merging", "Rework"],
    });
    expect(status.config.port).toBe(4066);
  });

  it("fails instead of replacing an invalid persisted config with defaults", async () => {
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system", "symphony.json"), "{invalid-json");
    const runner = createSymphonyRunner({ homePath, env: {} });

    await expect(runner.status()).rejects.toThrow("Symphony configuration could not be loaded");
  });

  it("refuses to start without a local Linear API key", async () => {
    const spawnProcess = vi.fn();
    const runner = createSymphonyRunner({ homePath, env: {}, spawnProcess });

    const result = await runner.start({ serviceRoot, workflowPath, binPath });

    expect(result).toMatchObject({ ok: false, code: "missing_linear_api_key" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("starts the local Elixir runner without invoking a shell", async () => {
    const child = new FakeProcess();
    const spawnProcess = vi.fn(() => child as never);
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess,
    });

    const result = await runner.start({
      serviceRoot,
      workflowPath,
      binPath: "./bin/symphony",
      port: 4077,
      tracker: { teamKey: "MAT", requiredLabels: ["symphony"], activeStates: ["Todo", "Rework"] },
    });
    const [realBinPath, realWorkflowPath, realServiceRoot] = await Promise.all([
      realpath(binPath),
      realpath(workflowPath),
      realpath(serviceRoot),
    ]);

    expect(result).toMatchObject({ ok: true });
    expect(spawnProcess).toHaveBeenCalledWith(realBinPath, [
      realWorkflowPath,
      "--port",
      "4077",
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    ], expect.objectContaining({
      cwd: realServiceRoot,
      detached: false,
      stdio: "ignore",
      env: expect.objectContaining({
        LINEAR_API_KEY: "test-key",
        MATRIX_HOME: homePath,
      }),
    }));
  });

  it("spawns bare command names from the validated service root instead of PATH", async () => {
    const bareBinPath = join(serviceRoot, "symphony");
    await writeFile(bareBinPath, "#!/bin/sh\n");
    await chmod(bareBinPath, 0o755);
    const child = new FakeProcess();
    const spawnProcess = vi.fn(() => child as never);
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key", PATH: "/usr/bin" },
      spawnProcess,
    });

    const result = await runner.start({ serviceRoot, workflowPath, binPath: "symphony" });
    const [realBareBinPath, realServiceRoot] = await Promise.all([
      realpath(bareBinPath),
      realpath(serviceRoot),
    ]);

    expect(result).toMatchObject({ ok: true });
    expect(spawnProcess).toHaveBeenCalledWith(realBareBinPath, expect.any(Array), expect.objectContaining({
      cwd: realServiceRoot,
    }));
  });

  it("does not forward gateway-only secrets to the local runner", async () => {
    const child = new FakeProcess();
    const spawnProcess = vi.fn(() => child as never);
    const runner = createSymphonyRunner({
      homePath,
      env: {
        LINEAR_API_KEY: "linear-key",
        MATRIX_AUTH_TOKEN: "gateway-token",
        MATRIX_SESSION_SECRET: "future-secret",
        MATRIX_SYMPHONY_ENV_ALLOWLIST: "MATRIX_SESSION_SECRET",
        DATABASE_URL: "postgres://secret",
        PIPEDREAM_CLIENT_SECRET: "pipedream-secret",
        PATH: "/usr/bin",
      },
      spawnProcess,
    });

    await runner.start({ serviceRoot, workflowPath, binPath });

    expect(spawnProcess).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      env: expect.objectContaining({
        LINEAR_API_KEY: "linear-key",
        PATH: "/usr/bin",
      }),
    }));
    const env = spawnProcess.mock.calls[0]?.[2]?.env;
    expect(env).not.toHaveProperty("MATRIX_AUTH_TOKEN");
    expect(env).not.toHaveProperty("MATRIX_SESSION_SECRET");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("PIPEDREAM_CLIENT_SECRET");
    expect(env).toHaveProperty("MATRIX_HOME", homePath);
    expect(env).toHaveProperty("MATRIX_SYMPHONY_RUN_ID");
  });

  it("refuses to start from outside the allowed Symphony checkout roots", async () => {
    const spawnProcess = vi.fn();
    const outsideRoot = join(homePath, "tmp", "evil");
    const outsideBinPath = join(outsideRoot, "bin", "symphony");
    await mkdir(join(outsideRoot, "bin"), { recursive: true });
    await writeFile(outsideBinPath, "#!/bin/sh\n");
    await chmod(outsideBinPath, 0o755);
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess,
    });

    const result = await runner.start({
      serviceRoot: outsideRoot,
      workflowPath,
      binPath: "./bin/symphony",
    });

    expect(result).toMatchObject({ ok: false, code: "symphony_path_not_allowed" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("refuses symlinked runner roots that resolve outside allowed Symphony checkouts", async () => {
    const spawnProcess = vi.fn();
    const outsideRoot = join(homePath, "tmp", "evil");
    const outsideBinPath = join(outsideRoot, "bin", "symphony");
    const symlinkRoot = join(homePath, "code", "symphony", "linked");
    await mkdir(join(outsideRoot, "bin"), { recursive: true });
    await writeFile(outsideBinPath, "#!/bin/sh\n");
    await chmod(outsideBinPath, 0o755);
    await symlink(outsideRoot, symlinkRoot, "dir");
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess,
    });

    const result = await runner.start({
      serviceRoot: symlinkRoot,
      workflowPath,
      binPath: "./bin/symphony",
    });

    expect(result).toMatchObject({ ok: false, code: "symphony_path_not_allowed" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("refuses a non-executable runner binary", async () => {
    const spawnProcess = vi.fn();
    await chmod(binPath, 0o644);
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess,
    });

    const result = await runner.start({ serviceRoot, workflowPath, binPath });

    expect(result).toMatchObject({ ok: false, code: "symphony_not_installed" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("reports an immediate spawn failure instead of a running process", async () => {
    const child = new FakeProcess();
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => child.emit("error", new Error("spawn failed")));
        return child as never;
      }),
    });

    const result = await runner.start({ serviceRoot, workflowPath, binPath });

    expect(result).toMatchObject({ ok: false, code: "symphony_start_failed" });
    await expect(runner.status()).resolves.toMatchObject({ running: false });
  });

  it("coalesces concurrent start requests into one local process", async () => {
    const child = new FakeProcess();
    const spawnProcess = vi.fn(() => child as never);
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess,
    });

    const [first, second] = await Promise.all([
      runner.start({ serviceRoot, workflowPath, binPath }),
      runner.start({ serviceRoot, workflowPath, binPath }),
    ]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("stops the running local process on shutdown", async () => {
    const child = new FakeProcess();
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess: vi.fn(() => child as never),
    });
    await runner.start({ serviceRoot, workflowPath, binPath });

    const status = await runner.stop();

    expect(child.killed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.lastExitCode).toBe(0);
  });

  it("does not signal an already-exited process during stop", async () => {
    const child = new FakeProcess();
    const killSpy = vi.spyOn(child, "kill");
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess: vi.fn(() => child as never),
    });
    await runner.start({ serviceRoot, workflowPath, binPath });
    child.exitCode = 0;

    const status = await runner.stop();

    expect(killSpy).not.toHaveBeenCalled();
    expect(status.running).toBe(false);
    expect(status.lastExitCode).toBe(0);
  });

  it("reports the launch-time config while the runner is still running", async () => {
    const child = new FakeProcess();
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess: vi.fn(() => child as never),
    });
    await runner.start({ serviceRoot, workflowPath, binPath, port: 4077 });
    await runner.saveConfig({ port: 4088 });

    await expect(runner.status()).resolves.toMatchObject({
      running: true,
      dashboardUrl: "http://127.0.0.1:4077",
      config: { port: 4077 },
    });

    await runner.stop();
    await expect(runner.status()).resolves.toMatchObject({
      running: false,
      dashboardUrl: "http://127.0.0.1:4088",
      config: { port: 4088 },
    });
  });

  it("waits for an in-flight start before stopping", async () => {
    const child = new FakeProcess();
    const runner = createSymphonyRunner({
      homePath,
      env: { LINEAR_API_KEY: "test-key" },
      spawnProcess: vi.fn(() => child as never),
    });

    const startPromise = runner.start({ serviceRoot, workflowPath, binPath });
    const status = await runner.stop();
    await startPromise;

    expect(child.killed).toBe(true);
    expect(status.running).toBe(false);
  });
});
