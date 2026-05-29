import { describe, expect, it } from "vitest";
import {
  getHomeserverSpikeConfig,
  messagingSpikesEnabled,
  runHomeserverAppserviceSpike,
} from "./helpers/matrix-homeserver-fixtures.js";

describe("Synapse messaging homeserver spike", () => {
  it("defines the Synapse appservice spike gate", async () => {
    const result = await runHomeserverAppserviceSpike(getHomeserverSpikeConfig("synapse"));
    if (!messagingSpikesEnabled()) {
      expect(result.candidate).toBe("synapse");
      return;
    }
    expect(result.passed, result.reason).toBe(true);
  });
});
