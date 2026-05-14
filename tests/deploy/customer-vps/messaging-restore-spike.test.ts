import { describe, expect, it } from "vitest";
import { runBackupRestoreSpike } from "./helpers/matrix-bridge-fixtures.js";
import { messagingSpikesEnabled } from "./helpers/matrix-homeserver-fixtures.js";

describe("Messaging backup and restore spike", () => {
  it("defines restore checks for homeserver, bridge DBs, mappings, and WhatsApp relink", async () => {
    const result = await runBackupRestoreSpike();
    if (!messagingSpikesEnabled()) {
      expect(result.network).toBe("whatsapp");
      expect(result.checks).toHaveProperty("whatsappRelinkBoundary");
      await expect(runBackupRestoreSpike("telegram")).resolves.toMatchObject({ network: "telegram" });
      return;
    }
    expect(result.passed, result.reason).toBe(true);
  });
});
