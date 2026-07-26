import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("customer VPS privilege boundary", () => {
  it("replaces unrestricted sudo with only typed Matrix helpers", () => {
    const cloudInit = read("distro/customer-vps/cloud-init.yaml");

    expect(cloudInit).not.toContain("NOPASSWD:ALL");
    expect(cloudInit).toContain(
      "matrix ALL=(root) NOPASSWD: /opt/matrix/bin/matrix-update *",
    );
    expect(cloudInit).toContain(
      "matrix ALL=(root) NOPASSWD: /opt/matrix/bin/matrix-tool-pack-control *",
    );
    expect(cloudInit).toContain(
      "matrix ALL=(root) NOPASSWD: /opt/matrix/bin/matrix-symphony-control *",
    );

    const sudoersBlock = cloudInit.match(
      /cat >\/etc\/sudoers\.d\/matrix <<'EOF'\n([\s\S]*?)\n    EOF/,
    )?.[1] ?? "";
    expect(sudoersBlock).not.toMatch(/\bsystemctl\b/);
    expect(sudoersBlock).not.toMatch(/\b(?:sh|bash|env|install|cp|mv|rm|tee)\b/);
  });

  it("migrates existing VPSes to the same exact sudoers boundary atomically", () => {
    const syncAgent = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(syncAgent).toContain("install_matrix_sudoers");
    expect(syncAgent).toContain("/etc/sudoers.d/.matrix.next");
    expect(syncAgent).toContain("visudo -cf");
    expect(syncAgent).toContain('mv -f -- "$sudoers_next" /etc/sudoers.d/matrix');
    expect(syncAgent.indexOf("install_update_runtime_bins")).toBeLessThan(
      syncAgent.indexOf("install_matrix_sudoers"),
    );
  });

  it("maps tool-pack requests only to fixed root oneshot units", () => {
    const helperPath = resolve(
      root,
      "distro/customer-vps/host-bin/matrix-tool-pack-control",
    );
    const helper = read("distro/customer-vps/host-bin/matrix-tool-pack-control");

    expect(helper).toContain("coding-agents:matrix-developer-tools.service");
    expect(helper).toContain("code-server:matrix-code-server.service");
    expect(helper).toContain("hermes:matrix-hermes.service");
    expect(helper).toContain("linux-tools:matrix-linux-tools.service");
    expect(helper).not.toContain("eval ");
    expect(helper).not.toContain("systemctl $");

    expect(() => execFileSync(helperPath, ["../../bin/sh"], {
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow();
  });

  it("routes gateway tool installs through the typed helper without owner data in argv or env", () => {
    const gatewayInstaller = read(
      "packages/gateway/src/onboarding/tool-packs.ts",
    );

    expect(gatewayInstaller).toContain(
      '"/opt/matrix/bin/matrix-tool-pack-control"',
    );
    expect(gatewayInstaller).not.toContain("MATRIX_TOOL_PACK_OWNER_ID");
    expect(gatewayInstaller).not.toContain(
      '"/opt/matrix/bin/matrix-install-tool-pack"',
    );
  });

  it("makes code-server and developer-tool installation root-oneshot only", () => {
    const code = read("distro/customer-vps/host-bin/matrix-code");
    const codeUnit = read("distro/customer-vps/systemd/matrix-code.service");
    const installer = read(
      "distro/customer-vps/host-bin/matrix-install-tool-pack",
    );
    const linuxInstaller = read(
      "distro/customer-vps/host-bin/matrix-install-linux-tools",
    );

    expect(code).not.toContain("sudo");
    expect(code).not.toContain("attempting install");
    expect(codeUnit).toContain("After=matrix-restore.service matrix-code-server.service");
    expect(codeUnit).toContain("Wants=matrix-code-server.service");
    expect(installer).toContain("matrix-install-tool-pack: root_required");
    expect(linuxInstaller).toContain("matrix-install-linux-tools: root_required");
    expect(installer).not.toContain("sudo systemctl");
    expect(linuxInstaller).not.toMatch(/\bsudo\s/);
  });

  it("keeps Symphony control exact and rejects arbitrary service operations", () => {
    const helperPath = resolve(
      root,
      "distro/customer-vps/host-bin/matrix-symphony-control",
    );
    const helper = read(
      "distro/customer-vps/host-bin/matrix-symphony-control",
    );

    expect(helper).toContain('UNIT="matrix-symphony.service"');
    expect(helper).toContain(
      "sudo -n /opt/matrix/bin/matrix-symphony-control",
    );
    expect(helper).not.toContain("sudo systemctl");
    expect(() => execFileSync(helperPath, ["restart"], {
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow();
  });
});
