import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("extracted public site boundary", () => {
  it("does not keep a second deployable www app in the monorepo", () => {
    expect(existsSync(join(root, "www"))).toBe(false);
    expect(read("pnpm-workspace.yaml")).not.toMatch(/^\s*- ["']www["']$/m);
    expect(read("package.json")).not.toContain('"dev:www"');
  });

  it("points contributors to the dedicated site repository", () => {
    expect(read("AGENTS.md")).toContain("FinnaAI/matrix-os-site");
    expect(read("README.md")).toContain("FinnaAI/matrix-os-site");
  });
});
