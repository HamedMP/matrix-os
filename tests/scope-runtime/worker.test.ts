import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  parseScopeRuntimeWorkerArguments,
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
  "2.1.240",
];
const execFileAsync = promisify(execFile);

describe("scope runtime worker boundary", () => {
  it("is a standalone entrypoint inside the minimal root", async () => {
    const source = await readFile("packages/scope-runtime/src/worker.ts", "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1]);

    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
  });

  it("accepts only the fixed proven adapter invocation", () => {
    expect(parseScopeRuntimeWorkerArguments(argumentsFixture)).toEqual({
      runtimeHandle: argumentsFixture[0],
      scopeHandle: argumentsFixture[1],
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    });
    expect(() => parseScopeRuntimeWorkerArguments([...argumentsFixture, "/bin/sh"]))
      .toThrow(expect.objectContaining({ name: "ScopeRuntimeInvocationError" }));
    expect(() => parseScopeRuntimeWorkerArguments([
      argumentsFixture[0]!, argumentsFixture[1]!, "terminal", "claude-code", "2.1.240",
    ])).toThrow(expect.objectContaining({ name: "ScopeRuntimeInvocationError" }));
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
    await expect(execFileAsync(process.execPath, [
      "packages/scope-runtime/src/worker.ts",
      ...argumentsFixture,
    ], {
      env: { ...process.env, MATRIX_AUTH_TOKEN: "owner-secret" },
      timeout: 5_000,
    })).rejects.toMatchObject({
      code: 85,
    });
  });

  it("keeps the ready worker alive until the supervisor signals shutdown", async () => {
    await expect(execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      'import { waitForScopeRuntimeShutdown } from "./packages/scope-runtime/src/worker.ts";'
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
