import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { resolveProxyDatabasePath } from "../../packages/proxy/src/db.js";
import {
  createSmokeCancellation,
  DOCKER_FULL_STACK_SERVICES,
  dockerFullStackCommands,
  installSmokeSignalHandlers,
  smokeDockerFullStack,
} from "../../scripts/dev-stack-smoke.mjs";

const root = resolve(import.meta.dirname, "../..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as Record<string, unknown>;
}

describe("local development contracts", () => {
  it("uses pnpm package filters for source dev under the global virtual store", () => {
    const pkg = readJson("package.json") as {
      scripts: Record<string, string>;
    };
    const shellPkg = readJson("shell/package.json") as { scripts: Record<string, string> };

    expect(pkg.scripts.dev).toContain("--filter '@matrix-os/gateway'");
    expect(pkg.scripts.dev).toContain("--filter '@matrix-os/proxy'");
    expect(pkg.scripts.dev).toContain("--filter './shell' dev");
    expect(pkg.scripts.dev).not.toContain("bun run --filter");
    for (const script of [
      "dev:kernel",
      "dev:gateway",
      "dev:shell",
      "dev:mobile-shell",
      "dev:proxy",
      "dev:platform",
    ]) {
      expect(pkg.scripts[script], script).not.toContain("bun run --filter");
    }
    expect(pkg.scripts["dev:shell"]).toContain("@matrix-os/brand");
    expect(pkg.scripts["dev:platform"]).toContain("@matrix-os/brand");
    expect(shellPkg.scripts.dev).toBe("next dev --webpack");
  });

  it("keeps the source proxy database usable without Docker-only directories", () => {
    expect(resolveProxyDatabasePath({})).toBe(":memory:");
    expect(resolveProxyDatabasePath({ PROXY_DB_PATH: "/data/proxy.db" })).toBe("/data/proxy.db");
  });

  it("wires Docker full-stack services to their documented environment source", () => {
    const compose = parse(readFileSync(resolve(root, "docker-compose.dev.yml"), "utf8")) as {
      services: Record<string, {
        depends_on?: Record<string, unknown>;
        env_file?: string[];
        environment?: string[];
        healthcheck?: { disable?: boolean; start_period?: string };
      }>;
    };
    const environment = (service: string) => compose.services[service]?.environment ?? [];

    expect(environment("dev")).not.toContain("ANTHROPIC_API_KEY=");
    expect(compose.services.proxy.env_file).toBeUndefined();
    expect(environment("proxy")).toContain("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}");
    expect(environment("platform")).toContain(
      "PLATFORM_DATABASE_URL=postgresql://matrixos:matrixos@postgres:5432/matrixos_platform",
    );
    expect(environment("platform").some((value) => value.startsWith("PLATFORM_DB_PATH="))).toBe(false);
    expect(compose.services.platform.depends_on).toHaveProperty("postgres");
    expect(compose.services.dev.healthcheck?.start_period).toBe("5m");
    expect(compose.services.conduit).toBeUndefined();
    const pkg = readJson("package.json") as { scripts: Record<string, string> };
    expect(pkg.scripts["docker:prepare"]).toBe("docker volume create matrixos-ai-auth");
    for (const script of ["docker", "docker:full", "docker:all", "docker:multi"]) {
      expect(pkg.scripts[script], script).toMatch(/^bun run docker:prepare && /);
    }
    expect(pkg.scripts["docker:full"]).toContain("--env-file .env.docker");
  });

  it("provides a bounded full-stack smoke with non-destructive cleanup", () => {
    expect(DOCKER_FULL_STACK_SERVICES).toEqual([
      "shell",
      "gateway",
      "proxy",
      "platform",
      "postgres",
      "minio",
    ]);
    expect(dockerFullStackCommands.start).toContain("up");
    expect(dockerFullStackCommands.prepare).toEqual([
      "docker",
      "volume",
      "create",
      "matrixos-ai-auth",
    ]);
    expect(dockerFullStackCommands.cleanup).toContain("down");
    expect(dockerFullStackCommands.cleanup).not.toContain("-v");
  });

  it("cancels health polling without allowing later signals to interrupt cleanup", () => {
    const killedWith: NodeJS.Signals[] = [];
    let cleanupInProgress = false;
    const cancellation = createSmokeCancellation(
      () => ({ kill: (signal: NodeJS.Signals) => killedWith.push(signal) }),
      () => cleanupInProgress,
    );

    cancellation.handleSignal("SIGINT");
    expect(cancellation.signal.aborted).toBe(true);
    expect(killedWith).toEqual(["SIGINT"]);

    cleanupInProgress = true;
    cancellation.handleSignal("SIGTERM");
    expect(killedWith).toEqual(["SIGINT"]);
  });

  it("cancels during health polling, cleans up once, and removes signal listeners", async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const signalTarget = {
      on(signal: NodeJS.Signals, listener: () => void) {
        listeners.set(signal, listener);
      },
      off(signal: NodeJS.Signals, listener: () => void) {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
    };
    let cleanupInProgress = false;
    const cancellation = createSmokeCancellation(
      () => undefined,
      () => cleanupInProgress,
    );
    const removeSignalHandlers = installSmokeSignalHandlers(signalTarget, cancellation);
    const commands: string[][] = [];
    let pollingStarted!: () => void;
    const enteredPolling = new Promise<void>((resolve) => {
      pollingStarted = resolve;
    });

    const smoke = smokeDockerFullStack({
      cancellationSignal: cancellation.signal,
      accessEnv: async () => undefined,
      runCommand: async (command: string, args: string[]) => {
        commands.push([command, ...args]);
        if (args.includes("down")) cleanupInProgress = true;
      },
      waitForServices: async (signal: AbortSignal) => {
        pollingStarted();
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      verifyDatabase: async () => undefined,
      log: () => undefined,
    }).finally(removeSignalHandlers);

    await enteredPolling;
    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();

    await expect(smoke).rejects.toThrow("smoke canceled by SIGINT");
    expect(commands.filter((command) => command.includes("down"))).toHaveLength(1);
    expect(commands.at(-1)).toEqual(dockerFullStackCommands.cleanup);
    expect(listeners.size).toBe(0);
  });
});
