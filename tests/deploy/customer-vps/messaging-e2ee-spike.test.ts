import { describe, expect, it } from "vitest";
import { messagingSpikesEnabled } from "./helpers/matrix-homeserver-fixtures.js";

describe("Messaging E2EE posture spike", () => {
  it("blocks Hermes delivery until encrypted-room key-sharing posture is proven", () => {
    const e2eePostureProven = process.env.MATRIX_MESSAGING_E2EE_POSTURE_PROVEN === "1";
    if (!messagingSpikesEnabled()) {
      expect(e2eePostureProven).toBe(false);
      return;
    }
    expect(e2eePostureProven).toBe(true);
  });
});
