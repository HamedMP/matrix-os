import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(__dirname, "../../skills/matrix/shadcn");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

describe("Matrix shadcn skill pack", () => {
  it("ships the complete useful local reference tree with provenance", () => {
    for (const file of ["SKILL.md", "cli.md", "customization.md", "mcp.md", "rules/styling.md", "rules/forms.md", "rules/composition.md", "rules/icons.md", "rules/base-vs-radix.md", "charts.md", "presets.md", "PROVENANCE.md", ".matrix-os-managed"]) expect(existsSync(join(root, file)), file).toBe(true);
    expect(read("PROVENANCE.md")).toContain("local skill");
    expect(read("PROVENANCE.md")).not.toContain("/Users/");
  });

  it("supports lazy discovery without automatic commands or permission grants", () => {
    const content = read("SKILL.md");
    expect(content).toContain("name: shadcn");
    expect(content).toMatch(/^triggers:\s*\[[^\]]+\]/m);
    expect(content).toContain("related_skills:");
    expect(content).toContain("Matrix integration");
    for (const file of walk(root).filter((file) => file.endsWith(".md"))) {
      const body = readFileSync(file, "utf8");
      expect(body, file).not.toMatch(/^allowed-tools:/m);
      expect(body, file).not.toMatch(/!`/);
      expect(body, file).not.toMatch(/\b(?:npx|bunx) shadcn|\bnpm (?:install|exec)/);
      for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1];
        if (/^(?:https?:|#|~|\/)/.test(link) || !/\.md(?:#.*)?$/.test(link)) continue;
        expect(existsSync(resolve(dirname(file), link.split("#")[0])), `${file}: ${link}`).toBe(true);
      }
    }
  });

  it("preserves existing code and selects one persistent preset", () => {
    const content = read("presets.md");
    for (const term of ["choose once", "DESIGN.md", "not a default", "--dry-run", "--diff", "preserve", "minimum release age", "pnpm install"]) expect(content).toContain(term);
    expect(content).toContain("do not execute");
    for (const file of ["SKILL.md", "cli.md"]) expect(read(file)).not.toMatch(/(?:starting|starts) with.*(?:lowercase )?`?a`?/);
  });

  it("documents measured Recharts 3 charts from owner-saved data", () => {
    const content = read("charts.md");
    for (const term of ["Recharts 3", "ChartContainer", "height", "min-height", "accessibilityLayer", "ChartTooltip", "ChartLegend", "var(--chart-1)", "window.MatrixOS.db", "empty", "reduced motion"]) expect(content).toContain(term);
    expect(content).toContain("https://ui.shadcn.com/docs/components/base/chart");
  });
});
