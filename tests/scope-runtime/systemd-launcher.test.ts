import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFixedSystemdRunArgs,
  createSystemdScopeRuntimeLauncher,
  nextExecutionGeneration,
  type ScopeRuntimeCommandRunner,
} from "../../packages/scope-runtime/src/systemd-launcher.js";
import {
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "../../packages/scope-runtime/src/profile.js";

const RUNTIME_HANDLE = "runtime_22222222222222222222222222222222";
const SCOPE_HANDLE = "scope_11111111111111111111111111111111";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((remove) => remove()));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-scope-launcher-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sdkDirectory = join(root, "sdk");
  const nativeDirectory = join(root, "native");
  const workerFile = join(root, "worker.js");
  const brokerSocket = join(root, "broker.sock");
  const stateRoot = join(root, "state");
  await mkdir(sdkDirectory);
  await mkdir(nativeDirectory);
  await writeFile(join(sdkDirectory, "sdk.mjs"), "export {};\n");
  await writeFile(join(nativeDirectory, "claude"), "#!/bin/sh\nexit 0\n");
  await chmod(join(nativeDirectory, "claude"), 0o755);
  await writeFile(workerFile, "setInterval(() => {}, 1000);\n");
  const broker: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.listen(brokerSocket, resolve);
  });
  cleanup.push(() => new Promise<void>((resolve) => broker.close(() => resolve())));
  return { root, sdkDirectory, nativeDirectory, workerFile, brokerSocket, stateRoot, nodeBinary: process.execPath };
}

const launch = {
  runtimeHandle: RUNTIME_HANDLE,
  scopeHandle: SCOPE_HANDLE,
  workload: "chat_ai" as const,
  adapterId: "claude-code",
  harnessVersion: "2.1.240",
  executionGeneration: "7",
};

async function writeProvenance(
  stateRoot: string,
  suffix: string,
  overrides: Record<string, unknown> = {},
) {
  await writeFile(join(stateRoot, "runtimes", suffix, "provenance.json"), JSON.stringify({
    version: 1,
    runtimeHandle: `runtime_${suffix}`,
    profileId: SCOPE_RUNTIME_PROFILE_ID,
    profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
    profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
    workload: "chat_ai",
    adapterId: "claude-code",
    harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
    executionGeneration: "7",
    ...overrides,
  }));
}

describe("scope runtime systemd launcher", () => {
  it("builds only the source-controlled profile and fixed worker command", () => {
    const args = buildFixedSystemdRunArgs(launch, {
      scopeRoot: "/var/lib/matrix-scope-runtime/runtimes/222/root",
      sdkDirectory: "/opt/matrix/app/node_modules/sdk",
      nativeDirectory: "/opt/matrix/app/node_modules/native",
      workerFile: "/opt/matrix/app/packages/scope-runtime/dist/worker.js",
      brokerSocket: "/run/matrix-scope-runtime/broker.sock",
      readinessFile: "/var/lib/matrix-scope-runtime/runtimes/222/ready",
      nodeBinary: "/opt/matrix/runtime/node/bin/node",
    });

    expect(args).toContain("--property=DynamicUser=yes");
    expect(args).toContain("--property=PrivateUsers=yes");
    expect(args).toContain("--property=PrivateNetwork=yes");
    expect(args).toContain("--property=MemoryMax=1073741824");
    expect(args).toContain("--property=TasksMax=256");
    expect(args).toContain("--property=BindReadOnlyPaths=/usr/bin/env");
    expect(args).toContain("--property=BindPaths=/var/lib/matrix-scope-runtime/runtimes/222/ready:/run/matrix-scope-readiness/ready");
    expect(args).not.toContain("--collect");
    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      "/usr/bin/env",
      "-i",
      "HOME=/workspace",
      "PATH=/opt/matrix/runtime/node/bin",
      "MATRIX_SCOPE_RUNTIME=1",
      "/opt/matrix/runtime/node/bin/node",
      "/opt/matrix/scope-runtime/worker.mjs",
      RUNTIME_HANDLE,
      SCOPE_HANDLE,
      "chat_ai",
      "claude-code",
      "2.1.240",
    ]);
    expect(JSON.stringify(args)).not.toMatch(/OWNER_TOKEN|\/home\/matrix|\/run\/systemd\/private/);
  });

  it("prepares a private root, starts the fixed unit, reconciles handles, and cleans up on stop", async () => {
    const paths = await fixture();
    await mkdir(join(
      paths.stateRoot,
      "runtimes/33333333333333333333333333333333",
    ), { recursive: true });
    await writeFile(join(
      paths.stateRoot,
      "runtimes/33333333333333333333333333333333/ready",
    ), "runtime_33333333333333333333333333333333\n");
    await writeProvenance(paths.stateRoot, "33333333333333333333333333333333");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runCommand: ScopeRuntimeCommandRunner = vi.fn(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "list-units") {
        return { stdout: "matrix-scope-runtime-33333333333333333333333333333333.service loaded active running\n" };
      }
      if (command === "/usr/bin/systemd-run") {
        await writeFile(join(
          paths.stateRoot,
          "runtimes/22222222222222222222222222222222/ready",
        ), `${RUNTIME_HANDLE}\n`, { mode: 0o600 });
      }
      return { stdout: "active\n" };
    });
    const launcher = createSystemdScopeRuntimeLauncher({ ...paths, runCommand });

    await expect(launcher.list()).resolves.toEqual([{
      runtimeHandle: "runtime_33333333333333333333333333333333",
      executionGeneration: "7",
    }]);
    const previousUmask = process.umask(0o007);
    try {
      await expect(launcher.start(launch)).resolves.toBeUndefined();
    } finally {
      process.umask(previousUmask);
    }
    const runtimeRoot = join(paths.stateRoot, "runtimes", "22222222222222222222222222222222");
    const sandboxRoot = join(runtimeRoot, "root");
    expect((await stat(runtimeRoot)).mode & 0o777).toBe(0o700);
    for (const path of [
      sandboxRoot,
      join(sandboxRoot, "opt"),
      join(sandboxRoot, "opt/matrix/scope-runtime"),
      join(sandboxRoot, "run/matrix-scope"),
    ]) expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect((await stat(join(sandboxRoot, "run/matrix-scope-readiness"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(sandboxRoot, "run/matrix-scope-readiness/ready"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(runtimeRoot, "ready"))).mode & 0o777).toBe(0o622);
    expect(JSON.parse(await readFile(join(runtimeRoot, "provenance.json"), "utf8")))
      .toMatchObject({
        runtimeHandle: RUNTIME_HANDLE,
        profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
        harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
        executionGeneration: "7",
      });
    expect((await lstat(
      join(sandboxRoot, "opt/matrix/scope-runtime/worker.mjs"),
    )).isFile()).toBe(true);
    expect((await lstat(join(sandboxRoot, "usr/bin/env"))).isFile()).toBe(true);
    expect(calls.some((call) => call.command === "/usr/bin/systemd-run")).toBe(true);
    await expect(launcher.stop(RUNTIME_HANDLE)).resolves.toBeUndefined();
    expect(calls.some((call) => call.args.includes("matrix-scope-runtime-22222222222222222222222222222222.service")))
      .toBe(true);
  });

  it("allows bounded native activation latency and stops a submitted unit before failed-root cleanup", async () => {
    const delayed = await fixture();
    let delayedPolls = 0;
    const delayedRunner: ScopeRuntimeCommandRunner = vi.fn(async (_command, args) => {
      if (args[0]?.startsWith("--unit=")) {
        await writeFile(join(
          delayed.stateRoot,
          "runtimes/22222222222222222222222222222222/ready",
        ), `${RUNTIME_HANDLE}\n`, { mode: 0o600 });
      }
      if (args[0] === "is-active" && delayedPolls++ < 24) {
        throw Object.assign(new Error("activating"), { code: 3 });
      }
      return { stdout: "active\n" };
    });
    const delayedLauncher = createSystemdScopeRuntimeLauncher({ ...delayed, runCommand: delayedRunner });

    await expect(delayedLauncher.start(launch)).resolves.toBeUndefined();
    expect(delayedPolls).toBe(25);

    const failed = await fixture();
    const failedCalls: Array<{ command: string; args: readonly string[] }> = [];
    const failedRunner: ScopeRuntimeCommandRunner = vi.fn(async (command, args) => {
      failedCalls.push({ command, args });
      if (args[0] === "show") return { stdout: "Result=exit-code\nExecMainStatus=203\n" };
      if (args[0] === "is-active") {
        const error = new Error("inactive") as NodeJS.ErrnoException;
        error.code = 3;
        throw error;
      }
      return { stdout: "" };
    });
    const failedLauncher = createSystemdScopeRuntimeLauncher({ ...failed, runCommand: failedRunner });

    await expect(failedLauncher.start(launch)).rejects
      .toThrow(expect.objectContaining({ name: "ScopeRuntimeActivationStatus203Error" }));
    const stopIndex = failedCalls.findIndex((call) => call.args[0] === "stop");
    const resetIndex = failedCalls.findIndex((call) => call.args[0] === "reset-failed");
    expect(stopIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeGreaterThan(stopIndex);
  }, 20_000);

  it("does not report an active unit as running before the worker readiness marker exists", async () => {
    const paths = await fixture();
    let activePolls = 0;
    const runCommand: ScopeRuntimeCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "is-active") {
        activePolls += 1;
        if (activePolls < 3) return { stdout: "active\n" };
        throw Object.assign(new Error("failed"), { code: 3 });
      }
      if (args[0] === "show") return { stdout: "Result=exit-code\nExecMainStatus=1\n" };
      return { stdout: "" };
    });
    const launcher = createSystemdScopeRuntimeLauncher({ ...paths, runCommand });

    await expect(launcher.start(launch)).rejects
      .toThrow(expect.objectContaining({ name: "ScopeRuntimeActivationStatus1Error" }));
    expect(activePolls).toBe(3);
  });

  it("preserves a bounded worker failure class through its fixed exit status", async () => {
    const paths = await fixture();
    const runCommand: ScopeRuntimeCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "is-active") {
        throw Object.assign(new Error("failed"), { code: 3 });
      }
      if (args[0] === "show") return { stdout: "Result=exit-code\nExecMainStatus=80\n" };
      return { stdout: "" };
    });
    const launcher = createSystemdScopeRuntimeLauncher({ ...paths, runCommand });

    await expect(launcher.start(launch)).rejects
      .toThrow(expect.objectContaining({ name: "ScopeRuntimeBrokerError" }));
  });

  it("cleans non-active units and orphaned private roots during restart reconciliation", async () => {
    const paths = await fixture();
    const active = "33333333333333333333333333333333";
    const failed = "44444444444444444444444444444444";
    const activating = "55555555555555555555555555555555";
    const orphan = "66666666666666666666666666666666";
    const activeWithoutReadiness = "77777777777777777777777777777777";
    const activeWithStaleProvenance = "88888888888888888888888888888888";
    for (const suffix of [
      active, failed, activating, orphan, activeWithoutReadiness, activeWithStaleProvenance,
    ]) {
      await mkdir(join(paths.stateRoot, "runtimes", suffix), { recursive: true });
    }
    await writeFile(
      join(paths.stateRoot, "runtimes", active, "ready"),
      `runtime_${active}\n`,
    );
    await writeProvenance(paths.stateRoot, active);
    await writeFile(
      join(paths.stateRoot, "runtimes", activeWithStaleProvenance, "ready"),
      `runtime_${activeWithStaleProvenance}\n`,
    );
    await writeProvenance(paths.stateRoot, activeWithStaleProvenance, {
      profileDigest: "0".repeat(64),
    });
    const calls: Array<readonly string[]> = [];
    const runCommand: ScopeRuntimeCommandRunner = vi.fn(async (_command, args) => {
      calls.push(args);
      if (args[0] === "list-units") return { stdout: [
        `matrix-scope-runtime-${active}.service loaded active running`,
        `matrix-scope-runtime-${failed}.service loaded failed failed`,
        `matrix-scope-runtime-${activating}.service loaded activating start`,
        `matrix-scope-runtime-${activeWithoutReadiness}.service loaded active running`,
        `matrix-scope-runtime-${activeWithStaleProvenance}.service loaded active running`,
      ].join("\n") };
      return { stdout: "" };
    });
    const launcher = createSystemdScopeRuntimeLauncher({ ...paths, runCommand });

    await expect(launcher.list()).resolves.toEqual([{
      runtimeHandle: `runtime_${active}`,
      executionGeneration: "7",
    }]);
    expect(calls.some((args) => args[0] === "list-units" && args.includes("--all"))).toBe(true);
    for (const suffix of [failed, activating, activeWithoutReadiness, activeWithStaleProvenance]) {
      const unit = `matrix-scope-runtime-${suffix}.service`;
      expect(calls.some((args) => args[0] === "stop" && args[1] === unit)).toBe(true);
      expect(calls.some((args) => args[0] === "reset-failed" && args[1] === unit)).toBe(true);
    }
    await expect(stat(join(paths.stateRoot, "runtimes", failed))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.stateRoot, "runtimes", activating))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.stateRoot, "runtimes", orphan))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.stateRoot, "runtimes", activeWithoutReadiness)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.stateRoot, "runtimes", activeWithStaleProvenance)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.stateRoot, "runtimes", active))).resolves.toBeDefined();
  });

  it("increments a durable generation and refuses corrupt state", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-scope-generation-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "generation");

    await expect(nextExecutionGeneration(path)).resolves.toBe("1");
    await expect(nextExecutionGeneration(path)).resolves.toBe("2");
    await writeFile(path, "not-a-generation\n");
    await expect(nextExecutionGeneration(path)).rejects.toThrow("generation");
  });
});
