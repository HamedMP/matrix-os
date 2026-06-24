import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(__dirname, "../../skills/matrix");

const APP_SKILLS = [
  { dir: "app-builder", name: "matrix-app-builder" },
  { dir: "design-system", name: "matrix-design-system" },
  { dir: "integrations", name: "matrix-integrations" },
  { dir: "dev-vps", name: "matrix-dev-vps" },
  { dir: "debug-app", name: "matrix-debug-app" },
];

function skillPath(dir: string): string {
  return join(SKILLS_DIR, dir, "SKILL.md");
}

describe("T1440-T1445: AI skills for app building", () => {
  for (const skill of APP_SKILLS) {
    describe(`${skill.dir}/SKILL.md`, () => {
      it("exists", () => {
        expect(existsSync(skillPath(skill.dir))).toBe(true);
      });

      it("has valid frontmatter with name", () => {
        const content = readFileSync(skillPath(skill.dir), "utf-8");
        expect(content).toMatch(/^---\n/);
        expect(content).toContain(`name: ${skill.name}`);
      });

      it("has agent metadata", () => {
        const content = readFileSync(skillPath(skill.dir), "utf-8");
        expect(content).toContain("metadata:");
        expect(content).toContain("agent:");
        expect(content).toContain("tags:");
      });

      it("has version metadata", () => {
        const content = readFileSync(skillPath(skill.dir), "utf-8");
        expect(content).toContain("version:");
      });

      it("has a body with content", () => {
        const content = readFileSync(skillPath(skill.dir), "utf-8");
        const parts = content.split("---");
        expect(parts.length).toBeGreaterThanOrEqual(3);
        const body = parts.slice(2).join("---").trim();
        expect(body.length).toBeGreaterThan(100);
      });
    });
  }

  describe("matrix-app-builder skill content", () => {
    it("documents matrix.json format", () => {
      const content = readFileSync(skillPath("app-builder"), "utf-8");
      expect(content).toContain("matrix.json");
      expect(content).toContain("runtime");
      expect(content).toContain("vite");
    });

    it("documents bridge API", () => {
      const content = readFileSync(skillPath("app-builder"), "utf-8");
      expect(content).toContain("/api/bridge/query");
    });

    it("documents theming", () => {
      const content = readFileSync(skillPath("app-builder"), "utf-8");
      expect(content).toContain("theme");
      expect(content).toContain("--matrix-primary");
      expect(content).toContain("inherit the shell theme");
      expect(content).toContain("explicit app branding");
      expect(content).not.toContain("Orbitron H1/H2 only");
    });

    it("links companion skills through agent metadata", () => {
      const content = readFileSync(skillPath("app-builder"), "utf-8");
      expect(content).toContain("related_skills:");
      expect(content).toContain("matrix-design-system");
      expect(content).toContain("matrix-integrations");
    });
  });

  describe("matrix-design-system skill content", () => {
    it("documents Matrix theme variables", () => {
      const content = readFileSync(skillPath("design-system"), "utf-8");
      expect(content).toContain("--matrix-bg");
      expect(content).toContain("--app-bg");
      expect(content).toContain("--matrix-accent");
      expect(content).toContain("Use `--matrix-*` directly");
    });

    it("documents icon generation style inheritance", () => {
      const content = readFileSync(skillPath("design-system"), "utf-8");
      expect(content).toContain("system/desktop.json");
      expect(content).toContain("warm off-white or pale pastel background");
      expect(content).toContain("Matrix shell owns the final corner radius");
    });

    it("documents responsive patterns", () => {
      const content = readFileSync(skillPath("design-system"), "utf-8");
      expect(content).toContain("No horizontal overflow");
    });

    it("documents shadcn-style primitives", () => {
      const content = readFileSync(skillPath("design-system"), "utf-8");
      expect(content).toContain("shadcn-style");
    });
  });

  describe("matrix-integrations skill content", () => {
    it("documents sandbox-safe app bridge calls", () => {
      const content = readFileSync(skillPath("integrations"), "utf-8");
      expect(content).toContain("window.MatrixOS.integrations()");
      expect(content).toContain("window.MatrixOS.service()");
      expect(content).toContain("direct `/api/bridge/*` fetches");
      expect(content).not.toContain('fetch("/api/bridge/service"');
    });
  });
});
