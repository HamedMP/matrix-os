import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("www auth page variants", () => {
  it("sign-up page uses product variant", () => {
    const signUp = read("www/src/app/sign-up/[[...sign-up]]/page.tsx");
    expect(signUp).toContain('variant="product"');
  });

  it("sign-in page uses roster variant", () => {
    const signIn = read("www/src/app/sign-in/[[...sign-in]]/page.tsx");
    expect(signIn).toContain('variant="roster"');
  });
});
