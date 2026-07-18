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

    expect(installCommands).toHaveLength(2);
    for (const command of installCommands) {
      expect(command).toContain("--config.enableGlobalVirtualStore=false");
    }
  });
});
