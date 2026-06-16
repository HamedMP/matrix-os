import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCliVersionFromPackage } from "../../src/cli/version.js";

describe("resolveCliVersionFromPackage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs unexpected package version read failures before using the fallback", () => {
    const warn = vi.fn();

    expect(
      resolveCliVersionFromPackage(
        () => {
          throw new Error("package read failed");
        },
        { warn },
      ),
    ).toBe("0.0.0");
    expect(warn).toHaveBeenCalledWith(
      "[cli/version] failed to read package version:",
      "package read failed",
    );
  });
});
