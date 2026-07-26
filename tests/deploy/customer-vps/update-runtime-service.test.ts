import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
    expect(service).toContain('Path("/run/matrix-update-runtime")');
    expect(service).toContain('"update.sock"');
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

  it("rejects malformed and privilege-expanding requests in the root parser", () => {
    const service = join(root, "distro/customer-vps/host-bin/matrix-update-service");
    const parser = String.raw`
import runpy
import sys

module = runpy.run_path(sys.argv[1])
try:
    module["parse_request"](sys.argv[2].encode("utf-8"))
except module["ProtocolError"]:
    raise SystemExit(1)
`;
    const valid = JSON.stringify({
      schemaVersion: 1,
      operation: "Apply",
      target: { kind: "version", value: "v2026.07.26-1" },
    });
    expect(spawnSync("python3", ["-c", parser, service, valid]).status).toBe(0);

    for (const invalid of [
      '{"schemaVersion":1,"operation":"Status","operation":"Rollback"}',
      '{"schemaVersion":1,"operation":"Apply","target":{"kind":"url","value":"https://attacker.invalid"}}',
      '{"schemaVersion":1,"operation":"Repair","path":"/opt/matrix/app"}',
      '{"schemaVersion":1,"operation":"Rollback","unit":"ssh.service"}',
      '{"schemaVersion":1,"operation":"Status","command":"systemctl"}',
      '{"schemaVersion":1,"operation":"Status","environment":{"TOKEN":"secret"}}',
    ]) {
      expect(spawnSync("python3", ["-c", parser, service, invalid]).status).toBe(1);
    }
  });

  it("runs the worker as root without sudo and preserves the terminal stop exclusion", () => {
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(updater).not.toMatch(/\bsudo\b/);
    expect(updater).toContain("matrix-symphony matrix-gateway matrix-shell");
    expect(updater).not.toMatch(/systemctl (?:stop|restart)[^\n]*matrix-terminal-session@/);
    expect(updater).not.toMatch(/systemctl (?:stop|restart)[^\n]*matrix-terminal\.slice/);
    expect(updater).not.toMatch(/systemctl (?:stop|restart)[^\n]*matrix-sync-agent/);
  });

  it("validates checksums and archive paths before extraction", () => {
    const validator = read("distro/customer-vps/host-bin/matrix-validate-host-bundle");
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(validator).toContain("MAX_ARCHIVE_MEMBERS");
    expect(validator).toContain("MAX_ARCHIVE_BYTES");
    expect(validator).not.toContain("getmembers()");
    expect(validator).toContain("member_count > MAX_ARCHIVE_MEMBERS");
    expect(validator).toContain("member.isdev()");
    expect(validator).toContain("member.isfifo()");
    expect(validator).toContain("member.mode & 0o6000");
    expect(validator).toContain("PurePosixPath");
    expect(validator).toContain("linkname");
    expect(updater).toContain("matrix-validate-host-bundle");
    expect(updater).toContain("sha256sum");
    expect(updater).toContain('--max-filesize "$expected_bundle_size"');
    expect(updater).toContain('actual_bundle_size="$(stat -c %s "$bundle_file")"');
    expect(updater).toContain('if [ "$actual_bundle_size" != "$expected_bundle_size" ]');
    expect(updater).not.toContain("WARNING: no SHA-256 available");
  });

  it("publishes operation state through collision-resistant root-owned temp files", () => {
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(updater).toContain('mktemp --tmpdir="$UPDATE_RUNTIME_DIR" .operation-state.XXXXXXXXXX');
    expect(updater).not.toContain('.operation-state.$$.tmp');
  });

  it("accepts an internal bundle symlink and rejects traversal and special members", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-host-archive-"));
    const validator = join(root, "distro/customer-vps/host-bin/matrix-validate-host-bundle");
    const fixtureScript = String.raw`
import io
import tarfile
import sys

kind, output = sys.argv[1:3]
with tarfile.open(output, "w:gz") as archive:
    app = tarfile.TarInfo("app/BUNDLE_VERSION")
    data = b"v2026.07.26-1"
    app.size = len(data)
    archive.addfile(app, io.BytesIO(data))
    if kind == "valid":
        current = tarfile.TarInfo("libexec/terminal-runtime/current")
        current.type = tarfile.SYMTYPE
        current.linkname = "v1/abc"
        archive.addfile(current)
    elif kind == "traversal":
        escape = tarfile.TarInfo("app/escape")
        escape.type = tarfile.SYMTYPE
        escape.linkname = "../../etc"
        archive.addfile(escape)
    elif kind == "fifo":
        fifo = tarfile.TarInfo("app/pipe")
        fifo.type = tarfile.FIFOTYPE
        archive.addfile(fifo)
    elif kind == "setuid":
        privileged = tarfile.TarInfo("bin/privileged")
        privileged.mode = 0o4755
        privileged.size = 0
        archive.addfile(privileged, io.BytesIO())
`;
    try {
      for (const kind of ["valid", "traversal", "fifo", "setuid"] as const) {
        const archive = join(directory, `${kind}.tar.gz`);
        const create = spawnSync("python3", ["-c", fixtureScript, kind, archive], {
          encoding: "utf8",
        });
        expect(create.status).toBe(0);
        const result = spawnSync(validator, [archive], { encoding: "utf8" });
        expect(result.status).toBe(kind === "valid" ? 0 : 1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
