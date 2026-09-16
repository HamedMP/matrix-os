import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("discovers additional bundled skills instead of limiting recipes to two names", async () => {
    const root = await fixture();
    await writeSkill(root, "unlisted", "matrix-unlisted", "Unlisted", "Do not expose this directory.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: root, services });
    expect(await resolver.catalog()).toEqual({
      enabled: true,
      skills: [
        { id: "matrix-integrations", name: "Matrix Integrations", description: "Use Matrix integrations safely.", instructionBytes: 36 },
        { id: "matrix-personal-daily-brief", name: "Personal Daily Brief", description: "Prepare a personal daily brief.", instructionBytes: 29 },
        { id: "matrix-unlisted", name: "matrix-unlisted", description: "Unlisted", instructionBytes: 29 },
      ],
      services,
    });
  });

  it("discovers owner-installed and legacy skills, deduplicates mirrors, and refreshes after changes", async () => {
    const root = await fixture();
    const homePath = await mkdtemp(join(tmpdir(), "matrix-recipe-owner-"));
    roots.push(homePath);
    const canonical = join(homePath, ".agents/skills");
    const compatibility = join(homePath, ".claude/skills");
    await writeSkill(canonical, "review-folder", "code-review", "Review a pull request.", "Review changes and cite evidence.");
    await mkdir(compatibility, { recursive: true });
    await symlink(join(canonical, "review-folder"), join(compatibility, "review-mirror"));
    await mkdir(join(homePath, "agents/skills"), { recursive: true });
    await writeFile(join(homePath, "agents/skills/notes.md"), "---\nname: meeting-notes\ndescription: Prepare meeting notes.\n---\nSummarize decisions and action items.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: root, homePath, services });
    const catalogue = await resolver.catalog();
    expect(catalogue.skills.map((skill) => skill.id)).toEqual([
      "code-review", "matrix-integrations", "matrix-personal-daily-brief", "meeting-notes",
    ]);
    expect(JSON.stringify(catalogue)).not.toContain(homePath);
    expect(JSON.stringify(catalogue)).not.toContain("Review changes and cite evidence.");
    const selected = { skills: ["code-review", "meeting-notes"], integrations: [], output: "Review report" };
    const accepted = await resolver.resolve(selected);
    expect(accepted.skills.map((skill) => skill.instructions)).toEqual([
      "Review changes and cite evidence.", "Summarize decisions and action items.",
    ]);
    await writeSkill(canonical, "review-folder", "code-review", "Review a pull request.", "Updated instructions.");
    await expect(resolver.revalidate(accepted)).resolves.toBeUndefined();
    expect(accepted.skills[0]?.instructions).toBe("Review changes and cite evidence.");
    expect((await resolver.resolve(selected)).skills[0]?.instructions).toBe("Updated instructions.");
    await rm(join(canonical, "review-folder"), { recursive: true });
    expect((await resolver.catalog()).skills.some((skill) => skill.id === "code-review")).toBe(false);
    await expect(resolver.revalidate(accepted)).rejects.toMatchObject({ code: "recipe_unavailable" });
    await expect(resolver.resolve(selected)).rejects.toMatchObject({ code: "recipe_unavailable" });
  });

  it("isolates invalid installed entries and refuses links outside approved skill roots", async () => {
    const root = await fixture();
    const homePath = await mkdtemp(join(tmpdir(), "matrix-recipe-owner-"));
    roots.push(homePath);
    const canonical = join(homePath, ".agents/skills");
    await writeSkill(canonical, "healthy", "healthy-skill", "Usable skill.", "Usable instructions.");
    await writeSkill(canonical, "oversized", "oversized-skill", "Too big.", "x".repeat(40 * 1024));
    await writeSkill(homePath, "private", "private-skill", "Private file.", "Must stay outside the catalogue.");
    await symlink(join(homePath, "private"), join(canonical, "escaped"));
    await writeSkill(canonical, "malformed", "bad-skill", "Invalid", "");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: root, homePath, services });
    expect((await resolver.catalog()).skills.map((skill) => skill.id)).toEqual([
      "healthy-skill", "matrix-integrations", "matrix-personal-daily-brief",
    ]);
    await expect(resolver.resolve({ skills: ["private-skill"], integrations: [], output: "No escape" }))
      .rejects.toMatchObject({ code: "recipe_unavailable" });
  });

  it("summarizes long installed descriptions without dropping an otherwise usable skill", async () => {
    const root = await fixture();
    const homePath = await mkdtemp(join(tmpdir(), "matrix-recipe-owner-"));
    roots.push(homePath);
    await writeSkill(join(homePath, ".agents/skills"), "long-description", "detailed-review", "r".repeat(900), "Review the supplied plan.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: root, homePath, services });
    expect((await resolver.catalog()).skills.find((skill) => skill.id === "detailed-review"))
      .toMatchObject({ name: "detailed-review", description: "r".repeat(400) });
    expect((await resolver.resolve({ skills: ["detailed-review"], integrations: [], output: "Report" })).skills[0]?.instructions)
      .toBe("Review the supplied plan.");
  });

  it("keeps private paths and credential-shaped descriptions out of catalogue metadata", async () => {
    const root = await fixture();
    const homePath = await mkdtemp(join(tmpdir(), "matrix-recipe-owner-"));
    roots.push(homePath);
    await writeSkill(join(homePath, ".agents/skills"), "private-description", "private-description", "Read /Users/owner/private with token=example-secret", "Review user-supplied text.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: root, homePath, services });
    const catalogue = await resolver.catalog();
    expect(catalogue.skills.find((skill) => skill.id === "private-description")).toMatchObject({ description: "Installed skill." });
    expect(JSON.stringify(catalogue)).not.toMatch(/\/Users\/|example-secret/);
  });

  it("fails explicitly above the bounded catalogue size rather than returning an arbitrary subset", async () => {
    const root = await fixture();
    const homePath = await mkdtemp(join(tmpdir(), "matrix-recipe-owner-"));
    roots.push(homePath);
    for (let i = 0; i < 255; i++) await writeSkill(join(homePath, ".agents/skills"), `skill-${i}`, `installed-${i}`, "Installed workflow.", "Instructions.");
    const resolver = createChatAgentRecipeResolver({ skillsRoot: root, homePath, services });
    await expect(resolver.catalog()).rejects.toMatchObject({ code: "recipe_unavailable" });
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

it("ships explicit inbox and preceding-day query guidance in the canonical Daily Brief skill", async () => {
  const skill = await readFile("skills/matrix/personal-daily-brief/SKILL.md", "utf8");
  expect(skill).toContain('query: "in:inbox newer_than:1d"');
  expect(skill).toContain("maxResults: 30");
});
