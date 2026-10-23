import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Preview runtime startup wiring", () => {
  it("uses the canonical app origin for host AI and speech configuration", () => {
    const source = readFileSync("packages/platform/src/platform-startup.ts", "utf8");

    expect(source).toContain("platformOrigin: appOrigin(),");
    expect(source).not.toContain(
      "platformOrigin: new URL(customerVpsConfig.platformRegisterUrl).origin,",
    );
  });
});
