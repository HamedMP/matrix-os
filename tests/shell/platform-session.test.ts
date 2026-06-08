import { describe, expect, it } from "vitest";
import {
  MATRIX_PLATFORM_SESSION_HEADER,
  hasServerVerifiedMatrixSession,
} from "../../shell/src/lib/platform-session";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("platform session detection", () => {
  it("accepts the shell proxy's internal native app session marker", () => {
    expect(hasServerVerifiedMatrixSession(headers({
      [MATRIX_PLATFORM_SESSION_HEADER]: "native",
    }))).toBe(true);
  });

  it("does not trust forwarded platform identity headers directly", () => {
    expect(hasServerVerifiedMatrixSession(headers({
      "x-platform-user-id": "user_alice",
      "x-platform-verified": "signed-proof",
    }))).toBe(false);
  });

  it("rejects oversized internal markers", () => {
    expect(hasServerVerifiedMatrixSession(headers({
      [MATRIX_PLATFORM_SESSION_HEADER]: "x".repeat(513),
    }))).toBe(false);
  });
});
