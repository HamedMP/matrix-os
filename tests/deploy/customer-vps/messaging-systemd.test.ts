import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("customer VPS messaging systemd units", () => {
  it("defines Synapse, Telegram bridge, and WhatsApp bridge services", async () => {
    const homeserver = await readFile("distro/customer-vps/systemd/matrix-homeserver.service", "utf8");
    const telegram = await readFile("distro/customer-vps/systemd/matrix-bridge-telegram.service", "utf8");
    const whatsapp = await readFile("distro/customer-vps/systemd/matrix-bridge-whatsapp.service", "utf8");

    expect(homeserver).toContain("ExecStart=/opt/matrix/messaging/bin/synapse");
    expect(telegram).toContain("ExecStart=/opt/matrix/messaging/bin/mautrix-telegram");
    expect(whatsapp).toContain("ExecStart=/opt/matrix/messaging/bin/mautrix-whatsapp");
    expect(homeserver).toContain("StateDirectory=matrix-messaging");
    for (const unit of [homeserver, telegram, whatsapp]) {
      expect(unit).toContain("Environment=MATRIX_MESSAGING_ROOT=/var/lib/matrix-messaging");
      expect(unit).toContain("EnvironmentFile=-/etc/matrix/messaging.env");
      expect(unit).toContain("ConditionPathExists=/opt/matrix/messaging/bin/");
      expect(unit).not.toContain("HC_Volume_");
    }
  });
});
