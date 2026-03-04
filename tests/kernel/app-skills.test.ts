import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(__dirname, "../../home/agents/skills");

const APP_SKILLS = [
  { file: "build-for-matrix.md", name: "build-for-matrix", category: "builder" },
  { file: "design-matrix-app.md", name: "design-matrix-app", category: "builder" },
  { file: "build-game.md", name: "build-game", category: "builder" },
  { file: "app-builder.md", name: "app-builder", category: "system" },
  { file: "build-react-app.md", name: "build-react-app" },
  { file: "build-html-app.md", name: "build-html-app" },
];

describe("T1440-T1445: AI skills for app building", () => {
  for (const skill of APP_SKILLS) {
    describe(skill.file, () => {
      it("exists", () => {
        expect(existsSync(join(SKILLS_DIR, skill.file))).toBe(true);
      });

      it("has valid frontmatter with name", () => {
        const content = readFileSync(join(SKILLS_DIR, skill.file), "utf-8");
        expect(content).toMatch(/^---\n/);
        expect(content).toContain(`name: ${skill.name}`);
      });

      it("has triggers", () => {
        const content = readFileSync(join(SKILLS_DIR, skill.file), "utf-8");
        expect(content).toContain("triggers:");
      });

      it("has examples", () => {
        const content = readFileSync(join(SKILLS_DIR, skill.file), "utf-8");
        expect(content).toContain("examples:");
      });

      it("has a body with content", () => {
        const content = readFileSync(join(SKILLS_DIR, skill.file), "utf-8");
        const parts = content.split("---");
        expect(parts.length).toBeGreaterThanOrEqual(3);
        const body = parts.slice(2).join("---").trim();
        expect(body.length).toBeGreaterThan(100);
      });
    });
  }

  describe("build-for-matrix skill content", () => {
    it("documents matrix.json format", () => {
      const content = readFileSync(join(SKILLS_DIR, "build-for-matrix.md"), "utf-8");
      expect(content).toContain("matrix.json");
      expect(content).toContain("runtime");
      expect(content).toContain("static");
    });

    it("documents bridge API", () => {
      const content = readFileSync(join(SKILLS_DIR, "build-for-matrix.md"), "utf-8");
      expect(content).toContain("/api/bridge/data");
    });

    it("documents theming", () => {
      const content = readFileSync(join(SKILLS_DIR, "build-for-matrix.md"), "utf-8");
      expect(content).toContain("#0a0a0a");
      expect(content).toContain("theme");
    });

    it("is composable with build skills", () => {
      const content = readFileSync(join(SKILLS_DIR, "build-for-matrix.md"), "utf-8");
      expect(content).toContain("composable_with:");
      expect(content).toContain("build-react-app");
      expect(content).toContain("build-game");
    });
  });

  describe("design-matrix-app skill content", () => {
    it("documents color palette", () => {
      const content = readFileSync(join(SKILLS_DIR, "design-matrix-app.md"), "utf-8");
      expect(content).toContain("Color Palette");
      expect(content).toContain("#e0e0e0");
    });

    it("documents responsive patterns", () => {
      const content = readFileSync(join(SKILLS_DIR, "design-matrix-app.md"), "utf-8");
      expect(content).toContain("Responsive");
    });

    it("documents accessibility", () => {
      const content = readFileSync(join(SKILLS_DIR, "design-matrix-app.md"), "utf-8");
      expect(content).toContain("Accessibility");
    });
  });
});
