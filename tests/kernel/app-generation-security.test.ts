import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const APP_GENERATION_GUIDANCE_FILES = [
  "packages/kernel/src/prompt.ts",
  "packages/kernel/src/agents.ts",
  "home/agents/knowledge/app-generation.md",
  "home/agents/knowledge/matrix-design-system.md",
  "skills/matrix/app-builder/SKILL.md",
  "skills/matrix/design-system/SKILL.md",
];

describe("app generation security guidance", () => {
  it("does not instruct generated apps to load privileged third-party icon scripts", async () => {
    for (const file of APP_GENERATION_GUIDANCE_FILES) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain("code.iconify.design");
      expect(source, file).not.toContain("Iconify CDN");
    }
  });

  it("does not instruct generated apps to load remote font stylesheets", async () => {
    for (const file of APP_GENERATION_GUIDANCE_FILES) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain("fonts.googleapis.com");
      expect(source, file).not.toContain("@import url('https://fonts.googleapis.com");
    }
  });
});
