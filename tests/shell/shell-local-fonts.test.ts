import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const families = [
  ["Inter", "--font-inter", "@fontsource-variable/inter", ["wght.css"]],
  ["Instrument Sans", "--font-instrument", "@fontsource-variable/instrument-sans", ["wght.css"]],
  ["Instrument Serif", "--font-serif-display", "@fontsource/instrument-serif", ["400.css", "400-italic.css"]],
  ["JetBrains Mono", "--font-jetbrains", "@fontsource-variable/jetbrains-mono", ["wght.css"]],
  ["Cormorant Garamond", "--font-serif", "@fontsource/cormorant-garamond", ["300.css", "400.css", "500.css"]],
  ["Orbitron", "--font-orbitron", "@fontsource/orbitron", ["400.css", "500.css", "600.css", "700.css"]],
  ["Geist", "--font-geist-sans", "@fontsource-variable/geist", ["wght.css"]],
  ["Geist Mono", "--font-geist-mono", "@fontsource-variable/geist-mono", ["wght.css"]],
  ["Bricolage Grotesque", "--font-bricolage", "@fontsource-variable/bricolage-grotesque", ["wght.css"]],
] as const;
const faces = (css: string) => [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match =>
  Object.fromEntries(match[1].split(";").filter(part => part.includes(":")).map(part => {
    const boundary = part.indexOf(":"); return [part.slice(0, boundary).trim(), part.slice(boundary + 1).trim()];
  })));

describe("production shell fonts preserve pinned faces without network fetching", () => {
  it.each(families)("preserves %s subsets, weights, styles and variable", (family, variable, name, files) => {
    const css = readFileSync("shell/src/app/fonts.css", "utf8");
    const actual = faces(css).filter(face => face["font-family"] === `'Matrix ${family}'`);
    const root = resolve("shell/node_modules", name);
    const metadata = JSON.parse(readFileSync(resolve(root, "metadata.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(metadata.family).toBe(family); expect(pkg.version).toBe("5.3.0"); expect(pkg.license).toBe("OFL-1.1");
    const expected = files.flatMap(file => faces(readFileSync(resolve(root, file), "utf8")));
    expect(actual.length).toBe(expected.length);
    for (const [index, face] of actual.entries()) {
      for (const field of ["font-weight", "font-style", "unicode-range"]) expect(face[field]).toBe(expected[index][field]);
      expect(face["font-display"]).toBe(family === "Bricolage Grotesque" ? "block" : "swap");
      const path = /url\(([^)]+)\)/.exec(face.src)![1];
      expect(path).not.toMatch(/https?:/);
      expect(readFileSync(resolve("shell/src/app", path)).subarray(0, 4).toString("ascii")).toBe("wOF2");
    }
    expect(css).toContain(`${variable}: 'Matrix ${family}', 'Matrix ${family} Fallback'`);
  });
  it("keeps body faces separate from terminal-only global font imports", () => {
    const body = faces(readFileSync("shell/src/app/fonts.css", "utf8")).map(face => face["font-family"]);
    const terminal = faces(readFileSync("shell/node_modules/@fontsource/jetbrains-mono/400.css", "utf8")).map(face => face["font-family"]);
    expect(body.filter(family => terminal.includes(family))).toEqual([]);
  });
  it("uses offline faces on the actual document path", () => {
    const layout = readFileSync("shell/src/app/layout.tsx", "utf8");
    expect(layout).toContain('import "./fonts.css"'); expect(layout).not.toContain("next/font/google");
    expect(layout).toContain('className="matrix-shell-fonts"');
  });
});
