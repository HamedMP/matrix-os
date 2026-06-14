import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Clerk keyless dev overlay CSS", () => {
  it("hides the keyless prompt on phone-sized shell previews", async () => {
    const css = await readFile("shell/src/app/globals.css", "utf8");

    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain('#clerk-components > div:has(> button[aria-label="Keyless prompt"])');
    expect(css).toContain("display: none !important;");
  });
});
