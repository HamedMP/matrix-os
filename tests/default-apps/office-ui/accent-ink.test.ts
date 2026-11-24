/**
 * The app accent is a dark brand colour whatever the host theme is. Used as
 * text, a focus ring or a thin mark it disappears on a dark theme, so the kit
 * derives an "ink" from the accent and the text colour, and Docs and Sheets
 * use the ink for everything that is not a filled surface. These checks fail
 * when the ink is not readable on a dark theme, or when a stylesheet goes
 * back to the bare accent for text, outlines or borders.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APPS = join(__dirname, "..", "..", "..", "home", "apps");
const read = (...parts: string[]) => readFileSync(join(APPS, ...parts), "utf-8");

const KIT = read("_shared", "office-ui", "office-ui.css");
/** App stylesheets held to the ink rule; each office app adds its own. */
const APP_SHEETS: Record<string, string> = {
  "docs/styles.css": read("docs", "src", "styles.css"),
  "docs/editor.css": read("docs", "src", "editor", "editor.css"),
  "docs/review.css": read("docs", "src", "ui", "review", "review.css"),
};

type Rgb = [number, number, number];
const hex = (value: string): Rgb => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as Rgb;
const mix = (a: Rgb, b: Rgb, share: number): Rgb => a.map((channel, at) => channel * share + b[at]! * (1 - share)) as Rgb;
function luminance(color: Rgb): number {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: Rgb, b: Rgb): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

/** Declarations of a stylesheet as `property: value` strings, comments removed. */
function declarations(css: string): string[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/[{};]/)
    .map((part) => part.trim())
    .filter((part) => /^[a-z-]+\s*:/.test(part));
}

const BRAND_ACCENT = hex("#0e3422");

describe("accent ink", () => {
  it("is mixed from the accent and the text colour, and reads on a dark theme and on the light one", () => {
    const share = Number(/--oui-accent-ink:\s*color-mix\(in srgb, var\(--oui-accent\) (\d+)%, var\(--app-fg\)\)/.exec(KIT)?.[1]) / 100;
    expect(share).toBeGreaterThan(0);
    const dark = { bg: hex("#1d2234"), card: hex("#292d43"), fg: hex("#f2f1f8") };
    const ink = mix(BRAND_ACCENT, dark.fg, share);
    expect(contrast(ink, dark.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink, dark.card)).toBeGreaterThanOrEqual(4.5);
    // The bare accent is what this guards against.
    expect(contrast(BRAND_ACCENT, dark.bg)).toBeLessThan(1.5);
    const light = { bg: hex("#fcfcf8"), fg: hex("#0e3422") };
    expect(contrast(mix(BRAND_ACCENT, light.fg, share), light.bg)).toBeGreaterThanOrEqual(7);
  });

  it("derives the kit's washes and focus ring from the ink", () => {
    for (const token of ["--oui-wash", "--oui-active", "--oui-focus"]) {
      const value = new RegExp(`${token}:([^;]+);`).exec(KIT)?.[1] ?? "";
      expect(value, token).toContain("var(--oui-accent-ink)");
    }
  });

  it("never uses the bare accent for text, outlines, borders or marks in the kit", () => {
    const bare = declarations(KIT).filter((line) => /^(color|outline|border[a-z-]*|box-shadow|text-decoration[a-z-]*)\s*:/.test(line) && /var\(--oui-accent[,)]/.test(line));
    // Filled buttons keep the accent as their own border colour.
    expect(bare.filter((line) => !line.startsWith("border-color: var(--oui-accent)"))).toEqual([]);
  });

  it.each(Object.keys(APP_SHEETS))("uses the ink, not the bare accent, outside filled surfaces in %s", (name) => {
    // The bare accent may only stand behind the ink, as its fallback outside the kit's elements.
    const withoutFallbacks = (line: string) => line.replace(/var\(--oui-accent-ink, var\(--identity-accent, var\(--app-primary\)\)\)|var\(--oui-accent-ink, var\(--app-primary\)\)/g, "INK");
    const bare = declarations(APP_SHEETS[name]!)
      .map(withoutFallbacks)
      .filter((line) => /var\(--(identity-accent|app-primary|sg-accent)[,)]/.test(line) && !/^--[a-z-]+\s*:/.test(line));
    // A filled surface states the colour of the text on it; nothing else may use the bare accent.
    expect(bare.filter((line) => !/^background(-color)?\s*:\s*var\(--sg-accent\)$/.test(line))).toEqual([]);
  });
});
