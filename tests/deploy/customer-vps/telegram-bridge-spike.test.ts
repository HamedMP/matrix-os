import { describe, expect, it } from "vitest";
import {
  getBridgeSpikeConfig,
  runBridgeLifecycleSpike,
} from "./helpers/matrix-bridge-fixtures.js";
import { messagingSpikesEnabled } from "./helpers/matrix-homeserver-fixtures.js";

describe("Telegram bridge lifecycle spike", () => {
  it("defines inbound, outbound, and restart recovery checks", async () => {
    const result = await runBridgeLifecycleSpike(getBridgeSpikeConfig("telegram"));
    if (!messagingSpikesEnabled()) {
      expect(result.network).toBe("telegram");
      return;
    }
    expect(result.passed, result.reason).toBe(true);
  });
});
