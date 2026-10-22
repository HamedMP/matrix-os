import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("packages/ui/src/get-started/get-started.css", "utf8");
const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*\\}`))?.[0] ?? "";

describe("get started styles", () => {
  it("stretches the blurred scrim over the whole desktop despite the centered grid", () => {
    expect(rule(".mxo-root.mxo-gs")).toContain("place-items: center");
    const scrim = rule(".mxo-gs__scrim");
    expect(scrim).toContain("inset: 0");
    expect(scrim).toContain("place-self: stretch");
    expect(scrim).toContain("width: 100%");
    expect(scrim).toContain("height: 100%");
    expect(scrim).toMatch(/backdrop-filter: blur\(24px\)/);
  });
});
