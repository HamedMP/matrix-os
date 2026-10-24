import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProxyDatabasePath } from "../../packages/proxy/src/db.js";
import { createLocalDevelopmentEnv, LOCAL_DEVELOPMENT_SERVICES, localInfrastructureCommands,
  startLocalDevelopment, startLocalInfrastructure } from "../../scripts/dev-local.mjs";
const root = process.cwd();
describe("source development lifecycle", () => {
  it("builds the gateway native addon before starting source services", async () => {
    const events: string[] = [];
    await expect(startLocalDevelopment({
      startInfrastructure: async () => undefined,
      runCommand: async (command: string, args: string[]) => { events.push([command, ...args].join(" ")); },
      startServices: () => {
        events.push("start-services");
        return { exited: Promise.resolve({ name: "fixture", pid: 123, code: 0 }), stop: async () => {} };
      },
      waitForHttp: async () => new Promise<void>(() => {}), log: () => {},
    })).rejects.toThrow(/stopped/);
    const native = events.indexOf("pnpm --filter @matrix-os/gateway build:native");
    expect(native).toBeGreaterThanOrEqual(0);
    expect(native).toBeLessThan(events.indexOf("start-services"));
  });

  it("keeps source infrastructure and package filters explicit", () => {
    expect(localInfrastructureCommands.start).toEqual([
      "docker",
      "compose",
      "-f",
      "docker-compose.dev.yml",
      "up",
      "--detach",
      "postgres",
      "minio",
    ]);
    expect(localInfrastructureCommands.configureObjectStore.at(-1)).toBe("minio-init");
    expect(localInfrastructureCommands.stop).toEqual([
      "docker",
      "compose",
      "-f",
      "docker-compose.dev.yml",
      "stop",
      "postgres",
      "minio",
    ]);
    expect(localInfrastructureCommands.stopApplicationContainers.slice(-4)).toEqual([
      "stop",
      "dev",
      "proxy",
      "platform",
    ]);
    expect(LOCAL_DEVELOPMENT_SERVICES).toEqual([
      "@matrix-os/gateway",
      "@matrix-os/proxy",
      "@matrix-os/platform",
      "./shell",
    ]);
  });

  it("gives host services deterministic local infrastructure and auth-bypass settings", () => {
    const env = createLocalDevelopmentEnv({ HOME: "/Users/dev", CUSTOM_VALUE: "kept", PORT: "9999" });

    expect(env).toMatchObject({
      CUSTOM_VALUE: "kept",
      MATRIX_HOME: "/Users/dev/matrixos",
      DATABASE_URL: "postgresql://matrixos:matrixos@127.0.0.1:5432/matrixos",
      PLATFORM_DATABASE_URL: "postgresql://matrixos:matrixos@127.0.0.1:5432/matrixos_platform",
      S3_ENDPOINT: "http://127.0.0.1:9100",
      S3_PUBLIC_ENDPOINT: "http://127.0.0.1:9100",
      S3_BUCKET: "matrixos-sync",
      S3_FORCE_PATH_STYLE: "true",
      E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_E2E_TEST_BYPASS: "1",
      MATRIX_AUTH_ALLOW_INSECURE_DEV: "1",
      MATRIX_BIND_HOST: "127.0.0.1",
      MATRIX_SELF_HOSTED: "0",
    });
    expect(env).not.toHaveProperty("PORT");
  });

  it("falls back to a valid development identity when MATRIX_HANDLE is blank", () => {
    const env = createLocalDevelopmentEnv({ HOME: "/Users/dev", MATRIX_HANDLE: "  " });

    expect(env.MATRIX_HANDLE).toBe("dev");
  });

  it("waits for long-running infrastructure before idempotent object-store setup", async () => {
    const events: string[] = [];
    const controller = new AbortController();

    await startLocalInfrastructure({
      cancellationSignal: controller.signal,
      runCommand: async (_command: string, args: string[]) => {
        events.push(args.at(-1) ?? "");
      },
      postgresReady: async () => {
        events.push("postgres-ready");
        return true;
      },
      waitForHttp: async () => {
        events.push("object-storage-ready");
      },
      log: () => undefined,
    });

    expect(events).toEqual([
      "minio",
      "object-storage-ready",
      "postgres-ready",
      "minio-alias",
      "minio-init",
    ]);
  });

  it("stops every source watcher when readiness fails", async () => {
    const stoppedWith: NodeJS.Signals[] = [];
    const events: string[] = [];

    await expect(startLocalDevelopment({
      startInfrastructure: async () => undefined,
      runCommand: async () => undefined,
      startServices: () => ({
        exited: new Promise<void>(() => undefined),
        stop: async (signal: NodeJS.Signals) => {
          stoppedWith.push(signal);
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push("watchers-stopped");
        },
      }),
      waitForHttp: async (_checks: unknown, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        throw new Error("port collision");
      },
      log: () => undefined,
    }).catch((error: unknown) => {
      events.push("rejected");
      throw error;
    })).rejects.toThrow("port collision");

    expect(stoppedWith).toEqual(["SIGTERM"]);
    expect(events).toEqual(["watchers-stopped", "rejected"]);
  });

  it("identifies a source service that exits cleanly during startup", async () => {
    await expect(startLocalDevelopment({
      startInfrastructure: async () => undefined,
      runCommand: async () => undefined,
      startServices: () => ({
        exited: Promise.resolve({ name: "proxy", pid: 123, code: 0, signal: null }),
        stop: async () => undefined,
      }),
      waitForHttp: async () => new Promise<void>(() => undefined),
      log: () => undefined,
    })).rejects.toThrow("proxy (pid 123) stopped before local development became ready");
  });

  it("owns process groups so watcher grandchildren cannot outlive a failed startup", () => {
    const orchestrator = readFileSync(resolve(root, "scripts/dev-local.mjs"), "utf8");

    expect(orchestrator).toContain('detached: process.platform !== "win32"');
    expect(orchestrator).toContain("process.kill(-child.pid, signal)");
    expect(orchestrator).toContain("spawn(process.execPath, service.args");
    expect(orchestrator).not.toContain('spawn("pnpm", ["--filter", service');
  });

  it("keeps the source proxy database usable without Docker-only directories", () => {
    expect(resolveProxyDatabasePath({})).toBe(":memory:");
    expect(resolveProxyDatabasePath({ PROXY_DB_PATH: "/data/proxy.db" })).toBe("/data/proxy.db");
  });

});
