import { describe, expect, it } from "vitest";
import {
  getBridgeSpikeConfig,
  runBridgeLifecycleSpike,
} from "./helpers/matrix-bridge-fixtures.js";
import { messagingSpikesEnabled } from "./helpers/matrix-homeserver-fixtures.js";

describe("WhatsApp bridge lifecycle spike", () => {
  it("defines pairing, inbound, outbound, and restart recovery checks", async () => {
    const result = await runBridgeLifecycleSpike(getBridgeSpikeConfig("whatsapp"));
    if (!messagingSpikesEnabled()) {
      expect(result.network).toBe("whatsapp");
      return;
    }
    expect(result.passed, result.reason).toBe(true);
  });
});
