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

  it("runs in the docs-only CI lane, because a skill edit changes only Markdown", async () => {
    const ci = await read(".github/workflows/ci.yml");
    const docsContractCommand = ci
      .split("\n")
      .find((line) => line.includes("pnpm exec vitest run tests/repository/site-extraction.test.ts"));
    expect(docsContractCommand).toContain("tests/platform/matrix-dev-plugin.test.ts");
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

  it("wrap-up cannot discard work that exists nowhere else", async () => {
    const wrapUp = await read(".agents/skills/wrap-up/SKILL.md");
    // Ignored files such as .env are invisible to `git status --short` and die with the worktree.
    expect(wrapUp).toContain("git -C <worktree> status --short --ignored");
    // A push can land between the tip check and the delete; both deletes are conditional on the merged commit.
    expect(wrapUp).toContain(
      "git push origin --delete <branch> --force-with-lease=<branch>:<headRefOid>",
    );
    expect(wrapUp).toContain("git update-ref -d refs/heads/<branch> <headRefOid>");
    expect(wrapUp).not.toMatch(/^\s*`?git push origin --delete <branch>`?\.?$/m);
    expect(wrapUp).not.toMatch(/then\s+`git branch -D/);
  });

  it("monitoring a PR never cleans up after it without a separate request", async () => {
    const monitor = await read(".agents/skills/worktree-pr-monitor/SKILL.md");
    expect(monitor).toContain("run it only when they ask");
    expect(monitor).not.toMatch(/After the merge\.\*\* Run the `wrap-up` skill/);
    expect(await read(".agents/skills/wrap-up/SKILL.md")).toContain(
      "is not a request to clean up after it",
    );
  });

  // The plugin can be invoked from any repository, where these skills would
  // otherwise run git/gh against the wrong repo or miss their scripts.
  it.each([
    ["release-platform", "platform-cloud-run.yml"],
    ["release-matrix-stable", "host-bundle-release.yml"],
  ])("%s refuses to run outside a Matrix OS checkout", async (name, workflowFile) => {
    const skill = await read(`.agents/skills/${name}/SKILL.md`);
    const guard = skill.indexOf('test "$(gh repo view --json nameWithOwner -q .nameWithOwner)" = "HamedMP/matrix-os"');
    expect(guard).toBeGreaterThan(-1);
    expect(skill).toContain(`test -f .github/workflows/${workflowFile}`);
    expect(guard).toBeLessThan(skill.indexOf("gh workflow run"));
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
        // Without this, every engineer clones the whole monorepo to read one folder.
        sparsePaths: ["dev"],
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
