import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

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
      expect(content).toContain("app-local semantic tokens");
      expect(content).toContain("brief, mood and references");
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
      expect(content).toContain("No page-level horizontal overflow");
      expect(content).toContain("essential tables");
      expect(content).toContain("44×44px");
      expect(content).not.toContain("minimum 36×36px");
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


describe("shipped design skill discovery", () => {
  const vendored = ["emil-design-eng", "apple-design", "animate", "animation-vocabulary", "animation-accessibility", "animation-performance", "css-animations", "review-animations", "shadcn"];
  for (const name of vendored) {
    it(`ships ${name} with provenance and an ownership marker`, () => {
      expect(existsSync(skillPath(name))).toBe(true);
      expect(existsSync(join(SKILLS_DIR, name, ".matrix-os-managed"))).toBe(true);
      const provenance = readFileSync(join(SKILLS_DIR, name, "PROVENANCE.md"), "utf-8");
      expect(provenance).toContain("local skill");
      expect(provenance).not.toContain("/Users/");
      expect(readFileSync(skillPath(name), "utf-8")).not.toContain("Do not provide any other information until");
    });
  }

  it("provides trigger metadata for every shipped skill and keeps local resource links resolvable", () => {
    const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const child = join(path, entry.name);
      return entry.isDirectory() ? walk(child) : child.endsWith(".md") ? [child] : [];
    });
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      const content = readFileSync(skillPath(entry.name), "utf-8");
      expect(content.split("---")[1], entry.name).toMatch(/^triggers:\s*\[[^\]]+\]/m);
      for (const resource of walk(join(SKILLS_DIR, entry.name))) {
        for (const match of readFileSync(resource, "utf-8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          const link = match[1];
          if (/^(?:https?:|#|~|\/)/.test(link) || !/\.md(?:#.*)?$/.test(link)) continue;
          expect(existsSync(resolve(dirname(resource), link.split("#")[0])), `${resource}: ${link}`).toBe(true);
        }
      }
    }
  });
});

describe("responsive app and landing guidance", () => {
  const reference = join(SKILLS_DIR, "app-builder/references/responsive-layout.md");

  it("checks concrete viewport widths and preserves access to essential content", () => {
    const content = readFileSync(reference, "utf-8");
    for (const width of [360, 390, 600, 820, 1024, 1440]) expect(content).toContain(`${width}px`);
    expect(content).toContain("observed viewport");
    expect(content).toContain("user-agent");
    expect(content).toContain("container width");
    expect(content).toContain("Do not hide fields");
    expect(content).toContain("44×44px");
    expect(content).toContain("keyboard focus");
    expect(content).toContain("long labels");
    expect(content).toContain("horizontal scrolling");
    expect(content).toContain("fixed minimum width");
  });

  it("shares the responsive reference across app and landing workflows", () => {
    const resources = [skillPath("app-builder"), join(SKILLS_DIR, "app-builder/references/app-craft.md"), skillPath("landing-design")];
    for (const resource of resources) expect(readFileSync(resource, "utf-8")).toContain("responsive-layout.md");
  });

  it("requires observed multi-width evidence in model comparison briefs", () => {
    const content = readFileSync(join(__dirname, "../../specs/543-app-builder-craft/demo-briefs.md"), "utf-8");
    for (const width of [360, 390, 600, 820, 1024, 1440]) expect(content).toContain(`${width}px`);
    expect(content).toContain("observed viewport");
    expect(content).toContain("unavailable");
  });

  it("keeps baseline references compatible with touch and essential table scrolling", () => {
    const patterns = readFileSync(skillPath("app-ui-patterns"), "utf-8");
    const knowledge = readFileSync(join(__dirname, "../../home/agents/knowledge/matrix-design-system.md"), "utf-8");
    for (const content of [patterns, knowledge]) {
      expect(content).toContain("44×44px");
      expect(content).toContain("essential tables");
      expect(content).not.toContain("minimum 36×36px");
    }
  });
});
