import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
