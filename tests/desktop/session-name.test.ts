import { describe, expect, it } from "vitest";
import { friendlySessionName } from "@desktop/renderer/src/lib/session-name";

describe("friendlySessionName", () => {
  it("is a stable two-word adjective-noun label", () => {
    const a = friendlySessionName("matrix-9b2f8c3e");
    expect(a).toMatch(/^[a-z]+-[a-z]+$/);
    expect(friendlySessionName("matrix-9b2f8c3e")).toBe(a); // deterministic
  });

  it("varies across different attach names", () => {
    const names = new Set(
      ["matrix-a", "matrix-b", "matrix-c", "matrix-task-1", "matrix-9f3a2b"].map(friendlySessionName),
    );
    // Not all identical — the hash spreads inputs across the wordlists.
    expect(names.size).toBeGreaterThan(1);
  });
});
