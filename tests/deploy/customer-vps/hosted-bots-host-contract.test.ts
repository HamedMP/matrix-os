import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Hosted Bots customer host contract", () => {
  it("provisions a persistent gateway state directory from the installed bundle unit", async () => {
    const [unit, cloudInit, updater] = await Promise.all([
      readFile("distro/customer-vps/systemd/matrix-gateway.service", "utf8"),
      readFile("distro/customer-vps/cloud-init.yaml", "utf8"),
      readFile("distro/customer-vps/host-bin/matrix-sync-agent", "utf8"),
    ]);
    expect(unit.match(/^StateDirectory=.*$/gm)).toEqual(["StateDirectory=matrix-hosted-bots"]);
    expect(unit.match(/^StateDirectoryMode=.*$/gm)).toEqual(["StateDirectoryMode=0700"]);
    expect(cloudInit).toMatch(/install -o root -g root -m 0644 \/opt\/matrix\/systemd\/\*\.service \/etc\/systemd\/system\/\n[\s\S]*systemctl start matrix-gateway\.service/);
    expect(updater).toContain('find "$extract_dir/systemd" -maxdepth 1 -name \'matrix-*.service\' -exec install -o root -g root -m 0644 {} /etc/systemd/system/');
  });

  it("packages the license and notice alongside compiled gateway code", async () => {
    const build = await readFile("scripts/build-host-bundle.sh", "utf8");
    expect(build).toContain('HOSTED_BOTS_NOTICE_DIR="$STAGE_DIR/app/packages/gateway/dist/hosted-bots/upstream"');
    expect(build).toContain('install -m 0644 "$HOSTED_BOTS_SOURCE_DIR/LICENSE" "$HOSTED_BOTS_SOURCE_DIR/NOTICE" "$HOSTED_BOTS_NOTICE_DIR/"');
    expect(build).toMatch(/tar -C "\$STAGE_DIR" -czf .*\bbin app runtime systemd\b/);
  });
});
