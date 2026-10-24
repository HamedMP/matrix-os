import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Preview runtime startup wiring", () => {
  it("separates the funded AI app origin from the host-pinned speech origin", () => {
    const source = readFileSync("packages/platform/src/platform-startup.ts", "utf8");

    expect(source).toContain("platformOrigin: appOrigin(),");
    expect(source).toContain(
      "speechPlatformOrigin: new URL(customerVpsConfig.platformRegisterUrl).origin,",
    );
    expect(source).not.toContain(
      "platformOrigin: new URL(customerVpsConfig.platformRegisterUrl).origin,",
    );
  });
});
