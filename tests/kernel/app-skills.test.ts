import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(__dirname, "../../home/.agents/skills");

const APP_SKILLS = [
  { name: "build-for-matrix", category: "builder" },
  { name: "design-matrix-app", category: "builder" },
  { name: "build-game", category: "builder" },
  { name: "app-builder", category: "system" },
  { name: "build-react-app" },
  { name: "build-html-app" },
];

function skillPath(name: string): string {
  return join(SKILLS_DIR, name, "SKILL.md");
}

describe("T1440-T1445: AI skills for app building", () => {
  for (const skill of APP_SKILLS) {
    describe(`${skill.name}/SKILL.md`, () => {
      it("exists", () => {
        expect(existsSync(skillPath(skill.name))).toBe(true);
      });

      it("has valid frontmatter with name", () => {
        const content = readFileSync(skillPath(skill.name), "utf-8");
        expect(content).toMatch(/^---\n/);
        expect(content).toContain(`name: ${skill.name}`);
      });

      it("has triggers", () => {
        const content = readFileSync(skillPath(skill.name), "utf-8");
        expect(content).toContain("triggers:");
      });

      it("has examples", () => {
        const content = readFileSync(skillPath(skill.name), "utf-8");
        expect(content).toContain("examples:");
      });

      it("has a body with content", () => {
        const content = readFileSync(skillPath(skill.name), "utf-8");
        const parts = content.split("---");
        expect(parts.length).toBeGreaterThanOrEqual(3);
        const body = parts.slice(2).join("---").trim();
        expect(body.length).toBeGreaterThan(100);
      });
    });
  }

  describe("build-for-matrix skill content", () => {
    it("documents matrix.json format", () => {
      const content = readFileSync(skillPath("build-for-matrix"), "utf-8");
      expect(content).toContain("matrix.json");
      expect(content).toContain("runtime");
      expect(content).toContain("static");
    });

    it("documents bridge API", () => {
      const content = readFileSync(skillPath("build-for-matrix"), "utf-8");
      expect(content).toContain("/api/bridge/data");
    });

    it("documents theming", () => {
      const content = readFileSync(skillPath("build-for-matrix"), "utf-8");
      expect(content).toContain("#0a0a0a");
      expect(content).toContain("theme");
    });

    it("is composable with build skills", () => {
      const content = readFileSync(skillPath("build-for-matrix"), "utf-8");
      expect(content).toContain("composable_with:");
      expect(content).toContain("build-react-app");
      expect(content).toContain("build-game");
    });
  });

  describe("design-matrix-app skill content", () => {
    it("documents color palette", () => {
      const content = readFileSync(skillPath("design-matrix-app"), "utf-8");
      expect(content).toContain("Color Palette");
      expect(content).toContain("#e0e0e0");
    });

    it("documents responsive patterns", () => {
      const content = readFileSync(skillPath("design-matrix-app"), "utf-8");
      expect(content).toContain("Responsive");
    });

    it("documents accessibility", () => {
      const content = readFileSync(skillPath("design-matrix-app"), "utf-8");
      expect(content).toContain("Accessibility");
    });
  });
});
