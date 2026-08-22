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
    expect(registration).toContain("hermes mcp remove matrix-integrations");
    expect(registration).toContain("hermes mcp add matrix-integrations --command /opt/matrix/bin/matrix-integrations-mcp");
    expect(registration).toContain("openclaw mcp unset matrix-integrations");
    expect(registration).toContain("openclaw mcp add matrix-integrations --command /opt/matrix/bin/matrix-integrations-mcp --no-probe");
    await expect(access(registrationPath, constants.X_OK)).resolves.toBeUndefined();
  });

  it("runs registration after optional agents are installed and during gateway boot", async () => {
    const developerTools = await readFile("distro/customer-vps/host-bin/matrix-install-developer-tools", "utf8");
    const hermes = await readFile("distro/customer-vps/host-bin/matrix-install-hermes", "utf8");
    const openclaw = await readFile("distro/customer-vps/host-bin/matrix-install-openclaw", "utf8");
    const gateway = await readFile("distro/customer-vps/host-bin/matrix-gateway", "utf8");

    expect(developerTools).toContain("matrix-register-integrations-mcp coding-agents");
    expect(hermes).toContain("matrix-register-integrations-mcp hermes");
    expect(openclaw).toContain("matrix-register-integrations-mcp openclaw");
    expect(gateway).toContain("matrix-register-integrations-mcp all");
  });

  it("applies one-time Matrix skill defaults after installing Hermes", async () => {
    const hermes = await readFile("distro/customer-vps/host-bin/matrix-install-hermes", "utf8");
    const build = await readFile("scripts/build-host-bundle.sh", "utf8");

    expect(hermes).toContain("configure-hermes-matrix-defaults.mjs");
    expect(build).toContain("configure-hermes-matrix-defaults.mjs");
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
