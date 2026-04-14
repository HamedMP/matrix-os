import { describe, it, expect } from "vitest";
import {
  RUNTIME_VERSION,
  assertRuntimeCompatible,
} from "../../../packages/gateway/src/app-runtime/runtime-version.js";
import { ManifestError } from "../../../packages/gateway/src/app-runtime/errors.js";

describe("RUNTIME_VERSION", () => {
  it("is a valid semver string", () => {
    expect(RUNTIME_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("assertRuntimeCompatible", () => {
  it("accepts compatible semver range ^1.0.0 when runtime is 1.0.0", () => {
    expect(() =>
      assertRuntimeCompatible({ runtimeVersion: "^1.0.0" }),
    ).not.toThrow();
  });

  it("accepts exact match 1.0.0", () => {
    expect(() =>
      assertRuntimeCompatible({ runtimeVersion: "1.0.0" }),
    ).not.toThrow();
  });

  it("accepts compatible minor range ^1.0.0 for runtime 1.x.x", () => {
    // This should work as long as RUNTIME_VERSION satisfies ^1.0.0
    expect(() =>
      assertRuntimeCompatible({ runtimeVersion: "^1.0.0" }),
    ).not.toThrow();
  });

  it("accepts tilde range ~1.0.0", () => {
    expect(() =>
      assertRuntimeCompatible({ runtimeVersion: "~1.0.0" }),
    ).not.toThrow();
  });

  it("rejects incompatible major version ^2.0.0", () => {
    expect(() =>
      assertRuntimeCompatible({ runtimeVersion: "^2.0.0" }),
    ).toThrow(ManifestError);
    try {
      assertRuntimeCompatible({ runtimeVersion: "^2.0.0" });
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).code).toBe("runtime_version_mismatch");
    }
  });

  it("rejects incompatible future version ^99.0.0", () => {
    expect(() =>
      assertRuntimeCompatible({ runtimeVersion: "^99.0.0" }),
    ).toThrow(ManifestError);
  });

  it("rejects incompatible exact version 2.0.0", () => {
    expect(() =>
      assertRuntimeCompatible({ runtimeVersion: "2.0.0" }),
    ).toThrow(ManifestError);
  });

  it("treats missing runtimeVersion as pre-1.0 (^0.0.0)", () => {
    // An app with no runtimeVersion is assumed to be a pre-1.0 app
    // which is incompatible with the 1.0.0 runtime
    expect(() =>
      assertRuntimeCompatible({ runtimeVersion: undefined }),
    ).toThrow(ManifestError);
    try {
      assertRuntimeCompatible({ runtimeVersion: undefined });
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).code).toBe("runtime_version_mismatch");
    }
  });
});
