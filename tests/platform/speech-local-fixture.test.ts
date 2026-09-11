import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertFixturePortsAvailable,
  completeLocalSpeechFixtureCleanup,
  createLocalSpeechFixturePlan,
  LocalFixtureSignalController,
  parseLocalPostgresAdminUrl,
} from "../../scripts/lib/platform-speech-local-fixture.js";

describe("local speech fixture planning", () => {
  it("creates an isolated disposable database, runtime, home and credential set", () => {
    const randomValues = [
      "a".repeat(24),
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      "e".repeat(64),
    ];
    const plan = createLocalSpeechFixturePlan({
      adminUrl: "postgresql://fixture:local-only@127.0.0.1:5432/postgres",
      randomHex: () => randomValues.shift()!,
      temporaryRoot: "/tmp",
    });

    expect(plan.databaseName).toBe(`matrixos_speech_fixture_test_${"a".repeat(24)}`);
    expect(plan.databaseRole).toBe(`matrixos_speech_fixture_test_role_${"a".repeat(24)}`);
    expect(plan.databasePassword).toBe("b".repeat(64));
    expect(new URL(plan.databaseUrl).pathname).toBe(`/${plan.databaseName}`);
    expect(new URL(plan.databaseUrl).username).toBe(plan.databaseRole);
    expect(new URL(plan.databaseUrl).password).toBe(plan.databasePassword);
    expect(plan.ownerDatabaseName).toBe(`${plan.databaseName}_owner`);
    expect(new URL(plan.ownerDatabaseUrl).pathname).toBe(`/${plan.ownerDatabaseName}`);
    expect(plan.ownerDatabaseUrl).not.toBe(plan.databaseUrl);
    expect(plan.homePath).toBe(`/tmp/${plan.databaseName}-home`);
    expect(plan.env).toMatchObject({
      NODE_ENV: "development",
      PLATFORM_RUNTIME_MODE: "local",
      PLATFORM_DATABASE_URL: plan.databaseUrl,
      DATABASE_URL: plan.ownerDatabaseUrl,
      PLATFORM_PORT: "9117",
      MATRIX_SPEECH_GATEWAY_PORT: "4117",
      MATRIX_SPEECH_SHELL_PORT: "3117",
      PLATFORM_INTERNAL_URL: "http://127.0.0.1:9117",
      GATEWAY_URL: "http://127.0.0.1:4117",
      NEXT_PUBLIC_GATEWAY_WS: "ws://127.0.0.1:4117/ws",
      MATRIX_PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_PROVIDER: "fixture",
      PLATFORM_SPEECH_FIXTURE_TRANSCRIPT: "Deterministic local speech fixture transcript",
      PLATFORM_SPEECH_OPENAI_API_KEY: "",
      MATRIX_HOME: plan.homePath,
      E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_E2E_AUTHENTICATE_WS: "1",
    });
    expect(plan.env.PLATFORM_SECRET).toHaveLength(64);
    expect(plan.env.PLATFORM_SPEECH_SECRET).toHaveLength(64);
    expect(plan.env.MATRIX_AUTH_TOKEN).toHaveLength(64);
    expect(new Set([
      plan.databasePassword,
      plan.env.PLATFORM_SECRET,
      plan.env.PLATFORM_SPEECH_SECRET,
      plan.env.MATRIX_AUTH_TOKEN,
    ])).toHaveLength(4);
    expect(plan.env.MATRIX_FUNDED_AI_RUNTIME_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects non-loopback PostgreSQL admin URLs before any connection", () => {
    expect(() => parseLocalPostgresAdminUrl("postgresql://fixture@db.example.com/postgres"))
      .toThrow("must use a loopback PostgreSQL host");
    expect(() => parseLocalPostgresAdminUrl("https://127.0.0.1/postgres"))
      .toThrow("must be a PostgreSQL URL");
  });

  it("rejects invalid fixture ports before attempting to bind", async () => {
    await expect(assertFixturePortsAvailable([1_023])).rejects.toThrow("must be unprivileged TCP ports");
  });

  it("returns failure and attempts every cleanup step when cleanup is incomplete", async () => {
    const completed: string[] = [];
    const report = vi.fn();
    const result = await completeLocalSpeechFixtureCleanup(0, [
      { label: "runtime", run: async () => { completed.push("runtime"); } },
      { label: "platform database", run: async () => { throw new Error("disposable failure"); } },
      { label: "role", run: async () => { completed.push("role"); } },
    ], report);

    expect(result).toBe(1);
    expect(completed).toEqual(["runtime", "role"]);
    expect(report).toHaveBeenCalledWith("Local speech fixture cleanup failed safely: platform database");
  });

  it("terminates an owned pre-stack subprocess group and preserves the signal exit code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-speech-fixture-signal-"));
    const script = join(directory, "child.mjs");
    const pidsPath = join(directory, "pids.json");
    await writeFile(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[2], JSON.stringify([process.pid, descendant.pid]));
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, [script, pidsPath], { detached: true, stdio: "ignore" });
    const controller = new LocalFixtureSignalController();
    controller.attach(child);
    try {
      const deadline = Date.now() + 5_000;
      let pids: number[] | undefined;
      while (!pids && Date.now() < deadline) {
        try {
          pids = JSON.parse(await readFile(pidsPath, "utf8")) as number[];
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!pids) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(pids).toHaveLength(2);
      controller.receive("SIGTERM");
      expect(controller.exitCode).toBe(143);
      await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
      const isAlive = (pid: number) => {
        try { process.kill(pid, 0); return true; }
        catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      };
      let stillAlive = pids!.filter(isAlive);
      const exitDeadline = Date.now() + 5_000;
      while (stillAlive.length > 0 && Date.now() < exitDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        stillAlive = pids!.filter(isAlive);
      }
      expect(stillAlive).toEqual([]);
    } finally {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
