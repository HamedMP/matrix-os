import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Next's production build fails when "use client" is not the file's first
// statement, but unit tests and tsc accept it, so a misplaced directive only
// shows up as a broken host bundle build. Comments and blank lines may come first.

const ROOT = join(__dirname, "..", "..");
const SOURCE_DIRS = ["shell/src", "packages/ui/src"];
const DIRECTIVE = /^["']use client["'];?\s*$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(name) ? [path] : [];
  });
}

function firstStatement(text: string): string | undefined {
  let inBlockComment = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    return line;
  }
  return undefined;
}

describe('"use client" directive placement', () => {
  it("is the first statement wherever it appears", () => {
    const misplaced = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        if (!text.split("\n").some((line) => DIRECTIVE.test(line.trim()))) return false;
        return !DIRECTIVE.test(firstStatement(text) ?? "");
      })
      .map((path) => relative(ROOT, path));
    expect(misplaced).toEqual([]);
  });
});
