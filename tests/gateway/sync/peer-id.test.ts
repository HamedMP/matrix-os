import { describe, expect, it } from "vitest";
import { sanitizePeerId } from "../../../packages/gateway/src/sync/peer-id.js";

describe("sanitizePeerId", () => {
  it("preserves valid peer ids", () => {
    expect(sanitizePeerId("peer-123")).toBe("peer-123");
  });

  it("truncates oversized peer ids to the manifest schema limit", () => {
    const oversized = "a".repeat(512);
    expect(sanitizePeerId(oversized)).toBe("a".repeat(128));
  });

  it("falls back to unknown for empty values", () => {
    expect(sanitizePeerId("")).toBe("unknown");
    expect(sanitizePeerId(undefined)).toBe("unknown");
  });
});
