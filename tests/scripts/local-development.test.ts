import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { resolveProxyDatabasePath } from "../../packages/proxy/src/db.js";
import {
  DOCKER_FULL_STACK_SERVICES,
  dockerFullStackCommands,
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
    const pkg = readJson("package.json") as { scripts: Record<string, string> };
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
      "conduit",
    ]);
    expect(dockerFullStackCommands.start).toContain("up");
    expect(dockerFullStackCommands.cleanup).toContain("down");
    expect(dockerFullStackCommands.cleanup).not.toContain("-v");
  });
});
