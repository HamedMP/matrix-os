import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createChatAgentRecipeResolver,
  discoverChatAgentRecipeSkillsRoot,
} from "../../packages/gateway/src/chat/agent-recipe.js";

const services = [
  { id: "gmail", name: "Gmail" },
  { id: "google_calendar", name: "Google Calendar" },
];
const recipe = {
  skills: ["matrix-personal-daily-brief", "matrix-integrations"] as const,
  integrations: [{ service: "gmail" }, { service: "google_calendar", accountLabel: "Work" }],
  output: "English daily brief with source links",
};

async function writeSkill(root: string, directory: string, name: string, description: string, instructions: string) {
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, directory, "SKILL.md"), [
    "---", `name: ${name}`, `description: ${description}`, "author: Matrix OS", "---", "", instructions, "",
  ].join("\n"));
}

describe("server-catalogued Chat Agent recipes", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "matrix-recipe-skills-"));
    roots.push(root);
    await writeSkill(root, "personal-daily-brief", "matrix-personal-daily-brief", "Prepare a personal daily brief.", "Read-only brief instructions.");
    await writeSkill(root, "integrations", "matrix-integrations", "Use Matrix integrations safely.", "Use Matrix integration tools safely.");
    return root;
  }

  it("catalogues only fixed bundled skills and public service labels", async () => {
    const root = await fixture();
    await writeSkill(root, "unlisted", "matrix-unlisted", "Unlisted", "Do not expose this directory.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: root, services });
    expect(await resolver.catalog()).toEqual({
      enabled: true,
      skills: [
        { id: "matrix-integrations", name: "Matrix Integrations", description: "Use Matrix integrations safely." },
        { id: "matrix-personal-daily-brief", name: "Personal Daily Brief", description: "Prepare a personal daily brief." },
      ],
      services,
    });
  });

  it("pins bounded skill instructions and hashes while keeping client dependencies explicit", async () => {
    const root = await fixture();
    const resolver = createChatAgentRecipeResolver({ skillsRoot: root, services });
    const resolved = await resolver.resolve(recipe);
    expect(resolved).toMatchObject({
      skills: [
        { id: "matrix-personal-daily-brief", name: "Personal Daily Brief", instructions: "Read-only brief instructions." },
        { id: "matrix-integrations", name: "Matrix Integrations", instructions: "Use Matrix integration tools safely." },
      ],
      integrations: recipe.integrations,
      output: recipe.output,
    });
    expect(resolved.skills.every((skill) => /^[a-f0-9]{64}$/.test(skill.sha256))).toBe(true);
    await writeSkill(root, "personal-daily-brief", "matrix-personal-daily-brief", "Prepare a personal daily brief.", "Edited future instructions.");
    await expect(resolver.revalidate(resolved)).resolves.toBeUndefined();
    expect(resolved.skills[0]?.instructions).toBe("Read-only brief instructions.");
    expect((await resolver.resolve(recipe)).skills[0]?.instructions).toBe("Edited future instructions.");
    await writeSkill(root, "personal-daily-brief", "matrix-personal-daily-brief", "Prepare a personal daily brief.", "x".repeat(40 * 1024));
    await expect(resolver.revalidate(resolved)).resolves.toBeUndefined();
  });

  it("rejects missing skills, unknown services, oversized bodies and symlinked files", async () => {
    const root = await fixture();
    const resolver = createChatAgentRecipeResolver({ skillsRoot: root, services });
    await expect(resolver.resolve({ ...recipe, integrations: [{ service: "not_installed" }] }))
      .rejects.toMatchObject({ code: "recipe_unavailable" });
    await rm(join(root, "personal-daily-brief", "SKILL.md"));
    await expect(resolver.resolve(recipe)).rejects.toMatchObject({ code: "recipe_unavailable" });

    await writeSkill(root, "personal-daily-brief", "matrix-personal-daily-brief", "Prepare a personal daily brief.", "x".repeat(24 * 1024));
    await expect(resolver.resolve(recipe)).rejects.toMatchObject({ code: "recipe_unavailable" });

    const external = join(root, "outside.md");
    await writeFile(external, "---\nname: matrix-personal-daily-brief\ndescription: Forged\n---\nforged");
    await rm(join(root, "personal-daily-brief", "SKILL.md"));
    await symlink(external, join(root, "personal-daily-brief", "SKILL.md"));
    await expect(resolver.resolve(recipe)).rejects.toMatchObject({ code: "recipe_unavailable" });
  });

  it("discovers both repository-source and installed host-bundle skill roots", async () => {
    const source = await mkdtemp(join(tmpdir(), "matrix-recipe-source-"));
    const bundle = await mkdtemp(join(tmpdir(), "matrix-recipe-bundle-"));
    roots.push(source, bundle);
    await mkdir(join(source, "skills/matrix"), { recursive: true });
    await mkdir(join(bundle, "skills/matrix"), { recursive: true });
    await expect(discoverChatAgentRecipeSkillsRoot({
      moduleUrl: pathToFileURL(join(source, "packages/gateway/src/chat/agent-recipe.ts")).href,
    })).resolves.toBe(join(source, "skills/matrix"));
    await expect(discoverChatAgentRecipeSkillsRoot({
      moduleUrl: pathToFileURL(join(bundle, "packages/gateway/dist/chat/agent-recipe.js")).href,
    })).resolves.toBe(join(bundle, "skills/matrix"));
  });
});
