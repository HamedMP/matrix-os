import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const pluginRoot = resolve(root, "plugins/matrix-os");

async function jsonFile(path: string) {
  return JSON.parse(await readFile(resolve(pluginRoot, path), "utf8")) as Record<string, unknown>;
}

describe("Matrix OS coding-agent plugin", () => {
  it("ships a manifest-linked portable and version-pinned MCP server", async () => {
    const manifest = await jsonFile(".codex-plugin/plugin.json");
    const mcp = await jsonFile(".mcp.json");

    expect(manifest).toMatchObject({
      name: "matrix-os",
      version: "0.3.0",
      mcpServers: "./.mcp.json",
    });
    expect(mcp).toEqual({
      mcpServers: {
        "matrix-remote-computer": {
          command: "npx",
          args: ["-y", "@finnaai/matrix@0.3.16", "mcp", "serve", "--profile", "cloud"],
        },
      },
    });
    const serialized = JSON.stringify(mcp);
    expect(serialized).not.toMatch(/Bearer |access[_-]?token|refresh[_-]?token|\/Users\/|\/home\//i);
  });

  it("teaches MCP-first remote execution while retaining a CLI fallback", async () => {
    const cloudRun = await readFile(resolve(pluginRoot, "skills/matrix-cloud-run/SKILL.md"), "utf8");
    const githubProject = await readFile(resolve(pluginRoot, "skills/matrix-github-project/SKILL.md"), "utf8");
    const onboarding = await readFile(resolve(pluginRoot, "skills/matrix-onboarding/SKILL.md"), "utf8");

    for (const skill of [cloudRun, githubProject, onboarding]) {
      expect(skill).toContain("list_computers");
      expect(skill).toContain("run_command");
      expect(skill).toContain("CLI fallback");
      expect(skill).not.toContain("Never create or use shell tabs");
    }
  });
});
