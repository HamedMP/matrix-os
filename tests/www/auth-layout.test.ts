import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("www AuthLayout", () => {
  const src = read("www/src/components/auth/AuthLayout.tsx");

  it("imports from @matrix-os/brand", () => {
    expect(src).toContain('from "@matrix-os/brand"');
  });

  it("does not contain legacy gradient or tile background styles", () => {
    expect(src).not.toContain("linear-gradient(115deg");
    expect(src).not.toContain("56px 56px");
  });

  it("accepts featureContent and formContent props", () => {
    expect(src).toContain("featureContent");
    expect(src).toContain("formContent");
  });
});
