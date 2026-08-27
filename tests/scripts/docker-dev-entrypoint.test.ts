import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      "pnpm --filter shell exec next dev -p 3000",
    );

    expect(brandBuild).toBeGreaterThan(-1);
    expect(shellStart).toBeGreaterThan(brandBuild);
  });
});
