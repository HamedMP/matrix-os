import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("root-owned typed update service", () => {
  it("installs a root service with an owner-only peer-authenticated socket", () => {
    const unit = read("distro/customer-vps/systemd/matrix-sync-agent.service");
    const service = read("distro/customer-vps/host-bin/matrix-update-service");

    expect(unit).toContain("User=root");
    expect(unit).toContain("Group=root");
    expect(unit).toContain("ExecStart=/opt/matrix/bin/matrix-update-service");
    expect(service).toContain("SO_PEERCRED");
    expect(service).toContain("MAX_FRAME_BYTES = 128 * 1024");
    expect(service).toContain('ALLOWED_OPERATIONS = {"Apply", "Repair", "Rollback", "Status"}');
    expect(service).toContain("/run/matrix-update-runtime/update.sock");
    expect(service).toContain("matrix-sync-agent");
    expect(service).toContain("--worker");
  });

  it("accepts no caller-provided URLs, paths, units, commands, or environment", () => {
    const service = read("distro/customer-vps/host-bin/matrix-update-service");
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(service).not.toContain('request["url"]');
    expect(service).not.toContain('request["path"]');
    expect(service).not.toContain('request["unit"]');
    expect(service).not.toContain('request["command"]');
    expect(service).not.toContain('request["environment"]');
    expect(updater).toContain("PLATFORM_INTERNAL_URL");
    expect(updater).not.toContain("bundle_url=\"$(json_field \"$manifest\" url)\"");
  });

  it("runs the worker as root without sudo and preserves the terminal stop exclusion", () => {
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(updater).not.toMatch(/\bsudo\b/);
    expect(updater).toContain("matrix-symphony matrix-gateway matrix-shell");
    expect(updater).not.toMatch(/systemctl (?:stop|restart)[^\n]*matrix-terminal/);
    expect(updater).not.toMatch(/systemctl (?:stop|restart)[^\n]*matrix-sync-agent/);
  });

  it("validates checksums and archive paths before extraction", () => {
    const validator = read("distro/customer-vps/host-bin/matrix-validate-host-bundle");
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(validator).toContain("MAX_ARCHIVE_MEMBERS");
    expect(validator).toContain("MAX_ARCHIVE_BYTES");
    expect(validator).toContain("member.isdev()");
    expect(validator).toContain("member.isfifo()");
    expect(validator).toContain("PurePosixPath");
    expect(validator).toContain("linkname");
    expect(updater).toContain("matrix-validate-host-bundle");
    expect(updater).toContain("sha256sum");
    expect(updater).not.toContain("WARNING: no SHA-256 available");
  });

  it("ships the service, validator, socket client, and root unit in host bundles", () => {
    const build = read("scripts/build-host-bundle.sh");
    const cloudInit = read("distro/customer-vps/cloud-init.yaml");
    const cli = read("distro/customer-vps/host-bin/matrix-update");

    expect(build).toContain("matrix-update-service");
    expect(build).toContain("matrix-validate-host-bundle");
    expect(cloudInit).toContain("matrix-update-service");
    expect(cli).toContain("/run/matrix-update-runtime/update.sock");
    expect(cli).not.toContain("/opt/matrix/app/.update-now");
    expect(cli).not.toContain("/opt/matrix/app/.rollback-now");
  });
});
