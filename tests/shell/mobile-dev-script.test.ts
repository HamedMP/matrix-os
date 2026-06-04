import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("mobile shell dev script", () => {
  it("starts gateway and shell with the mobile terminal bypass flags", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

    expect(pkg.scripts["dev:mobile-shell"]).toContain("MATRIX_AUTH_ALLOW_INSECURE_DEV=1");
    expect(pkg.scripts["dev:mobile-shell"]).toContain("E2E_TEST_BYPASS=1");
    expect(pkg.scripts["dev:mobile-shell"]).toContain("NEXT_PUBLIC_E2E_TEST_BYPASS=1");
    expect(pkg.scripts["dev:mobile-shell"]).toContain("launch=__terminal__");
  });
});
