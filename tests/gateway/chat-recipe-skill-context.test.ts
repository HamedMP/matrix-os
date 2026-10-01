import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatRunContextSchema, ResolvedChatAgentRecipeSchema } from "@matrix-os/contracts";
import { contextPrompt } from "../../packages/gateway/src/chat/agent-context.js";
import { createChatAgentRecipeResolver } from "../../packages/gateway/src/chat/agent-recipe.js";

const selected = { skills: ["resource-skill"], integrations: [], output: "Build a useful product" };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "matrix-recipe-resource-")));
  roots.push(root);
  const bundled = join(root, "bundled");
  const homePath = join(root, "home");
  await mkdir(bundled);
  await mkdir(homePath);
  return { root, bundled, homePath };
}
async function skill(path: string, body: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `---\nname: resource-skill\ndescription: Read lazy resource guidance.\nauthor: Matrix OS\n---\n${body}\n`);
}
function runContext(recipe: unknown) {
  return ChatRunContextSchema.parse({ version: 1, requestHash: "a".repeat(64), chats: [],
    agent: { id: "bot_12345678", revision: 1, name: "Product builder", instructions: "Build carefully.", recipe } });
}

describe("saved recipe lazy resource locations", () => {
  it("pins the validated bundled source through persistence and injects it without loading resources", async () => {
    const { bundled, homePath } = await fixture();
    const sourceFile = join(bundled, 'different "directory"', "SKILL.md");
    const body = "Read [the guide](references/layout.md) when needed.";
    await skill(sourceFile, body);
    await mkdir(join(bundled, 'different "directory"', "references"));
    await writeFile(join(bundled, 'different "directory"', "references/layout.md"), "Lazy detail remains outside the recipe.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, homePath, services: [] });
    const recipe = await resolver.resolve(selected);
    expect(recipe.skills[0]).toMatchObject({ sourceFile, instructions: body,
      sha256: createHash("sha256").update(body).digest("hex") });
    const persisted = runContext(JSON.parse(JSON.stringify(recipe)));
    const prompt = contextPrompt("Build from a separate project directory", persisted);
    expect(prompt).toContain(`Skill source file: ${JSON.stringify(sourceFile)}`);
    expect(prompt).toContain("Resolve relative resource links against this file's directory");
    expect(prompt).toContain("available authorized file-reading tools");
    expect(prompt).not.toContain("Lazy detail remains outside the recipe.");
    expect(JSON.stringify(await resolver.catalog())).not.toContain(sourceFile);
    await skill(sourceFile, "Future body.");
    await expect(resolver.revalidate(persisted.agent!.recipe!)).resolves.toBeUndefined();
    expect(contextPrompt("Build", persisted)).toContain(body);
  });

  it("uses the discovered owner directory instead of guessing the skill name or mirror path", async () => {
    const { bundled, homePath } = await fixture();
    const sourceFile = join(homePath, ".agents/skills/custom-folder/SKILL.md");
    await skill(sourceFile, "Read [details](details.md).");
    await mkdir(join(homePath, ".claude/skills"), { recursive: true });
    await symlink(join(homePath, ".agents/skills/custom-folder"), join(homePath, ".claude/skills/mirror"));
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, homePath, services: [] });
    expect((await resolver.resolve(selected)).skills[0]).toMatchObject({ sourceFile });
    expect(JSON.stringify(await resolver.catalog())).not.toContain(homePath);
  });

  it("retains the actual filename for legacy flat skills", async () => {
    const { bundled, homePath } = await fixture();
    const sourceFile = join(homePath, "agents/skills/custom-guide.md");
    await skill(sourceFile, "Read [legacy detail](legacy-detail.md).");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, homePath, services: [] });
    expect((await resolver.resolve(selected)).skills[0]).toMatchObject({ sourceFile });
  });

  it("keeps the existing 24KiB instruction limit independent of bounded source metadata", async () => {
    const { bundled } = await fixture();
    const sourceFile = join(bundled, "bounded", "SKILL.md");
    await skill(sourceFile, "x".repeat(24 * 1024));
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, services: [] });
    const recipe = await resolver.resolve(selected);
    expect(recipe.skills[0]?.instructions).toHaveLength(24 * 1024);
    expect(recipe.skills[0]?.sourceFile).toBe(sourceFile);
    for (const invalid of ["/" + "x".repeat(2048), "/skills/guide\nforged.md", "relative/guide.md", "/" + "ü".repeat(1100)]) {
      expect(ResolvedChatAgentRecipeSchema.safeParse({ ...recipe,
        skills: [{ ...recipe.skills[0], sourceFile: invalid }] }).success).toBe(false);
    }
    await skill(sourceFile, "x".repeat(24 * 1024 + 1));
    await expect(resolver.resolve(selected)).rejects.toMatchObject({ code: "recipe_unavailable" });
  });


  it("excludes a source pathname containing control characters from discovery", async () => {
    const { bundled } = await fixture();
    await skill(join(bundled, "forged\nlocation", "SKILL.md"), "Instructions.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: bundled, services: [] });
    expect((await resolver.catalog()).skills).toEqual([]);
    await expect(resolver.resolve(selected)).rejects.toMatchObject({ code: "recipe_unavailable" });
  });

  it("keeps legacy persisted snapshots usable without inventing a resource path", () => {
    const context = runContext({ ...selected, skills: [{ id: "resource-skill", name: "resource-skill",
      instructions: "Original pinned instructions.", sha256: "b".repeat(64) }] });
    const prompt = contextPrompt("Build", context);
    expect(prompt).toContain("Original pinned instructions.");
    expect(prompt).not.toContain("Skill source file:");
  });
});
