import { describe, expect, it } from "vitest";
import {
  getHomeserverSpikeConfig,
  messagingSpikesEnabled,
  runHomeserverAppserviceSpike,
} from "./helpers/matrix-homeserver-fixtures.js";

describe("Conduit messaging homeserver spike", () => {
  it("defines the Conduit appservice spike gate", async () => {
    const result = await runHomeserverAppserviceSpike(getHomeserverSpikeConfig("conduit"));
    if (!messagingSpikesEnabled()) {
      expect(result.candidate).toBe("conduit");
      return;
    }
    expect(result.passed, result.reason).toBe(true);
  });
});
