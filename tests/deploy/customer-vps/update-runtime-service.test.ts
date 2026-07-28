import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("root-owned typed update service", () => {
  it("installs a root service with an owner-only peer-authenticated socket", () => {
    const unit = read("distro/customer-vps/systemd/matrix-update-runtime.service");
    const legacyBridge = read("distro/customer-vps/systemd/matrix-sync-agent.service");
    const gateway = read("distro/customer-vps/systemd/matrix-gateway.service");
    const service = read("distro/customer-vps/host-bin/matrix-update-service");

    expect(unit).toContain("User=root");
    expect(unit).toContain("Group=root");
    expect(unit).toContain("ExecStart=/opt/matrix/bin/matrix-update-service");
    expect(legacyBridge).toContain("Wants=matrix-update-runtime.service");
    expect(legacyBridge).toContain("After=matrix-update-runtime.service");
    expect(legacyBridge).toContain("Type=oneshot");
    expect(legacyBridge).toContain("ExecStart=/usr/bin/true");
    expect(legacyBridge).toContain("RemainAfterExit=yes");
    expect(legacyBridge).not.toContain("matrix-update-service");
    expect(gateway).toContain("Wants=matrix-update-runtime.service");
    expect(gateway).toContain("After=matrix-update-runtime.service");
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

  it("retires the enabled legacy bridge only after a healthy root-service update", () => {
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");
    const healthy = updater.indexOf('if [ "$healthy" = true ]; then');
    const enableRuntime = updater.indexOf(
      "systemctl enable matrix-update-runtime.service",
      healthy,
    );
    const disableLegacy = updater.indexOf(
      "systemctl disable matrix-sync-agent.service",
      healthy,
    );

    expect(healthy).toBeGreaterThan(-1);
    expect(enableRuntime).toBeGreaterThan(healthy);
    expect(disableLegacy).toBeGreaterThan(enableRuntime);
    expect(updater).not.toContain(
      "systemctl restart matrix-update-runtime.service",
    );
    expect(updater).not.toContain(
      "systemctl stop matrix-update-runtime.service",
    );
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

  it("keeps supervised activation dormant unless the bundle carries the fixed marker", () => {
    const build = read("scripts/build-host-bundle.sh");
    const validator = read("distro/customer-vps/host-bin/matrix-validate-host-bundle");
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(validator).toContain('"terminal-runtime-activation"');
    expect(build).toContain(
      'activation_source="$ROOT_DIR/distro/customer-vps/terminal-runtime-activation"',
    );
    expect(build).toContain(
      'install -m 0644 "$activation_source" "$STAGE_DIR/terminal-runtime-activation"',
    );
    expect(build).toContain('bundle_members+=(terminal-runtime-activation)');
    expect(updater).toContain("validate_terminal_runtime_activation()");
    expect(updater).toContain(
      'activation_file="$extract_dir/terminal-runtime-activation"',
    );
    expect(updater).toContain(
      '[ "$(cat "$activation_file")" = "supervised-v1" ]',
    );
    expect(updater).toContain('terminal_runtime_activation="supervised-v1"');
  });

  it("migrates and readies supervised runtime state before starting its gateway", () => {
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");
    const activationCheck = updater.indexOf(
      'if [ "$terminal_runtime_activation" = "supervised-v1" ]; then',
    );
    const migration = updater.indexOf(
      "/opt/matrix/bin/matrix-terminal-runtime-op migrate-legacy",
      activationCheck,
    );
    const supervisorReady = updater.indexOf(
      'log "Terminal runtime supervisor ready"',
      migration,
    );
    const gatewayStart = updater.indexOf(
      "systemctl start matrix-gateway matrix-shell",
      supervisorReady,
    );

    expect(activationCheck).toBeGreaterThan(-1);
    expect(migration).toBeGreaterThan(activationCheck);
    expect(supervisorReady).toBeGreaterThan(migration);
    expect(gatewayStart).toBeGreaterThan(supervisorReady);
    expect(updater).not.toContain("--force-run-commands");
  });

  it("installs and rolls back the optional preview proof helper with the host layer", () => {
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(updater).toContain('name="matrix-terminal-spike-control"');
    expect(updater).toContain(
      'rm -f -- "$BIN_DIR/matrix-terminal-spike-control"',
    );
    expect(updater).toContain(
      '"$BIN_DIR/matrix-terminal-spike-control"; do',
    );
    expect(updater).toContain(
      'matrix-terminal-runtime-op \\\n    matrix-terminal-spike-control; do',
    );
  });

  it("publishes operation state through collision-resistant root-owned temp files", () => {
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");

    expect(updater).toContain('mktemp --tmpdir="$UPDATE_RUNTIME_DIR" .operation-state.XXXXXXXXXX');
    expect(updater).not.toContain('.operation-state.$$.tmp');
  });

  it("resumes a root-published request without signaling the worker before its handler is ready", () => {
    const service = join(root, "distro/customer-vps/host-bin/matrix-update-service");
    const regression = String.raw`
import json
import pathlib
import runpy
import signal
import sys
import tempfile

module = runpy.run_path(sys.argv[1])
runtime_globals = module["_resume_pending_request"].__globals__
with tempfile.TemporaryDirectory() as directory:
    request_path = pathlib.Path(directory) / "request.json"
    request_path.write_text(json.dumps({
        "schemaVersion": 1,
        "operation": "Repair",
    }), encoding="utf-8")
    request_path.chmod(0o600)
    runtime_globals["REQUEST_PATH"] = request_path
    states = []
    signals = []
    runtime_globals["_write_state"] = states.append
    runtime_globals["os"].kill = lambda pid, signum: signals.append((pid, signum))
    worker = type("Worker", (), {"pid": 4242, "poll": lambda self: None})()
    module["_resume_pending_request"](worker, expected_owner_uid=runtime_globals["os"].getuid())
    assert states == ["running"]
    assert signals == []
`;
    expect(spawnSync("python3", ["-c", regression, service]).status).toBe(0);
  });

  it("commits the busy state before publishing without signaling the worker", () => {
    const service = join(root, "distro/customer-vps/host-bin/matrix-update-service");
    const regression = String.raw`
import runpy
import signal
import sys

module = runpy.run_path(sys.argv[1])
runtime_globals = module["_serve_connection"].__globals__
events = []
responses = []

runtime_globals["_peer_uid"] = lambda connection: 1000
runtime_globals["read_frame"] = lambda connection: (
    b'{"schemaVersion":1,"operation":"Repair"}'
)
runtime_globals["_read_state"] = lambda: "idle"
runtime_globals["publish_request"] = lambda request: events.append("publish") or True
runtime_globals["_write_state"] = lambda state: events.append(f"state:{state}")
runtime_globals["os"].kill = (
    lambda pid, signum: events.append(f"signal:{pid}:{signum}")
)

class Connection:
    def settimeout(self, timeout):
        assert timeout == 10

    def sendall(self, payload):
        responses.append(payload)

class Worker:
    pid = 4242

    def poll(self):
        return None

module["_serve_connection"](Connection(), 1000, Worker())
assert events == [
    "state:running",
    "publish",
]
assert len(responses) == 1
assert b'"status":"accepted"' in responses[0]
`;
    expect(spawnSync("python3", ["-c", regression, service]).status).toBe(0);
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");
    expect(updater).toContain('if [ -f "$TYPED_REQUEST" ]; then');
    expect(updater).toContain("sleep 6");
  });

  it("clears an orphaned running state when request publication loses no queued work", () => {
    const service = join(root, "distro/customer-vps/host-bin/matrix-update-service");
    const regression = String.raw`
import pathlib
import runpy
import sys
import tempfile

module = runpy.run_path(sys.argv[1])
runtime_globals = module["_serve_connection"].__globals__
states = []
responses = []

runtime_globals["_peer_uid"] = lambda connection: 1000
runtime_globals["read_frame"] = lambda connection: (
    b'{"schemaVersion":1,"operation":"Repair"}'
)
runtime_globals["_read_state"] = lambda: "idle"
runtime_globals["publish_request"] = lambda request: False
runtime_globals["_write_state"] = states.append

class Connection:
    def settimeout(self, timeout):
        assert timeout == 10

    def sendall(self, payload):
        responses.append(payload)

class Worker:
    pid = 4242

    def poll(self):
        return None

with tempfile.TemporaryDirectory() as directory:
    runtime_globals["REQUEST_PATH"] = pathlib.Path(directory) / "request.json"
    module["_serve_connection"](Connection(), 1000, Worker())

assert states == ["running", "idle"]
assert len(responses) == 1
assert b'"code":"busy"' in responses[0]
`;
    expect(spawnSync("python3", ["-c", regression, service]).status).toBe(0);
  });

  it("preserves running state when a concurrently published request wins", () => {
    const service = join(root, "distro/customer-vps/host-bin/matrix-update-service");
    const regression = String.raw`
import pathlib
import runpy
import sys
import tempfile

module = runpy.run_path(sys.argv[1])
runtime_globals = module["_serve_connection"].__globals__
states = []

runtime_globals["_peer_uid"] = lambda connection: 1000
runtime_globals["read_frame"] = lambda connection: (
    b'{"schemaVersion":1,"operation":"Repair"}'
)
runtime_globals["_read_state"] = lambda: "idle"
runtime_globals["_write_state"] = states.append

class Connection:
    def settimeout(self, timeout):
        assert timeout == 10

    def sendall(self, payload):
        pass

class Worker:
    pid = 4242

    def poll(self):
        return None

with tempfile.TemporaryDirectory() as directory:
    request_path = pathlib.Path(directory) / "request.json"
    runtime_globals["REQUEST_PATH"] = request_path
    def collide(request):
        request_path.write_text("{}", encoding="utf-8")
        return False
    runtime_globals["publish_request"] = collide
    module["_serve_connection"](Connection(), 1000, Worker())

assert states == ["running"]
`;
    expect(spawnSync("python3", ["-c", regression, service]).status).toBe(0);
  });

  it("reports a claimed operation as failed instead of replaying it after restart", () => {
    const service = join(root, "distro/customer-vps/host-bin/matrix-update-service");
    const updater = read("distro/customer-vps/host-bin/matrix-sync-agent");
    const regression = String.raw`
import json
import pathlib
import runpy
import sys
import tempfile

module = runpy.run_path(sys.argv[1])
runtime_globals = module["_recover_interrupted_operation"].__globals__
with tempfile.TemporaryDirectory() as directory:
    inflight_path = pathlib.Path(directory) / "inflight.json"
    inflight_path.write_text(json.dumps({
        "schemaVersion": 1,
        "operation": "Rollback",
    }), encoding="utf-8")
    inflight_path.chmod(0o600)
    runtime_globals["INFLIGHT_PATH"] = inflight_path
    states = []
    runtime_globals["_write_state"] = states.append
    interrupted = module["_recover_interrupted_operation"](
        expected_owner_uid=runtime_globals["os"].getuid()
    )
    assert interrupted is True
    assert states == ["failed"]
    assert not inflight_path.exists()
`;
    expect(spawnSync("python3", ["-c", regression, service]).status).toBe(0);
    expect(updater).toContain('readonly INFLIGHT_REQUEST="$UPDATE_RUNTIME_DIR/inflight.json"');
    expect(updater).toContain("os.link(path, inflight_path, follow_symlinks=False)");
    expect(updater).toContain('set_operation_state failed');
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
    const logship = read("distro/customer-vps/host-bin/matrix-install-logship");
    const activity = read("packages/gateway/src/system-activity/collector.ts");

    expect(build).toContain("matrix-update-service");
    expect(build).toContain("matrix-validate-host-bundle");
    expect(cloudInit).toContain(
      "path: /etc/systemd/system/matrix-update-runtime.service",
    );
    expect(cloudInit).toContain("matrix-update-service");
    expect(cloudInit).toContain(
      "systemctl enable matrix-update-runtime.service",
    );
    expect(cloudInit).toContain(
      "systemctl start matrix-update-runtime.service",
    );
    expect(cloudInit).not.toContain(
      "systemctl enable matrix-restore.service matrix-gateway.service matrix-shell.service matrix-code-server.service matrix-code.service matrix-sync-agent.service",
    );
    expect(cli).toContain("/run/matrix-update-runtime/update.sock");
    expect(cli).not.toContain("/opt/matrix/app/.update-now");
    expect(cli).not.toContain("/opt/matrix/app/.rollback-now");
    expect(logship).toContain(
      'matches       = "_SYSTEMD_UNIT=matrix-update-runtime.service"',
    );
    expect(activity).toContain('"matrix-update-runtime"');
    expect(activity).not.toContain(
      '["matrix-gateway", "matrix-shell", "matrix-code", "matrix-sync-agent"]',
    );
  });
});
