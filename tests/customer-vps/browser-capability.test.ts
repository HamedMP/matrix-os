import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Customer VPS Browser capability", () => {
  it("ships a hardened browser systemd service", async () => {
    const unit = await readFile("distro/customer-vps/systemd/matrix-browser.service", "utf8");
    expect(unit).toContain("User=matrix");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("PrivateTmp=yes");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/home/matrix/home /var/lib/matrix-browser /tmp");
    expect(unit).toContain("MemoryMax=1536M");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).toContain("TimeoutStopSec=20");
    expect(unit).not.toContain("--no-sandbox");
  });
});
