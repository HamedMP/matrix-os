import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("packages/ui/src/get-started/get-started.css", "utf8");
const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*\\}`))?.[0] ?? "";

describe("get started styles", () => {
  it("covers the whole desktop with an opaque backdrop despite the centered grid", () => {
    expect(rule(".mxo-root.mxo-gs")).toContain("place-items: center");
    const backdrop = rule(".mxo-gs__backdrop");
    expect(backdrop).toContain("inset: 0");
    expect(backdrop).toContain("place-self: stretch");
    expect(backdrop).toContain("width: 100%");
    expect(backdrop).toContain("height: 100%");
    expect(backdrop).toContain("overflow: hidden");
    // Opaque fallback so icons, the dock and windows never show through.
    expect(backdrop).toMatch(/background-color: #[0-9a-f]{6};/i);
  });

  it("blurs its own copy of the wallpaper instead of relying on backdrop-filter", () => {
    const image = rule(".mxo-gs__backdrop-image");
    expect(image).toMatch(/inset: -\d+px/);
    expect(image).toContain("background-size: cover");
    expect(image).toMatch(/filter: blur\((4[0-9]|[5-9][0-9])px\)/);
    expect(css).not.toContain("backdrop-filter");
  });

  it("keeps a light tint over the blurred wallpaper", () => {
    const scrim = rule(".mxo-gs__scrim");
    expect(scrim).toContain("inset: 0");
    expect(scrim).toContain("place-self: stretch");
    expect(scrim).toContain("color-mix(in srgb, var(--mxo-ink)");
  });
});
