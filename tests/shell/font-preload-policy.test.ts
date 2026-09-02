import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const layoutSource = readFileSync(join(process.cwd(), "shell/src/app/layout.tsx"), "utf8");

function fontOptions(fontName: string): string {
  const match = layoutSource.match(new RegExp(`const ${fontName} = [A-Za-z_]+\\(\\{([\\s\\S]*?)\\n\\}\\);`));
  expect(match, `${fontName} declaration`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("shell font preload policy", () => {
  it.each([
    "inter",
    "instrumentSans",
    "instrumentSerif",
    "jetbrainsMono",
    "cormorant",
    "orbitron",
    "geistSans",
    "geistMono",
    "bricolage",
  ])("does not preload the %s family on every route", (fontName) => {
    expect(fontOptions(fontName)).toContain("preload: false");
  });
});
