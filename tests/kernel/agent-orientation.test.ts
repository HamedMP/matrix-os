import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../packages/kernel/src/prompt.js";
import { loadSkills, buildSkillsToc, clearSkillCache } from "../../packages/kernel/src/skills.js";

describe("Matrix agent orientation", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "matrix-orientation-")); clearSkillCache(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("orients a kernel even without an owner prompt and describes available tool discovery", () => {
    const prompt = buildSystemPrompt(home);
    expect(prompt).toContain("## Matrix OS orientation");
    expect(prompt).toContain("matrix-app-builder");
    expect(prompt).toContain("window.MatrixOS.db");
    expect(prompt).toContain("DESIGN.md");
    expect(prompt).toContain("manage_cron");
    expect(prompt).toContain("Only use tools present in this run");
  });

  it("never interprets JSON files as the state of the owner's Postgres database", () => {
    mkdirSync(join(home, "apps", "notes"), { recursive: true });
    mkdirSync(join(home, "data", "notes"), { recursive: true });
    writeFileSync(join(home, "data", "notes", "stale-private-records.json"), "[]");
    const prompt = buildSystemPrompt(home);
    expect(prompt).toContain("Installed Apps");
    expect(prompt).toContain("notes");
    expect(prompt).not.toContain("stale-private-records");
    expect(prompt).not.toContain("No app data stored yet");
    expect(prompt).not.toContain("Apps store data in ~/data/");
  });

  it("lists companion skill names without loading their bodies into the system prompt", () => {
    const path = join(home, ".agents", "skills", "builder");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), "---\nname: builder\ndescription: Build apps\ntriggers: [build]\nrelated_skills: [animate, apple-design]\n---\nBODY_MUST_STAY_LAZY");
    const skills = loadSkills(home);
    expect(skills[0]).toMatchObject({ related_skills: ["animate", "apple-design"] });
    expect(buildSkillsToc(skills)).toContain("companions: animate, apple-design");
    expect(buildSystemPrompt(home)).not.toContain("BODY_MUST_STAY_LAZY");
  });
});
