import { describe, expect, it } from "vitest";
import { runMediaBackfillSpike } from "./helpers/matrix-bridge-fixtures.js";
import { messagingSpikesEnabled } from "./helpers/matrix-homeserver-fixtures.js";

describe("Messaging media and backfill spike", () => {
  it("defines bounded media and latest-100 backfill checks", async () => {
    const result = await runMediaBackfillSpike();
    if (!messagingSpikesEnabled()) {
      expect(result.checks).toHaveProperty("latestHundredBackfill");
      return;
    }
    expect(result.passed, result.reason).toBe(true);
  });
});
