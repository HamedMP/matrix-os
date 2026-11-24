import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Fault detected (Mac, 2026-11-22): the Terminal window's agents rows had no hover tint, because
// Tailwind never scanned packages/ui/src/terminal-status-sidebar and so never generated its classes.
const ROOT = join(__dirname, "../..");
const RENDERER = join(ROOT, "desktop/src/renderer/src");
const CSS = readFileSync(join(RENDERER, "design/index.css"), "utf8");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("desktop Tailwind sources", () => {
  // The Terminal window's shared folders (spec 2706); other features' folders are theirs to add.
  it("scans every shared terminal UI folder with components that the desktop renderer imports", () => {
    const imported = new Set<string>();
    for (const file of files(RENDERER)) {
      for (const match of readFileSync(file, "utf8").matchAll(/from "@matrix-os\/ui\/(terminal-[a-z0-9-]+)"/g)) imported.add(match[1]!);
    }
    const sources = [...CSS.matchAll(/@source "([^"]+)"/g)].map((match) => relative(ROOT, join(RENDERER, "design", match[1]!)));
    const missing = [...imported].filter((subpath) => {
      const dir = join(ROOT, "packages/ui/src", subpath);
      const hasComponents = existsSync(dir) && statSync(dir).isDirectory() && files(dir).some((file) => file.endsWith(".tsx"));
      return hasComponents && !sources.some((source) => `packages/ui/src/${subpath}`.startsWith(source));
    });
    expect(missing).toEqual([]);
  });
});
