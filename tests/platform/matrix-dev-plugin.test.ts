import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MATRIX_DEV_SKILLS,
  findDrift,
} from "../../scripts/dev/sync-matrix-dev-plugin.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFile(resolve(repoRoot, path), "utf8");
const readJson = async (path: string) => JSON.parse(await read(path));

// Engineers install the matrix-dev plugin and it updates itself from `main`.
// These tests catch a plugin that would ship stale or missing skills, and
// settings that would stop the update from reaching them.
describe("matrix-dev plugin", () => {
  it("ships exactly the canonical skills, byte for byte", async () => {
    expect(await findDrift()).toEqual([]);
  });

  it.each(MATRIX_DEV_SKILLS)("%s is one skill for Codex, Claude Code, and the plugin", async (name) => {
    const skill = await read(`.agents/skills/${name}/SKILL.md`);
    expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    // Arguments reach a skill as text; the placeholder is only filled for Claude Code commands.
    expect(skill).not.toContain("$ARGUMENTS");

    const link = resolve(repoRoot, `.claude/skills/${name}`);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(`../../.agents/skills/${name}`);

    // A second copy in .claude/commands would drift from the skill.
    await expect(lstat(resolve(repoRoot, `.claude/commands/${name}.md`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("is listed in a dev marketplace that customers do not see", async () => {
    const marketplace = await readJson("dev/.claude-plugin/marketplace.json");
    expect(marketplace.name).toBe("matrix-os-dev");
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "matrix-dev", source: "./matrix-dev" }),
    ]);

    const customerMarketplace = await readJson(".claude-plugin/marketplace.json");
    expect(customerMarketplace.plugins.map((plugin: { name: string }) => plugin.name)).not.toContain(
      "matrix-dev",
    );
  });

  it("tracks commits instead of a version, so every merged skill change reaches installs", async () => {
    const manifest = await readJson("dev/matrix-dev/.claude-plugin/plugin.json");
    expect(manifest.name).toBe("matrix-dev");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest).not.toHaveProperty("version");
    const marketplace = await readJson("dev/.claude-plugin/marketplace.json");
    expect(marketplace.plugins[0]).not.toHaveProperty("version");
  });

  it("is registered for this repository with auto-update on", async () => {
    const settings = await readJson(".claude/settings.json");
    expect(settings.extraKnownMarketplaces["matrix-os-dev"]).toEqual({
      source: {
        source: "github",
        repo: "HamedMP/matrix-os",
        path: "dev/.claude-plugin/marketplace.json",
      },
      autoUpdate: true,
    });
    // In this repository the skills already load from .claude/skills; enabling
    // the plugin here as well would list every skill twice.
    expect(settings.enabledPlugins ?? {}).not.toHaveProperty("matrix-dev@matrix-os-dev");
  });

  it("is offered to Codex from the developer marketplace", async () => {
    const marketplace = await readJson(".codex/dev-marketplace/.agents/plugins/marketplace.json");
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        name: "matrix-dev",
        source: expect.objectContaining({ source: "git-subdir", path: "dev/matrix-dev" }),
      }),
    );
    const manifest = await readJson("dev/matrix-dev/.codex-plugin/plugin.json");
    expect(manifest).toMatchObject({ name: "matrix-dev", skills: "./skills/" });
  });
});
