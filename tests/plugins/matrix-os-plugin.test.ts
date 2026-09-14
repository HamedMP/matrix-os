import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const pluginRoot = resolve(root, "plugins/matrix-os");

async function jsonFile(path: string) {
  return JSON.parse(await readFile(resolve(pluginRoot, path), "utf8")) as Record<string, unknown>;
}

describe("Matrix OS coding-agent plugin", () => {
  it("exposes the same plugin through Codex and Claude marketplaces", async () => {
    const codex = await jsonFile(".codex-plugin/plugin.json");
    const claude = await jsonFile(".claude-plugin/plugin.json");
    expect(claude).toMatchObject({
      name: codex.name,
      version: codex.version,
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    });
    expect(claude).not.toHaveProperty("interface");
    const catalog = JSON.parse(await readFile(resolve(root, ".claude-plugin/marketplace.json"), "utf8"));
    expect(catalog).toMatchObject({
      name: "matrix-os",
      owner: { name: "Matrix OS" },
      plugins: [{ name: "matrix-os", source: "./plugins/matrix-os" }],
    });
    const codexCatalog = JSON.parse(await readFile(resolve(root, ".agents/plugins/marketplace.json"), "utf8"));
    expect(codexCatalog.plugins[0].source.path).toBe(catalog.plugins[0].source);
  });

  it("ships a manifest-linked hosted HTTP MCP server without local credentials", async () => {
    const manifest = await jsonFile(".codex-plugin/plugin.json");
    const mcp = await jsonFile(".mcp.json");

    expect(manifest).toMatchObject({
      name: "matrix-os",
      version: "0.4.0",
      mcpServers: "./.mcp.json",
    });
    expect(mcp).toEqual({
      mcpServers: {
        "matrix-remote-computer": {
          type: "http",
          url: "https://api.matrix-os.com/mcp",
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
