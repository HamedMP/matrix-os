import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("BootSequence brand kit adoption", () => {
  const src = read("shell/src/components/BootSequence.tsx");

  it("imports from @matrix-os/brand", () => {
    expect(src).toMatch(/from ["']@matrix-os\/brand["']/);
  });

  it("no longer uses the solid-ember Tailwind button class bg-ember px-4 py-2", () => {
    expect(src).not.toContain("bg-ember px-4 py-2");
  });
});
