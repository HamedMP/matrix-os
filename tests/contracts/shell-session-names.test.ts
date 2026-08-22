import { describe, expect, it } from "vitest";
import { createShellSessionName } from "@matrix-os/contracts";

describe("shell session names contract", () => {
  it("always creates plain two-word names", () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      expect(createShellSessionName()).toBe("swift-falcon");
    } finally {
      Math.random = originalRandom;
    }
  });

  it("generates lowercase two-segment names without suffix escape hatches", () => {
    for (let index = 0; index < 200; index += 1) {
      const name = createShellSessionName();
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
      expect(name.split("-")).toHaveLength(2);
    }
  });
});
