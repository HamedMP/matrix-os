import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { describe, expect, it } from "vitest";

const registrationPath = "distro/customer-vps/host-bin/matrix-register-integrations-mcp";
const launcherPath = "distro/customer-vps/host-bin/matrix-integrations-mcp";
const terminalPath = "distro/customer-vps/host-bin/matrix-integrations";

describe("customer VPS integrations MCP wiring", () => {
  it("ships an executable stdio launcher that sources only Matrix host identity", async () => {
    const launcher = await readFile(launcherPath, "utf8");

    expect(launcher).toContain("/opt/matrix/env/host.env");
    expect(launcher).toContain("packages/integrations-mcp/dist/cli.js");
    expect(launcher).toContain("exec /usr/bin/env -i");
    expect(launcher).not.toContain("PIPEDREAM_");
    await expect(access(launcherPath, constants.X_OK)).resolves.toBeUndefined();
  });

  it("ships a credential-isolating terminal fallback for agents without native MCP", async () => {
    const terminal = await readFile(terminalPath, "utf8");

    expect(terminal).toContain("exec /usr/bin/env -i");
    expect(terminal).toContain("packages/integrations-mcp/dist/command-cli.js");
    expect(terminal).not.toContain("PIPEDREAM_");
    await expect(access(terminalPath, constants.X_OK)).resolves.toBeUndefined();
  });

  it("idempotently registers the same local MCP server with Codex, Claude, Hermes, and OpenClaw", async () => {
    const registration = await readFile(registrationPath, "utf8");

    expect(registration).toContain("codex mcp remove matrix-integrations");
    expect(registration).toContain("codex mcp add matrix-integrations -- /opt/matrix/bin/matrix-integrations-mcp");
    expect(registration).toContain("claude mcp remove matrix-integrations");
    expect(registration).toContain("claude mcp add --transport stdio --scope user matrix-integrations -- /opt/matrix/bin/matrix-integrations-mcp");
    expect(registration).toContain("configure-hermes-matrix-defaults.mjs");
    expect(registration).not.toContain("hermes mcp add matrix-integrations");
    expect(registration).toContain("openclaw mcp unset matrix-integrations");
    expect(registration).toContain("openclaw mcp add matrix-integrations --command /opt/matrix/bin/matrix-integrations-mcp --no-probe");
    await expect(access(registrationPath, constants.X_OK)).resolves.toBeUndefined();
  });

  it("runs registration after optional agents are installed without blocking gateway boot", async () => {
    const developerTools = await readFile("distro/customer-vps/host-bin/matrix-install-developer-tools", "utf8");
    const hermes = await readFile("distro/customer-vps/host-bin/matrix-install-hermes", "utf8");
    const openclaw = await readFile("distro/customer-vps/host-bin/matrix-install-openclaw", "utf8");
    const gateway = await readFile("distro/customer-vps/host-bin/matrix-gateway", "utf8");

    expect(developerTools).toContain("matrix-register-integrations-mcp coding-agents");
    expect(hermes).toContain("matrix-register-integrations-mcp hermes");
    expect(openclaw).toContain("matrix-register-integrations-mcp openclaw");
    expect(gateway).not.toContain("matrix-register-integrations-mcp all");
  });

  it("reconciles Codex, Claude, and Hermes registrations on boot and bundle updates", async () => {
    const unit = await readFile(
      "distro/customer-vps/systemd/matrix-integrations-agents.service",
      "utf8",
    );
    const cloudInit = await readFile("distro/customer-vps/cloud-init.yaml", "utf8");
    const updater = await readFile("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");

    expect(unit).toContain("After=matrix-hermes.service matrix-developer-tools.service");
    expect(unit).toContain("ExecStart=/opt/matrix/bin/matrix-register-integrations-mcp all");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=60");
    expect(cloudInit).toContain("install -o root -g root -m 0644 /opt/matrix/systemd/*.service");
    expect(cloudInit).toContain("systemctl enable matrix-integrations-agents.service");
    expect(cloudInit).toContain("systemctl start --no-block matrix-integrations-agents.service");
    expect(updater).toContain('if [ -f "$extract_dir/systemd/matrix-integrations-agents.service" ]; then');
    expect(updater).toContain("sudo systemctl enable matrix-integrations-agents.service");
    expect(updater).toContain("sudo systemctl restart --no-block matrix-integrations-agents.service");
  });

  it("keeps certified snapshots from before integrations MCP bootable", async () => {
    const cloudInit = await readFile("distro/customer-vps/cloud-init.yaml", "utf8");
    const integrationBins = [
      "matrix-integrations",
      "matrix-integrations-mcp",
      "matrix-register-integrations-mcp",
    ];
    const requiredBins = cloudInit.match(/for required_bin in ([^;]+); do/)?.[1]?.split(" ") ?? [];
    const optionalBins = cloudInit.match(/for optional_bin in ([^;]+); do/)?.[1]?.split(" ") ?? [];

    expect(requiredBins).not.toEqual(expect.arrayContaining(integrationBins));
    expect(optionalBins).toEqual(expect.arrayContaining(integrationBins));
    expect(cloudInit).toContain(
      'if [ -f /etc/systemd/system/matrix-integrations-agents.service ] && [ -x /opt/matrix/bin/matrix-register-integrations-mcp ]; then',
    );
  });

  it("applies one-time Matrix skill defaults after installing Hermes", async () => {
    const hermes = await readFile("distro/customer-vps/host-bin/matrix-install-hermes", "utf8");
    const build = await readFile("scripts/build-host-bundle.sh", "utf8");

    expect(hermes).toContain("configure-hermes-matrix-defaults.mjs");
    expect(build).toContain("configure-hermes-matrix-defaults.mjs");
  });

  it("teaches agents to prefer native MCP tools over the terminal fallback", async () => {
    const skill = await readFile("skills/matrix/integrations/SKILL.md", "utf8");

    expect(skill).toContain("Prefer the native Matrix integrations MCP tools");
    expect(skill).toContain("Only use the bundled `matrix-integrations` command when MCP tools are unavailable");
  });

  it("packages the MCP launchers as host-bundle executables", async () => {
    const build = await readFile("scripts/build-host-bundle.sh", "utf8");
    const cloudInit = await readFile("distro/customer-vps/cloud-init.yaml", "utf8");

    expect(build).toContain('"$STAGE_DIR/bin/matrix-integrations-mcp"');
    expect(build).toContain('"$STAGE_DIR/bin/matrix-integrations"');
    expect(build).toContain('"$STAGE_DIR/bin/matrix-register-integrations-mcp"');
    expect(cloudInit).toContain("matrix-integrations matrix-integrations-mcp matrix-register-integrations-mcp");
  });
});
