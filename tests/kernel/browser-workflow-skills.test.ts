import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "../../packages/kernel/src/agents.js";
import {
  clearSkillCache,
  loadSkillBody,
  loadSkills,
} from "../../packages/kernel/src/skills.js";

const sourceRoot = resolve(__dirname, "../../skills/matrix");
const syncScript = resolve(__dirname, "../../scripts/sync-matrix-agent-skills.sh");
const workflowSlugs = [
  "browser-admin",
  "accounting-preparation",
  "information-collection",
];
const workflowNames = workflowSlugs.map(slug => `matrix-${slug}`);
const browserTools = ["shared_browser","mcp__matrix_shared_browser__shared_browser","mcp__matrix-os-browser__browser"];

describe("bundled browser workflow skill discovery", () => {
  let homePath: string;

  beforeEach(() => {
    clearSkillCache();
    homePath = mkdtempSync(join(tmpdir(), "matrix-browser-workflow-skills-"));
    const isolatedSource = join(homePath, "skill-source");
    mkdirSync(isolatedSource, { recursive: true });
    for (const slug of workflowSlugs) {
      const source = join(sourceRoot, slug);
      cpSync(source, join(isolatedSource, slug), { recursive: true });
    }
    execFileSync("bash", [syncScript, isolatedSource], {
      env: { ...process.env, MATRIX_HOME: homePath, MATRIX_SKILL_TARGETS: "matrix" },
    });
  });

  afterEach(() => {
    clearSkillCache();
    rmSync(homePath, { recursive: true, force: true });
  });

  it.each(workflowNames)("discovers %s with usable Matrix metadata", (name) => {
    const skills = loadSkills(homePath).filter((skill) => skill.name === name);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name,
      format: "directory",
      fileName: `${name}/SKILL.md`,
      sourcePath: join(homePath, ".agents", "skills", name, "SKILL.md"),
      tools_needed: browserTools,
      channel_hints: ["any"],
    });
    expect(skills[0].description.trim().length).toBeGreaterThan(0);
    expect(skills[0].triggers.length).toBeGreaterThan(0);
    expect(skills[0].examples.length).toBeGreaterThan(0);
  });

  it.each(workflowNames)("loads %s body before and after catalog discovery", (name) => {
    const content = readFileSync(join(homePath, ".agents", "skills", name, "SKILL.md"), "utf8");
    const expectedBody = parseFrontmatter(content).body.trim();
    expect(expectedBody.length).toBeGreaterThan(0);
    expect(loadSkillBody(homePath, name)).toBe(expectedBody);
    clearSkillCache();
    loadSkills(homePath);
    expect(loadSkillBody(homePath, name)).toBe(expectedBody);
  });

  it.each(workflowNames)("grounds %s in the installed shared tool and fresh observations",name=>{
    const body=loadSkillBody(homePath,name)!;
    expect(body).toContain("mcp__matrix_shared_browser__shared_browser");expect(body).toContain("observationId");
    expect(body).toContain("Take over");expect(body).toContain("Resume");expect(body).toContain("collectionManifest");
    expect(body).toContain("never replay");expect(body).toContain("separate Chromium");
  });

  it("links exact shared workflows into the Matrix catalog without duplicate entries", () => {
    for (const [index, name] of workflowNames.entries()) {
      const canonical = join(homePath, ".agents", "skills", name);
      const shared = join(homePath, "skill-source", workflowSlugs[index]!);
      expect(lstatSync(canonical).isSymbolicLink()).toBe(true);
      expect(realpathSync(canonical)).toBe(realpathSync(shared));
      expect(readFileSync(join(canonical, "SKILL.md"), "utf8"))
        .toBe(readFileSync(join(shared, "SKILL.md"), "utf8"));
    }
    const discovered = loadSkills(homePath);
    expect(discovered.map((skill) => skill.name).sort()).toEqual([...workflowNames].sort());
  });
});
