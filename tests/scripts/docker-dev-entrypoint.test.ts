import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Docker development entrypoint dependency layout", () => {
  it("keeps the global virtual store for host worktrees", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");

    expect(workspace).toContain("enableGlobalVirtualStore: true");
  });

  it("uses a container-local virtual store for every Docker dependency install", () => {
    const entrypoint = readFileSync(
      join(root, "distro/docker-dev-entrypoint.sh"),
      "utf8",
    );
    const installCommands = entrypoint
      .split("\n")
      .filter((line) => line.includes("pnpm install --frozen-lockfile"));

    expect(installCommands.length).toBeGreaterThan(0);
    for (const command of installCommands) {
      expect(command).toContain("--config.enableGlobalVirtualStore=false");
    }
  });

  it("builds the brand workspace before starting the shell", () => {
    const entrypoint = readFileSync(
      join(root, "distro/docker-dev-entrypoint.sh"),
      "utf8",
    );
    const brandBuild = entrypoint.indexOf(
      "pnpm --filter @matrix-os/brand build",
    );
    const shellStart = entrypoint.indexOf(
      "pnpm --filter shell exec next dev --webpack -p 3000",
    );

    expect(brandBuild).toBeGreaterThan(-1);
    expect(shellStart).toBeGreaterThan(brandBuild);
  });

  it("starts the shell with the same bundler as the shell's own dev script", () => {
    const entrypoint = readFileSync(
      join(root, "distro/docker-dev-entrypoint.sh"),
      "utf8",
    );
    const shellPackage = JSON.parse(
      readFileSync(join(root, "shell/package.json"), "utf8"),
    ) as { scripts: { dev: string } };

    expect(shellPackage.scripts.dev).toContain("--webpack");
    expect(entrypoint).toContain("exec next dev --webpack -p 3000");
  });

  it("checks the lockfile hash with flags BusyBox md5sum supports", () => {
    const entrypoint = readFileSync(
      join(root, "distro/docker-dev-entrypoint.sh"),
      "utf8",
    );
    const md5Lines = entrypoint
      .split("\n")
      .filter((line) => line.includes("md5sum") && !line.trim().startsWith("#"));

    expect(md5Lines.length).toBeGreaterThan(0);
    for (const line of md5Lines) {
      expect(line).not.toContain("--status");
    }
    expect(entrypoint).toContain(
      "md5sum -c node_modules/.pnpm-lock-hash >/dev/null 2>&1",
    );
  });

  it("retries a failed dependency install only after the lockfile changes again", () => {
    const entrypoint = readFileSync(
      join(root, "distro/docker-dev-entrypoint.sh"),
      "utf8",
    );
    const watcher = entrypoint.slice(entrypoint.indexOf("failed_lock_hash=\"\""));

    expect(watcher).toContain('[ -n "$current_lock_hash" ] || continue');
    expect(watcher).toContain('[ "$current_lock_hash" = "$failed_lock_hash" ] && continue');
    expect(watcher).toMatch(/else\s+failed_lock_hash="\$current_lock_hash"/);
  });

  it("builds the terminal runtime before starting the gateway", () => {
    const fixture = mkdtempSync(join(tmpdir(), "matrix-entrypoint-"));
    const bin = join(fixture, "bin");
    const calls = join(fixture, "calls.log");
    mkdirSync(bin);

    for (const command of ["pnpm", "node"]) {
      const executable = join(bin, command);
      writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> "$CALL_LOG"\n`,
      );
      chmodSync(executable, 0o755);
    }

    const entrypoint = join(root, "distro/docker-dev-entrypoint.sh");
    const env = {
      ...process.env,
      CALL_LOG: calls,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };

    try {
      const prepare = spawnSync("bash", [entrypoint, "--prepare-gateway"], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      const launch = spawnSync("bash", [entrypoint, "--launch-gateway"], {
        cwd: root,
        env,
        encoding: "utf8",
      });

      expect(prepare.stderr).toBe("");
      expect(prepare.status).toBe(0);
      expect(launch.stderr).toBe("");
      expect(launch.status).toBe(0);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        "pnpm --filter @matrix-os/terminal-runtime build",
        "node --import=tsx --watch packages/gateway/src/main.ts",
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
