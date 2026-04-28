import { describe, expect, it } from "vitest";
import {
  isNewer,
  normalizeMatrixReleaseTag,
} from "../../shell/src/components/settings/sections/SystemSection";

describe("SystemSection version helpers", () => {
  it("ignores CLI releases when choosing Matrix OS app releases", () => {
    expect(normalizeMatrixReleaseTag("cli-v0.2.4")).toBeNull();
    expect(normalizeMatrixReleaseTag("v0.2.4")).toBe("0.2.4");
  });

  it("does not mark dev builds as older than semver releases", () => {
    expect(isNewer("0.2.4", "dev")).toBe(false);
  });

  it("compares app semver releases", () => {
    expect(isNewer("0.2.4", "0.2.3")).toBe(true);
    expect(isNewer("0.2.4", "0.2.4")).toBe(false);
    expect(isNewer("0.2.3", "0.2.4")).toBe(false);
  });
});
