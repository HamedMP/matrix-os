import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSymphonyRunner } from "../../packages/gateway/src/symphony-runner.js";

class FakeProcess extends EventEmitter {
  pid = 12345;
  killed = false;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", signal === "SIGKILL" ? 137 : 0);
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

    expect(result).toMatchObject({ ok: true });
    expect(spawnProcess).toHaveBeenCalledWith("./bin/symphony", [
      workflowPath,
      "--port",
      "4077",
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    ], expect.objectContaining({
      cwd: serviceRoot,
      detached: false,
      stdio: "ignore",
      env: expect.objectContaining({
        LINEAR_API_KEY: "test-key",
        MATRIX_HOME: homePath,
      }),
    }));
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
});
