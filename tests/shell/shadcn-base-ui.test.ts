import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function sourceFiles(relativeDirectory: string): string[] {
  const absoluteDirectory = join(root, relativeDirectory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [relativePath] : [];
  });
}

describe("shell shadcn Base UI migration", () => {
  it("pins the shell registry to a Base UI style", () => {
    const config = JSON.parse(read("shell/components.json")) as { style?: string };

    expect(config.style).toMatch(/^base-/);
  });

  it("uses Base UI without legacy Radix or Vaul shell dependencies", () => {
    const packageJson = JSON.parse(read("shell/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.["@base-ui/react"]).toBeTruthy();
    expect(packageJson.dependencies?.["radix-ui"]).toBeUndefined();
    expect(packageJson.dependencies?.vaul).toBeUndefined();
    expect(packageJson.devDependencies?.shadcn).toMatch(/^\^4\./);
  });

  it("keeps legacy primitive imports out of the shell", () => {
    for (const sourcePath of sourceFiles("shell/src")) {
      const source = read(sourcePath);
      expect(source, sourcePath).not.toContain('from "radix-ui"');
      expect(source, sourcePath).not.toContain('from "vaul"');
      expect(source, sourcePath).not.toMatch(/from ["']@radix-ui\//);
    }
  });
});
