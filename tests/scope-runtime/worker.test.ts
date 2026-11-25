import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { connect, type Socket } from "node:net";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { describe, expect, it, vi } from "vitest";
import { buildWorkerBundle } from "./worker-bundles.js";
import {
  createSingleUseCommandSocketSlot,
  SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION,
  startCommandServer,
  parseScopeRuntimeWorkerArguments,
  parseScopeRuntimeChatRequest,
  prepareScopeRuntimeWorkerEnvironment,
  scrubScopeRuntimeWorkerEnvironment,
  scopeRuntimeWorkerFailureExitCode,
  scopeRuntimeWorkerFailureForExitCode,
  validateScopeRuntimeWorkerEnvironment,
  writeScopeRuntimeReadiness,
} from "../../packages/scope-runtime/src/worker.js";

const argumentsFixture = [
  "runtime_22222222222222222222222222222222",
  "scope_11111111111111111111111111111111",
  "chat_ai",
  "claude-code",
  "2.1.301",
  "7",
];
const execFileAsync = promisify(execFile);

describe("scope runtime worker boundary", () => {
  it("ships an Opus 5.5 compatible Claude binary matching the supervisor's exact harness pin", async () => {
    // The upstream rejects 2.1.240 for the owner's current Opus alias (minimum 2.1.280).
    const require = createRequire(import.meta.url);
    const sdk = require.resolve("@anthropic-ai/claude-agent-sdk");
    const native = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const sdkVersion = JSON.parse(await readFile(join(dirname(sdk), "package.json"), "utf8")).version;
    expect(SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION).toBe("2.1.301");
    expect(sdkVersion).toBe("0.3.301");
    const { stdout } = await execFileAsync(join(dirname(native), "claude"), ["--version"], { timeout: 10_000 });
    expect(stdout.trim()).toBe(`${SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION} (Claude Code)`);
  });

  it("lets the capability-free supervisor reach the Chat worker without accepting a foreign generation", async () => {
    const directory = await createUnixSocketTempDir();
    const socketPath = join(directory, "worker.sock");
    const slot = createSingleUseCommandSocketSlot<Socket>();
    const previousUmask = process.umask(0o077);
    let server: Awaited<ReturnType<typeof startCommandServer>> | undefined;
    try {
      server = await startCommandServer(parseScopeRuntimeWorkerArguments(argumentsFixture), slot, socketPath);
      // The supervisor has no CAP_DAC_OVERRIDE and does not share DynamicUser's UID.
      expect((await stat(socketPath)).mode & 0o777).toBe(0o666);
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect(socketPath);
        let output = "";
        socket.setEncoding("utf8");
        socket.setTimeout(2_000, () => socket.destroy(new Error("Worker did not reject stale generation")));
        socket.once("error", reject);
        socket.on("data", chunk => { output += chunk; });
        socket.once("close", () => resolve(output));
        socket.once("connect", () => socket.end(JSON.stringify({
          version: 1, type: "runtime.chat", runtimeHandle: argumentsFixture[0],
          executionGeneration: "999", model: "opus", prompt: "Must not execute",
        }) + "\n"));
      });
      expect(reply).toBe("");
    } finally {
      process.umask(previousUmask);
      slot.destroyActive();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("caps command sockets at one and drains the active socket on shutdown", () => {
    const slot = createSingleUseCommandSocketSlot<{ destroy(): void }>();
    let closeFirst = () => undefined;
    const first = { destroy: vi.fn() };
    const second = { destroy: vi.fn() };

    expect(slot.claim(first, (listener) => { closeFirst = listener; })).toBe(true);
    expect(slot.claim(second, () => undefined)).toBe(false);
    expect(second.destroy).toHaveBeenCalledOnce();
    slot.destroyActive();
    expect(first.destroy).toHaveBeenCalledOnce();

    closeFirst();
    expect(slot.claim(second, () => undefined)).toBe(false);
    expect(second.destroy).toHaveBeenCalledTimes(2);
  });

  it("ships as one file that imports only Node built-ins, as the single-file mount requires", async () => {
    const bundle = await buildWorkerBundle("packages/scope-runtime/src/worker.ts");
    try {
      expect(bundle.imports.length).toBeGreaterThan(0);
      expect(bundle.imports.every((specifier) => specifier.startsWith("node:"))).toBe(true);
      expect(bundle.inputs).toContain("packages/scope-runtime/src/inference-bridge.ts");
    } finally {
      await bundle.cleanup();
    }
  });

  it("accepts only the fixed proven adapter invocation", () => {
    expect(parseScopeRuntimeWorkerArguments(argumentsFixture)).toEqual({
      runtimeHandle: argumentsFixture[0],
      scopeHandle: argumentsFixture[1],
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.301",
      executionGeneration: "7",
    });
    expect(() => parseScopeRuntimeWorkerArguments([...argumentsFixture, "/bin/sh"]))
      .toThrow(expect.objectContaining({ name: "ScopeRuntimeInvocationError" }));
    expect(() => parseScopeRuntimeWorkerArguments([
      argumentsFixture[0]!, argumentsFixture[1]!, "terminal", "claude-code", "2.1.301", "7",
    ])).toThrow(expect.objectContaining({ name: "ScopeRuntimeInvocationError" }));

    expect(parseScopeRuntimeWorkerArguments([
      argumentsFixture[0]!, argumentsFixture[1]!, "chat_ai", "codex", "0.171.0", "7",
    ])).toEqual({
      runtimeHandle: argumentsFixture[0],
      scopeHandle: argumentsFixture[1],
      workload: "chat_ai",
      adapterId: "codex",
      harnessVersion: "0.171.0",
      executionGeneration: "7",
    });
    expect(() => parseScopeRuntimeWorkerArguments([
      argumentsFixture[0]!, argumentsFixture[1]!, "chat_ai", "codex", "0.155.0", "7",
    ])).toThrow(expect.objectContaining({ name: "ScopeRuntimeInvocationError" }));
  });

  it("accepts only one bounded Chat job for its exact runtime generation", () => {
    const invocation = parseScopeRuntimeWorkerArguments(argumentsFixture);
    expect(parseScopeRuntimeChatRequest({
      version: 1,
      type: "runtime.chat",
      runtimeHandle: argumentsFixture[0],
      executionGeneration: "7",
      model: "claude-opus-4-6",
      prompt: "Shared prompt",
    }, invocation)).toMatchObject({ model: "claude-opus-4-6", prompt: "Shared prompt" });
    for (const injected of [
      { executionGeneration: "8" },
      { ownerHome: "/home/matrix/home" },
      { prompt: "x".repeat(65 * 1024) },
    ]) {
      expect(() => parseScopeRuntimeChatRequest({
        version: 1,
        type: "runtime.chat",
        runtimeHandle: argumentsFixture[0],
        executionGeneration: "7",
        model: "claude-opus-4-6",
        prompt: "Shared prompt",
        ...injected,
      }, invocation)).toThrow(expect.objectContaining({ name: "ScopeRuntimeInvocationError" }));
    }
  });

  it("re-execs once with only the fixed environment before validating the boundary", () => {
    const inherited = {
      HOME: "/home/matrix/home",
      PATH: "/usr/local/bin:/usr/bin",
      MATRIX_AUTH_TOKEN: "owner-secret",
      INVOCATION_ID: "public-systemd-id",
    };
    const executable = "/opt/matrix/runtime/node/bin/node";
    const workerFile = "/opt/matrix/scope-runtime/worker.mjs";

    const first = prepareScopeRuntimeWorkerEnvironment(
      argumentsFixture,
      inherited,
      executable,
      workerFile,
    );
    expect(first).toEqual({
      reexec: {
        executable,
        arguments: [
          executable,
          workerFile,
          "--matrix-scope-fixed-environment",
          ...argumentsFixture,
        ],
        environment: {
          HOME: "/workspace",
          PATH: "/opt/matrix/runtime/node/bin",
          MATRIX_SCOPE_RUNTIME: "1",
        },
      },
    });
    expect(inherited).toHaveProperty("MATRIX_AUTH_TOKEN", "owner-secret");

    const fixedEnvironment = { ...first.reexec!.environment };
    expect(prepareScopeRuntimeWorkerEnvironment(
      first.reexec!.arguments.slice(2),
      fixedEnvironment,
      executable,
      workerFile,
    )).toEqual({ invocationArguments: argumentsFixture });
    expect(fixedEnvironment).toEqual(first.reexec!.environment);
  });

  it("removes inherited credentials at the OS process boundary", async () => {
    const bundle = await buildWorkerBundle("packages/scope-runtime/src/worker.ts");
    try {
      await expect(execFileAsync(process.execPath, [bundle.outfile, ...argumentsFixture], {
        env: { ...process.env, MATRIX_AUTH_TOKEN: "owner-secret" },
        timeout: 5_000,
      })).rejects.toMatchObject({
        code: 85,
      });
    } finally {
      await bundle.cleanup();
    }
  });

  it("keeps the ready worker alive until the supervisor signals shutdown", async () => {
    await expect(execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      'import { waitForScopeRuntimeShutdown } from "./packages/scope-runtime/src/worker-common.ts";'
        + 'process.stdout.write("ready\\n"); await waitForScopeRuntimeShutdown();',
    ], {
      cwd: process.cwd(),
      timeout: 250,
      killSignal: "SIGKILL",
    })).rejects.toMatchObject({ killed: true, signal: "SIGKILL" });
  });

  it("requires the minimal fixed environment and rejects inherited credentials", () => {
    const safe = {
      HOME: "/workspace",
      PATH: "/opt/matrix/runtime/node/bin",
      MATRIX_SCOPE_RUNTIME: "1",
      INVOCATION_ID: "public-systemd-id",
    };
    expect(validateScopeRuntimeWorkerEnvironment(safe)).toEqual(safe);
    for (const injected of [
      { ANTHROPIC_API_KEY: "secret" },
      { MATRIX_AUTH_TOKEN: "secret" },
      { DATABASE_URL: "postgres://owner" },
    ]) {
      expect(() => validateScopeRuntimeWorkerEnvironment({ ...safe, ...injected }))
        .toThrow(expect.objectContaining({ name: "ScopeRuntimeEnvironmentKeyError" }));
    }
    expect(() => validateScopeRuntimeWorkerEnvironment({ ...safe, HOME: "/home/matrix/home" }))
      .toThrow(expect.objectContaining({ name: "ScopeRuntimeEnvironmentFixedError" }));
    const oversized = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, "value"]));
    expect(() => validateScopeRuntimeWorkerEnvironment({ ...safe, ...oversized }))
      .toThrow(expect.objectContaining({ name: "ScopeRuntimeEnvironmentCapacityError" }));
  });

  it("scrubs inherited entries before any workload code can observe them", () => {
    const inherited = {
      HOME: "/workspace",
      PATH: "/opt/matrix/runtime/node/bin",
      MATRIX_SCOPE_RUNTIME: "1",
      INVOCATION_ID: "public-systemd-id",
      MATRIX_AUTH_TOKEN: "owner-secret",
      OVERSIZED_INHERITED_VALUE: "x".repeat(9_000),
      ["K".repeat(300)]: "discarded-before-validation",
    };

    expect(scrubScopeRuntimeWorkerEnvironment(inherited)).toEqual({
      HOME: "/workspace",
      PATH: "/opt/matrix/runtime/node/bin",
      MATRIX_SCOPE_RUNTIME: "1",
    });
    expect(inherited).toEqual({
      HOME: "/workspace",
      PATH: "/opt/matrix/runtime/node/bin",
      MATRIX_SCOPE_RUNTIME: "1",
    });
  });

  it("publishes through only the supervisor-created readiness marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-scope-worker-ready-"));
    try {
      const marker = join(directory, "ready");
      await writeFile(marker, "", { flag: "wx", mode: 0o622 });
      await chmod(marker, 0o622);
      await writeScopeRuntimeReadiness(argumentsFixture[0]!, directory);
      expect(await readFile(marker, "utf8")).toBe(`${argumentsFixture[0]}\n`);
      expect((await stat(marker)).mode & 0o777).toBe(0o622);
      await rm(marker);
      await expect(writeScopeRuntimeReadiness(argumentsFixture[0]!, directory)).rejects
        .toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps allowlisted worker failure classes to bounded process exit codes", () => {
    expect(scopeRuntimeWorkerFailureExitCode(Object.assign(new Error("raw path"), {
      name: "ScopeRuntimeBrokerError",
    }))).toBe(80);
    expect(scopeRuntimeWorkerFailureExitCode(Object.assign(new Error("readiness failed"), {
      name: "ScopeRuntimeReadinessError",
    }))).toBe(88);
    expect(scopeRuntimeWorkerFailureForExitCode(13)).toBeUndefined();
    expect(scopeRuntimeWorkerFailureExitCode(new Error("raw unknown message"))).toBe(89);
  });
});
