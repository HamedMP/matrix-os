import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Web Desktop authentication indexing", () => {
  for (const name of ["sign-in", "sign-up"]) {
    it(`${name} prevents indexing and canonicalizes query variants`, () => {
      const page = readFileSync(`shell/src/app/${name}/[[...${name}]]/page.tsx`, "utf8");
      expect(page).toMatch(/robots: \{ index: false, follow: true \}/);
      expect(page).toContain(`canonical: "https://app.matrix-os.com/${name}"`);
      expect(page).toContain('forceRedirectUrl="/"');
    });
  }
});
