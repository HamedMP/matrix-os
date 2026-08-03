import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const installerPath = "distro/customer-vps/host-bin/matrix-install-openclaw";
const wrapperPath = "distro/customer-vps/host-bin/matrix-openclaw-gateway";
const controllerPath = "distro/customer-vps/host-bin/matrix-agent-runtime-control";
const unitPath = "distro/customer-vps/systemd/matrix-openclaw-gateway.service";
const legacyInstallUnitPath = "distro/customer-vps/systemd/matrix-openclaw-install.service";

describe("customer VPS OpenClaw runtime", () => {
  it("pins and integrity-checks the optional OpenClaw install", async () => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain('OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.7.1}"');
    expect(installer).toContain(
      'OPENCLAW_SHA512="${OPENCLAW_SHA512:-81efd7b2cf7d0870233cbfe29261ff505a223ab8dcc43078b16df2f66872083f9d616df0cd5ed329b015764ad7160006d9dd818e92687cff7bcd467eba6c68f2}"',
    );
    expect(installer).toContain("registry.npmjs.org/openclaw/-/openclaw-${OPENCLAW_VERSION}.tgz");
    expect(installer).toContain("--connect-timeout 10 --max-time 180");
    expect(installer).toContain("sha512sum -c");
    expect(installer).toContain("timeout 300");
    expect(installer).toContain('[ "$node_major" -eq 24 ] && [ "$node_minor" -lt 15 ]');
    expect(installer).toContain("npm-shrinkwrap.json");
    expect(installer).not.toContain("@latest");
  });

  it("fails admission before downloading on constrained hosts", async () => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain('memory_total_kib" -lt 3670016');
    expect(installer).not.toContain('memory_total_kib" -lt 4194304');
    expect(installer).toContain("MemAvailable");
    expect(installer).toContain("786432");
    expect(installer).toContain("1048576");
    expect(installer.indexOf("check_admission")).toBeLessThan(installer.indexOf("curl --fail"));
  });

  it("keeps the verified archive readable while dropping to the runtime user without PAM", async () => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain('chown "root:$MATRIX_RUNTIME_USER" "$tmp_dir" "$archive"');
    expect(installer).toContain('chmod 0750 "$tmp_dir"');
    expect(installer).toContain('chmod 0640 "$archive"');
    expect(installer).toContain('setpriv --reuid "$MATRIX_RUNTIME_USER" --regid "$MATRIX_RUNTIME_USER" --init-groups');
    expect(installer).toContain('run_installer_as_runtime_user env \\');
  });

  it("keeps gateway authentication out of argv and binds to loopback", async () => {
    const wrapper = await readFile(wrapperPath, "utf8");

    expect(wrapper).toContain('OPENCLAW_ENV_FILE="${OPENCLAW_ENV_FILE:-$MATRIX_RUNTIME_HOME/system/agent-runtime/openclaw.env}"');
    expect(wrapper).toContain("OPENCLAW_GATEWAY_TOKEN=[A-Fa-f0-9]{64}");
    expect(wrapper).not.toContain('source "$OPENCLAW_ENV_FILE"');
    expect(wrapper).toContain(': "${OPENCLAW_GATEWAY_TOKEN:?');
    expect(wrapper).toContain("gateway.mode local");
    expect(wrapper).toContain("gateway.bind loopback");
    expect(wrapper).toContain("gateway.auth.mode token");
    expect(wrapper).toContain("plugins.allow");
    expect(wrapper).toContain("tools.deny");
    expect(wrapper).toContain("config.tools?.allow === undefined");
    expect(wrapper).toContain("config.tools.allow.length === 0");
    expect(wrapper).toContain("runtime policy validation failed");
    expect(wrapper).toContain("gateway run --bind loopback --port 18789 --auth token");
    expect(wrapper).not.toMatch(/--token[ =]/);
  });

  it("uses a bounded, hardened owner service", async () => {
    const unit = await readFile(unitPath, "utf8");

    expect(unit).toContain("User=matrix");
    expect(unit).toContain("ExecStart=/opt/matrix/bin/matrix-openclaw-gateway");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StartLimitBurst=3");
    expect(unit).toContain("TimeoutStartSec=45");
    expect(unit).toContain("TimeoutStopSec=30");
    expect(unit).toContain("MemoryMax=1G");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/home/matrix/home/.openclaw /home/matrix/home/system/agent-runtime");
  });

  it("installs optional runtimes directly inside the validated root-owned host-control path", async () => {
    const controller = await readFile(controllerPath, "utf8");

    expect(controller).toContain('exec sudo -n /opt/matrix/bin/matrix-agent-runtime-control "$@"');
    expect(controller).toContain("install)");
    expect(controller).toContain("/opt/matrix/bin/matrix-install-hermes");
    expect(controller).toContain("/opt/matrix/bin/matrix-install-openclaw");
    expect(controller).toContain('timeout "$install_timeout_seconds" "$installer"');
    expect(controller).not.toContain('systemctl start "$unit"');
    await expect(access(legacyInstallUnitPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes only exact status, install, switch, and stop commands", async () => {
    const controller = await readFile(controllerPath, "utf8");

    expect(controller).toContain('case "${1:-}" in');
    expect(controller).toContain("status)");
    expect(controller).toContain("install)");
    expect(controller).toContain("switch)");
    expect(controller).toContain("stop)");
    expect(controller).toContain('case "${2:-}" in');
    expect(controller).toContain("hermes)");
    expect(controller).toContain("openclaw)");
    expect(controller).toContain("flock -w 30");
    expect(controller).toContain(
      'install -d -o "$MATRIX_RUNTIME_USER" -g "$MATRIX_RUNTIME_GROUP" -m 0700 "$lock_dir"',
    );
    const lockOpen = controller.indexOf('exec 9>"$lock_dir/host-control.lock"');
    const lockOwnerRepair = controller.indexOf(
      'chown "$MATRIX_RUNTIME_USER:$MATRIX_RUNTIME_GROUP" "$lock_dir/host-control.lock"',
    );
    const lockAcquire = controller.indexOf("flock -w 30");
    expect(lockOpen).toBeGreaterThan(-1);
    expect(lockOwnerRepair).toBeGreaterThan(lockOpen);
    expect(lockAcquire).toBeGreaterThan(lockOwnerRepair);
    expect(controller).toContain("matrix-hermes-dashboard.service");
    expect(controller).toContain("matrix-openclaw-gateway.service");
    expect(controller).toContain("systemctl is-active --quiet");
    expect(controller).toContain('systemctl disable --now "$other_unit"');
    expect(controller).toContain('systemctl enable --now "$target_unit"');
    expect(controller).toContain("action_timeout_seconds=50");
    expect(controller).toContain("active_wait_seconds=45");
    expect(controller).toContain('timeout "$action_timeout_seconds"');
    expect(controller).toContain("MemAvailable");
    expect(controller).toContain("1048576");
    const switchBody = controller.slice(
      controller.indexOf("switch_runtime()"),
      controller.indexOf('is_active "$other_unit"'),
    );
    expect(switchBody).toContain('*) printf \'{"ok":false,"code":"invalid_request"}\\n\'; exit 2 ;;');
    expect(controller).toContain('"code":"rollback_failed"');
    expect(controller).not.toContain("eval ");
    expect(controller).not.toContain('systemctl "$');
  });

  it("stages every runtime artifact and a compatible Node runtime", async () => {
    const build = await readFile("scripts/build-host-bundle.sh", "utf8");
    const cloudInit = await readFile("distro/customer-vps/cloud-init.yaml", "utf8");

    expect(build).toContain('HOST_BUNDLE_NODE_VERSION:-24.18.0');
    for (const name of [
      "matrix-install-openclaw",
      "matrix-openclaw-gateway",
      "matrix-agent-runtime-control",
    ]) {
      expect(build).toContain(`$STAGE_DIR/bin/${name}`);
      expect(cloudInit).toContain(name);
      await expect(access(`distro/customer-vps/host-bin/${name}`)).resolves.toBeUndefined();
    }
    expect(cloudInit).toContain("matrix-openclaw-gateway.service");
  });

  it("keeps every host entrypoint valid bash", async () => {
    for (const path of [installerPath, wrapperPath, controllerPath]) {
      await expect(execFileAsync("bash", ["-n", path])).resolves.toMatchObject({ stderr: "" });
    }
  });
});
