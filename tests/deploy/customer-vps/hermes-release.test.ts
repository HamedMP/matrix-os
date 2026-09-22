import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { describe, expect, it } from "vitest";

const installerPath = "distro/customer-vps/host-bin/matrix-install-hermes";
const servicePath = "distro/customer-vps/systemd/matrix-hermes.service";

describe("customer VPS Hermes release", () => {
  it("pins the verified upstream release by immutable commit", async () => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain('HERMES_RELEASE="${HERMES_RELEASE:-v2026.9.21}"');
    expect(installer).toContain(
      'HERMES_COMMIT="${HERMES_COMMIT:-d337b736aa1e8ebecfab043842d13e4a2d2f48a3}"',
    );
    expect(installer).toContain(
      'https://raw.githubusercontent.com/NousResearch/hermes-agent/$HERMES_COMMIT/scripts/install.sh',
    );
    expect(installer).toContain(
      'bash "$HERMES_INSTALLER_PATH" --branch main --commit "$HERMES_COMMIT" --force-commit --skip-setup',
    );
    expect(installer).not.toContain("NousResearch/hermes-agent/main/scripts/install.sh");
  });

  it("keeps owner state outside the managed source update", async () => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain('HERMES_HOME="${HERMES_HOME:-$MATRIX_RUNTIME_HOME/.hermes}"');
    expect(installer).not.toMatch(/rm\s+-rf\s+[^\n]*\$HERMES_HOME/);
    expect(installer).toContain("restore_hermes_dashboard");
    expect(installer).toContain("trap restore_hermes_dashboard EXIT");
  });

  it("ships the installer unit and schedules upgrades after host-bundle updates", async () => {
    const service = await readFile(servicePath, "utf8");
    const updater = await readFile("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");

    expect(service).toContain("ExecStart=/opt/matrix/bin/matrix-install-hermes");
    expect(service).toContain("TimeoutStartSec=1800");
    expect(updater).toContain('if [ -f "$extract_dir/systemd/matrix-hermes.service" ]; then');
    expect(updater).toContain("systemctl enable matrix-hermes.service");
    expect(updater).toContain("systemctl restart --no-block matrix-hermes.service");
    await expect(access(servicePath, constants.R_OK)).resolves.toBeUndefined();
  });
});
