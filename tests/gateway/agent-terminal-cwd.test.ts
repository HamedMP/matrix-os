import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTerminalCwd } from "../../packages/gateway/src/domains/sessions/agent-terminal-cwd.js";

describe("agentTerminalCwd", () => {
  let root: string;
  let home: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-terminal-cwd-"));
    home = join(root, "home");
    await mkdir(join(home, "projects", "my project"), { recursive: true });
    await mkdir(join(root, "home-other"));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("maps home to the empty Terminal cwd", async () => {
    expect(await agentTerminalCwd(home, home)).toBe("");
  });
  it("preserves nested directories and spaces", async () => {
    expect(await agentTerminalCwd(home, join(home, "projects", "my project"))).toBe("projects/my project");
  });
  it("handles a symlink alias for the configured home", async () => {
    const alias = join(root, "alias");
    await symlink(home, alias);
    expect(await agentTerminalCwd(alias, join(home, "projects"))).toBe("projects");
  });
  it("rejects a sibling with the same home prefix", async () => {
    await expect(agentTerminalCwd(home, join(root, "home-other"))).rejects.toThrow();
  });
  it("rejects a symlink escaping home", async () => {
    await symlink(join(root, "home-other"), join(home, "escape"));
    await expect(agentTerminalCwd(home, join(home, "escape"))).rejects.toThrow();
  });
  it("rejects missing directories", async () => {
    await expect(agentTerminalCwd(home, join(home, "missing"))).rejects.toThrow();
  });
});
