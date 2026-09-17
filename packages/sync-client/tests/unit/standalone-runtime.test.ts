import { describe, expect, it, vi } from "vitest";
import {
  isStandaloneRuntime,
  shouldRunDesktopActivation,
  shouldRunDesktopEnrollment,
  shouldRunDesktopRevocation,
  shouldRunStandaloneDaemon,
} from "../../src/cli/standalone-runtime.js";

describe("isStandaloneRuntime", () => {
  it("uses the baked standalone marker when no test env is injected", async () => {
    const previousMarker = process.env.MATRIX_CLI_STANDALONE;
    process.env.MATRIX_CLI_STANDALONE = "1";
    vi.resetModules();
    const module = await import("../../src/cli/standalone-runtime.js");

    try {
      expect(module.isStandaloneRuntime(undefined, { bun: "1.3.13" })).toBe(true);
      expect(module.isStandaloneRuntime({}, { bun: "1.3.13" })).toBe(false);
    } finally {
      if (previousMarker === undefined) {
        delete process.env.MATRIX_CLI_STANDALONE;
      } else {
        process.env.MATRIX_CLI_STANDALONE = previousMarker;
      }
      vi.resetModules();
    }
  });

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

describe("shouldRunDesktopActivation", () => {
  it("exposes service activation only from a standalone helper", () => {
    expect(shouldRunDesktopActivation(
      ["__desktop-activate"],
      { MATRIX_CLI_STANDALONE: "1" },
      { bun: "1.3.13" },
    )).toBe(true);
    expect(shouldRunDesktopActivation(
      ["__desktop-activate"],
      {},
      { bun: "1.3.13" },
    )).toBe(false);
  });
});

describe("shouldRunDesktopRevocation", () => {
  it("exposes Desktop grant revocation only from a standalone helper", () => {
    expect(shouldRunDesktopRevocation(
      ["__desktop-revoke"],
      { MATRIX_CLI_STANDALONE: "1" },
      { bun: "1.3.13" },
    )).toBe(true);
    expect(shouldRunDesktopRevocation(
      ["__desktop-revoke"],
      {},
      { bun: "1.3.13" },
    )).toBe(false);
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

describe("shouldRunDesktopEnrollment", () => {
  it("keeps the credential handoff entrypoint unavailable to source runtimes", () => {
    expect(shouldRunDesktopEnrollment(
      ["__desktop-enroll"],
      { MATRIX_CLI_STANDALONE: "1" },
      { bun: "1.3.13" },
    )).toBe(true);
    expect(shouldRunDesktopEnrollment(
      ["__desktop-enroll"],
      {},
      { bun: "1.3.13" },
    )).toBe(false);
  });
});
