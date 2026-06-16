import { describe, expect, it } from "vitest";
import { isStandaloneRuntime, shouldRunStandaloneDaemon } from "../../src/cli/standalone-runtime.js";

describe("isStandaloneRuntime", () => {
  it("requires both the baked standalone env marker and Bun runtime", () => {
    expect(
      isStandaloneRuntime(
        { MATRIX_CLI_STANDALONE: "1" },
        { bun: "1.3.13" },
      ),
    ).toBe(true);
    expect(
      isStandaloneRuntime(
        { MATRIX_CLI_STANDALONE: "1" },
        {},
      ),
    ).toBe(false);
    expect(
      isStandaloneRuntime(
        {},
        { bun: "1.3.13" },
      ),
    ).toBe(false);
  });
});

describe("shouldRunStandaloneDaemon", () => {
  it("only dispatches __daemon inside standalone binaries", () => {
    expect(
      shouldRunStandaloneDaemon(
        ["__daemon"],
        { MATRIX_CLI_STANDALONE: "1" },
        { bun: "1.3.13" },
      ),
    ).toBe(true);
    expect(
      shouldRunStandaloneDaemon(
        ["__daemon"],
        {},
        { bun: "1.3.13" },
      ),
    ).toBe(false);
    expect(
      shouldRunStandaloneDaemon(
        ["sync"],
        { MATRIX_CLI_STANDALONE: "1" },
        { bun: "1.3.13" },
      ),
    ).toBe(false);
  });
});
