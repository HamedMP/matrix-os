import { describe, expect, it } from "vitest";
import { resolveOwnerTelemetryDistinctId } from "../../packages/observability/src/index.ts";

describe("resolveOwnerTelemetryDistinctId", () => {
  it("prefers the Clerk user id over the handle", () => {
    expect(
      resolveOwnerTelemetryDistinctId({
        MATRIX_USER_ID: "user_2abcDEF",
        MATRIX_HANDLE: "neo",
      }),
    ).toBe("user_2abcDEF");
  });

  it("falls back to the Matrix handle when no user id is set", () => {
    expect(resolveOwnerTelemetryDistinctId({ MATRIX_HANDLE: "neo" })).toBe("neo");
  });

  it("returns undefined when neither env var is set", () => {
    expect(resolveOwnerTelemetryDistinctId({})).toBeUndefined();
  });

  it("ignores blank values", () => {
    expect(
      resolveOwnerTelemetryDistinctId({
        MATRIX_USER_ID: "   ",
        MATRIX_HANDLE: "neo",
      }),
    ).toBe("neo");
    expect(resolveOwnerTelemetryDistinctId({ MATRIX_USER_ID: "", MATRIX_HANDLE: "  " })).toBeUndefined();
  });
});
