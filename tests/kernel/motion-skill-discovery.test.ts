import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSkills, clearSkillCache, loadSkillBody } from "../../packages/kernel/src/skills.js";
import { discoverRecipeSkills } from "../../packages/gateway/src/chat/agent-recipe-skills.js";

const skillsRoot = resolve(__dirname, "../../skills/matrix");
const names = ["animate", "animation-accessibility", "animation-performance", "animation-vocabulary", "css-animations", "review-animations"];

describe("shipped motion skill discovery", () => {
  it.each([false, true])("discovers all companions through the actual bundled recipe loader (catalog only=%s)", async (installedOnly) => {
    const discovered = await discoverRecipeSkills({ skillsRoot }, installedOnly);
    for (const name of names) expect(discovered.map((skill) => skill.id), name).toContain(name);
  });

  it("loads synced motion companions through the actual kernel loader", () => {
    const home = mkdtempSync(join(tmpdir(), "matrix-motion-discovery-"));
    try {
      const root = join(home, ".agents", "skills");
      mkdirSync(root, { recursive: true });
      for (const name of names) symlinkSync(join(skillsRoot, name), join(root, name));
      clearSkillCache();
      const discovered = loadSkills(home);
      for (const name of names) {
        expect(discovered.map((skill) => skill.name), name).toContain(name);
        expect(loadSkillBody(home, name)?.length, name).toBeGreaterThan(100);
      }
    } finally { clearSkillCache(); rmSync(home, { recursive: true, force: true }); }
  });
});
