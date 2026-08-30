import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Matrix OS brand guidelines", () => {
  const design = readRepoFile("DESIGN.md");
  const colors = readRepoFile("design/foundations/colors.md");
  const typography = readRepoFile("design/foundations/typography.md");
  const publicGuide = readRepoFile("shell/public/brand-guidelines.html");

  it("records the approved Figma frame as the upstream visual source", () => {
    expect(design).toContain("xPG2FeYRtC9owCKSVXCqWA");
    expect(design).toContain("node-id=1-846");
    expect(design).toContain('wordmark: "Matrix OS"');
  });

  it("defines the five-color Figma brand palette", () => {
    for (const [name, hex] of [
      ["teal", "#0E3422"],
      ["coral", "#D06E53"],
      ["gold", "#F1C379"],
      ["green", "#BED77B"],
      ["blue", "#C5D6E2"],
    ] as const) {
      expect(design).toContain(`${name}: "${hex}"`);
      expect(colors).toContain(hex);
      expect(publicGuide).toContain(hex);
    }
  });

  it("uses the approved type families and retires the superseded stack", () => {
    for (const family of ["Bricolage Grotesque", "Geist", "Geist Mono"]) {
      expect(design).toContain(family);
      expect(typography).toContain(family);
      expect(publicGuide).toContain(family);
    }

    for (const retired of ["Orbitron", "Instrument Serif", "Instrument Sans"]) {
      expect(design).not.toContain(retired);
      expect(typography).not.toContain(retired);
      expect(publicGuide).not.toContain(retired);
    }
  });

  it("keeps implementation parity outside this brand-contract document", () => {
    expect(design).toContain("Cross-platform implementation status");
    expect(design).toContain("tracked separately");
  });
});
