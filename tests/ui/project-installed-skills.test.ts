import { describe, expect, it } from "vitest";
import { copyProjectSkill } from "../../packages/ui/src/chat/project-skill-file";
import {
  parseProjectInstalledSkills,
  projectInstalledSkillFilePath,
} from "../../packages/ui/src/chat/project-installed-skills";

describe("project installed skill sources", () => {
  it("lists only enabled skill manifests from the existing install locations", () => {
    const skill = (name: string, file: string, enabled = true) => ({ name, file, enabled, description: " A skill " });
    const allowed = [
      skill("Git release", ".agents/skills/git-release/SKILL.md"),
      skill("Review", ".claude/skills/review/SKILL.md"),
      skill(" Legacy ", "agents/skills/legacy.md"),
    ];
    expect(parseProjectInstalledSkills([
      ...allowed,
      skill("Disabled", ".agents/skills/disabled/SKILL.md", false),
      skill("Foreign", "projects/foreign/.agents/skills/foreign/SKILL.md"),
      skill("Encoded", ".agents/skills/%2E%2E/SKILL.md"),
      skill("Traversal", ".claude/skills/../SKILL.md"),
      skill("Other file", ".agents/skills/review/README.md"),
      skill("Absolute", "/.agents/skills/review/SKILL.md"),
      skill("Duplicate path", allowed[0].file),
    ])).toEqual(allowed.map(({ name, file }) => ({ name, file, description: "A skill" })));
  });

  it("checks the source again when building the manifest request", () => {
    expect(projectInstalledSkillFilePath("agents/skills/legacy.md")).toBe("/api/settings/skills/manifest?path=agents%2Fskills%2Flegacy.md");
    expect(projectInstalledSkillFilePath(".agents/skills/test\\other/SKILL.md")).toBeNull();
    expect(projectInstalledSkillFilePath("projects/other/AGENTS.md")).toBeNull();
  });
});

it("copies quoted legacy names without accepting a different manifest identity", async () => {
  const content = "---\nname: 'release-review'\ndescription: Review a release.\n---\n\nReview the changelog.\n";
  expect(await copyProjectSkill(content, "'release-review'")).toEqual({
    path: ".agents/skills/release-review/SKILL.md", content,
  });
  expect(await copyProjectSkill(content, "'different-skill'")).toHaveProperty("error");
});
