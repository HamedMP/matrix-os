import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (app: string, file: string) => readFileSync(new URL(`../../home/apps/${app}/src/${file}`, import.meta.url), "utf8");
const cases = [
  ["expense-tracker", "styles.css", ".exp-text-btn"],
  ["todo", "styles.css", ".due--today"],
  ["todo", "styles.css", ".nav-item--active .nav-count"],
] as const;

describe("utility text accent contrast", () => {
  it.each(cases)("%s %s keeps %s readable on light surfaces", (app, file, selector) => {
    const rule = [...read(app, file).matchAll(/([^{}]+)\{([^{}]+)\}/g)]
      .find(match => match[1].trim() === selector)?.[2];
    expect(rule, `missing ${selector}`).toBeDefined();
    expect(rule).toMatch(/(?:^|;)\s*color:\s*var\(--app-text-accent\)/);
    expect(rule).not.toMatch(/(?:^|;)\s*color:\s*var\(--app-accent\)/);
  });
  it("keeps pale accents for filled controls and count backgrounds", () => {
    expect(read("expense-tracker", "styles.css")).toMatch(/\.exp-primary\s*\{[^}]*background:\s*var\(--app-accent\)/);
    expect(read("todo", "styles.css")).toMatch(/\.nav-item--active \.nav-count\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--app-accent\)/);
  });
});
