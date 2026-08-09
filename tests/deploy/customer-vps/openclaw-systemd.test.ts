import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(installer).toContain('NODE_RUNTIME_VERSION="${NODE_RUNTIME_VERSION:-24.18.0}"');
    expect(installer).toContain(
      'NODE_RUNTIME_SHA256="${NODE_RUNTIME_SHA256:-783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8}"',
    );
    expect(installer).toContain("upgrade_bundled_node_runtime");
    expect(installer).toContain("npm-shrinkwrap.json");
    expect(installer).not.toContain("@latest");
  });

  it.each([
    ["22.22.3", true],
    ["22.23.0", true],
    ["23.11.1", false],
    ["24.14.1", false],
    ["24.15.0", true],
    ["25.8.9", false],
    ["25.9.0", true],
    ["26.0.0", true],
  ])("matches OpenClaw 2026.7.1's Node engine for %s", async (version, compatible) => {
    const invocation = `source "${installerPath}"; openclaw_node_is_compatible "$1"`;
    const result = execFileAsync("bash", ["-c", invocation, "openclaw-node-check", version]);
    if (compatible) {
      await expect(result).resolves.toMatchObject({ stderr: "" });
    } else {
      await expect(result).rejects.toMatchObject({ code: 1 });
    }
  });

  it("repairs a retained incompatible Node runtime before downloading OpenClaw", async () => {
    const installer = await readFile(installerPath, "utf8");
    const main = installer.slice(installer.indexOf("main()"));

    expect(main.indexOf("check_admission")).toBeLessThan(main.indexOf("ensure_compatible_node_runtime"));
    expect(main.indexOf("ensure_compatible_node_runtime")).toBeLessThan(main.indexOf('"$OPENCLAW_TARBALL_URL"'));
    expect(installer).toContain('mv -f "$replacement" "$MATRIX_NODE_PREFIX/bin/node"');
    expect(installer).toContain('openclaw_node_is_compatible "$installed_version"');
  });

  it("rechecks compatibility after repairing a retained Node runtime", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "matrix-openclaw-node-test-"));
    try {
      await mkdir(join(prefix, "bin"));
      await writeFile(join(prefix, "version"), "24.14.1\n");
      await writeFile(join(prefix, "bin/node"), `#!/usr/bin/env bash\ncat "${join(prefix, "version")}"\n`);
      await chmod(join(prefix, "bin/node"), 0o755);
      const invocation = [
        `source "${installerPath}"`,
        "MATRIX_NODE_PREFIX=\"$1\"",
        "upgrade_bundled_node_runtime() { printf '24.18.0\\n' >\"$MATRIX_NODE_PREFIX/version\"; }",
        "ensure_compatible_node_runtime",
      ].join("; ");

      await expect(execFileAsync("bash", ["-c", invocation, "node-repair", prefix]))
        .resolves.toMatchObject({ stderr: "" });
      expect(await readFile(join(prefix, "version"), "utf8")).toBe("24.18.0\n");
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
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

  it("keeps npm plugin repair cache out of the read-only owner home", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-openclaw-gateway-test-"));
    const runtimeHome = join(root, "home");
    const stateDir = join(runtimeHome, ".openclaw");
    const agentRuntimeDir = join(runtimeHome, "system/agent-runtime");
    const nodeBinDir = join(root, "node/bin");
    const privateTmpDir = join(root, "tmp");
    const openClawBin = join(nodeBinDir, "openclaw");
    const tokenPath = join(agentRuntimeDir, "openclaw.env");
    const capturedCachePath = join(stateDir, "captured-npm-cache");

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(agentRuntimeDir, { recursive: true });
      await mkdir(nodeBinDir, { recursive: true });
      await mkdir(privateTmpDir, { recursive: true });
      await writeFile(tokenPath, `OPENCLAW_GATEWAY_TOKEN=${"a".repeat(64)}\n`);
      await symlink(process.execPath, join(nodeBinDir, "node"));
      await writeFile(
        openClawBin,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          ': "${npm_config_cache:?npm cache must be configured}"',
          'mkdir -p "$npm_config_cache/_cacache"',
          'printf \'%s\\n\' "$npm_config_cache" >"$OPENCLAW_STATE_DIR/captured-npm-cache"',
        ].join("\n"),
      );
      await chmod(openClawBin, 0o755);
      await chmod(runtimeHome, 0o555);

      const env = { ...process.env };
      delete env.npm_config_cache;
      delete env.NPM_CONFIG_CACHE;

      await expect(execFileAsync("bash", [wrapperPath], {
        env: {
          ...env,
          MATRIX_RUNTIME_HOME: runtimeHome,
          MATRIX_NODE_PREFIX: join(root, "node"),
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
          OPENCLAW_ENV_FILE: tokenPath,
          OPENCLAW_BIN: openClawBin,
          TMPDIR: privateTmpDir,
        },
      })).resolves.toMatchObject({ stderr: "" });

      expect(await readFile(capturedCachePath, "utf8")).toBe(
        `${privateTmpDir}/matrix-openclaw/npm-cache\n`,
      );
      await expect(access(join(runtimeHome, ".npm"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(stateDir, "npm-cache"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(runtimeHome, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
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
