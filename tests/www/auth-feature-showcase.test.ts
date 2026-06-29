import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("www FeatureShowcase", () => {
  const src = read("www/src/components/auth/FeatureShowcase.tsx");

  it("imports from @matrix-os/brand", () => {
    expect(src).toContain('from "@matrix-os/brand"');
  });

  it("declares a variant prop with product and roster values", () => {
    expect(src).toContain("variant");
    expect(src).toContain('"product"');
    expect(src).toContain('"roster"');
  });

  it("does not contain legacy animation or progress code", () => {
    expect(src).not.toContain("setInterval");
    expect(src).not.toContain("authProgressFill");
  });
});
