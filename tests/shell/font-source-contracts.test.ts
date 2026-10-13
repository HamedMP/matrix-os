import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Keep source contracts together to avoid a worker/module setup per small suite.
describe("terminal-font-css", () => {
  describe("terminal font CSS", () => {
    it("uses font-display block for bundled Meslo faces so xterm measures stable glyph metrics", async () => {
      const css = await readFile("shell/src/app/globals.css", "utf8");
      const mesloFaces = css.match(/@font-face\s*{[^}]*font-family:\s*"MesloLGS NF";[^}]*}/g) ?? [];

      expect(mesloFaces).toHaveLength(4);
      for (const face of mesloFaces) {
        expect(face).toContain("font-display: block;");
        expect(face).not.toContain("font-display: swap;");
      }
    });
  });
});

describe("font-preload-policy", () => {
  const layoutSource = readFileSync(join(process.cwd(), "shell/src/app/layout.tsx"), "utf8");

  const cssSource = readFileSync(join(process.cwd(), "shell/src/app/fonts.css"), "utf8");

  const faces = [...cssSource.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]);

  function hasGlobalFontPreload(source: string): boolean {
    return /<(?:link|Link)\b[^>]*\bas\s*=\s*["']font["'][^>]*>/s.test(source)
      || /\bpreload\s*\([^;]*\bas\s*:\s*["']font["']/s.test(source);
  }

  describe("shell font preload policy", () => {
    it.each([
      "Matrix Inter", "Matrix Instrument Sans", "Matrix Instrument Serif", "Matrix JetBrains Mono",
      "Matrix Cormorant Garamond", "Matrix Orbitron", "Matrix Geist", "Matrix Geist Mono", "Matrix Bricolage Grotesque",
    ])("loads the %s family lazily from self-hosted faces without a global preload", (family) => {
      const physicalFaces = faces.filter(face => face.includes(`font-family: '${family}';`) && face.includes("src: url("));
      expect(physicalFaces.length).toBeGreaterThan(0);
      for (const face of physicalFaces) {
        expect(face).toMatch(/src: url\([^)]*node_modules\/@fontsource[^)]*\.woff2\)/);
        expect(face).toContain("unicode-range:");
        expect(face).toMatch(/font-display: (swap|block);/);
      }
      expect(layoutSource).toContain('import "./fonts.css"');
      expect(layoutSource).toContain('className="matrix-shell-fonts"');
      // CSS @font-face stays demand-loaded; Next/React font preloads must not be reintroduced.
      expect(layoutSource).not.toContain("next/font/");
      expect(hasGlobalFontPreload(layoutSource)).toBe(false);
    });

    it.each([
      '<link rel="preload" href="/synthetic.woff2" as="font" />',
      '<link as="font" href="/synthetic.woff2" rel="preload" />',
      'preload("/synthetic.woff2", { as: "font", type: "font/woff2" });',
    ])("rejects an eager font reference: %s", (source) => {
      expect(hasGlobalFontPreload(source)).toBe(true);
    });
  });
});

describe("shell-local-fonts", () => {
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
});
