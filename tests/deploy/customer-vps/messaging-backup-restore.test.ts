import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("customer VPS messaging backup and restore helpers", () => {
  it("backs up homeserver, bridge DBs, mappings, and permission tables", async () => {
    const backup = await readFile("distro/customer-vps/host-bin/matrix-messaging-backup", "utf8");

    expect(backup).toContain("synapse");
    expect(backup).toContain("mautrix-telegram");
    expect(backup).toContain("mautrix-whatsapp");
    expect(backup).toContain("messaging_permissions");
    expect(backup).toContain("messaging_conversation_mappings");
  });

  it("restore helper reports WhatsApp relink when backups are stale", async () => {
    const restore = await readFile("distro/customer-vps/host-bin/matrix-messaging-restore", "utf8");

    expect(restore).toContain("WHATSAPP_RELINK_AFTER_HOURS=24");
    expect(restore).toContain("relink_required");
    expect(restore).toContain("RTO_MINUTES=15");
  });
});
