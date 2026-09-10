import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dormant scope runtime host bundle", () => {
  it("installs a least-privilege system supervisor that is fenced by the app marker", async () => {
    const unit = await readFile("distro/customer-vps/systemd/matrix-scope-runtime.service", "utf8");
    expect(unit).toContain("User=root");
    expect(unit).toContain("Group=matrix");
    expect(unit).toContain("ConditionPathExists=!/opt/matrix/app/SCOPE_RUNTIME_DISABLED");
    expect(unit).toContain("RuntimeDirectory=matrix-scope-runtime");
    expect(unit).toContain("RuntimeDirectoryMode=0770");
    expect(unit).toContain("StateDirectory=matrix-scope-runtime");
    expect(unit).toContain("PrivateNetwork=yes");
    expect(unit).toContain("ProtectHome=yes");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("CapabilityBoundingSet=");
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(unit).not.toContain("EnvironmentFile=");
    const gatewayUnit = await readFile("distro/customer-vps/systemd/matrix-gateway.service", "utf8");
    expect(gatewayUnit).toContain("Wants=matrix-scope-runtime.service");
    expect(gatewayUnit).toMatch(/After=.*matrix-scope-runtime\.service/);
  });

  it("builds and starts the supervisor before gateway while policy keeps M2 independently gated", async () => {
    const build = await readFile("scripts/build-host-bundle.sh", "utf8");
    const cloudInit = await readFile("distro/customer-vps/cloud-init.yaml", "utf8");
    const updater = await readFile("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");
    const wrapper = await readFile("distro/customer-vps/host-bin/matrix-scope-runtime", "utf8");

    expect(build).toContain("pnpm --filter '@matrix-os/scope-runtime' build");
    expect(build).not.toContain('printf \'1\\n\' > "$STAGE_DIR/app/SCOPE_RUNTIME_DISABLED"');
    expect(build).toContain('"$STAGE_DIR/bin/matrix-scope-runtime"');
    expect(wrapper).toContain("packages/scope-runtime/dist/main.js");
    expect(cloudInit).toMatch(/systemctl enable[^\n]*matrix-scope-runtime/);
    expect(cloudInit).toMatch(/systemctl start[^\n]*matrix-scope-runtime/);
    expect(updater).toMatch(/systemctl enable[^\n]*matrix-scope-runtime/);
    expect(updater).toMatch(/systemctl start[^\n]*matrix-scope-runtime/);
    expect(updater).toMatch(/systemctl stop[^\n]*matrix-scope-runtime/);
  });
});
