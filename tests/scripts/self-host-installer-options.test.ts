import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Spec 2701 layer 4: installer questions, run user, access mode and generated
// config. These tests source the real installer (functions only) and assert the
// values and files a reviewer would otherwise only see on a live VPS.
const root = process.cwd();
const script = join(root, "scripts/install-server.sh");

function run(body: string, env: Record<string, string> = {}) {
  const result = spawnSync("bash", ["-c", `set -Eeuo pipefail\nsource "$INSTALLER"\n${body}`], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      INSTALLER: script,
      MATRIX_INSTALL_SOURCE_ONLY: "1",
      MATRIX_INSTALL_NONINTERACTIVE: "1",
      MATRIX_INSTALL_COLOR: "never",
      MATRIX_NO_TELEMETRY: "1",
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("self-host installer options", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matrix-installer-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses flags into the install choices", () => {
    const result = run(
      `parse_args --user alice --no-herdr --no-browser --access headscale --login-server https://hs.example.com --authkey-file /root/key
printf '%s|%s|%s|%s|%s|%s\\n' "$OPT_RUN_USER" "$OPT_HERDR" "$OPT_BROWSER" "$OPT_ACCESS" "$OPT_LOGIN_SERVER" "$OPT_AUTHKEY_FILE"`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("alice|off|off|headscale|https://hs.example.com|/root/key");
  });

  it("defaults to Tailscale with browser use and leaves Herdr undecided until detection", () => {
    const result = run(`parse_args\nprintf '%s|%s|%s\\n' "$OPT_ACCESS" "$OPT_BROWSER" "$OPT_HERDR"`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("tailscale|on|");
  });

  it("treats a login server without an access mode as Headscale", () => {
    const result = run(`parse_args --login-server https://hs.example.com\nfinalize_access_choice\nprintf '%s\\n' "$OPT_ACCESS"`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("headscale");
  });

  it("rejects unknown flags, bad access modes and non-https login servers", () => {
    expect(run("parse_args --bogus").status).not.toBe(0);
    expect(run("parse_args --access ssh").status).not.toBe(0);
    const insecure = run("parse_args --access headscale --login-server http://hs.example.com\nfinalize_access_choice");
    expect(insecure.status).not.toBe(0);
    expect(insecure.stderr).toContain("--login-server must be an https URL");
    const missing = run("parse_args --access headscale\nfinalize_access_choice");
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("--access headscale needs --login-server");
  });

  it("never accepts root as the run user", () => {
    const explicit = run("parse_args --user root\nresolve_run_user");
    expect(explicit.status).not.toBe(0);
    expect(explicit.stderr).toContain("Matrix must not run as root");
    const viaSudo = run("parse_args\nresolve_run_user", { SUDO_USER: "root" });
    expect(viaSudo.status).not.toBe(0);
  });

  it("defaults the run user to SUDO_USER and its home to ~/matrix", () => {
    const result = run(
      `getent() { [ "$1" = passwd ] && [ "$2" = alice ] && printf 'alice:x:1001:1001::/home/alice:/bin/bash\\n'; }
id() { if [ "\${1:-}" = -gn ]; then printf 'alice\\n'; else command id "$@"; fi; }
parse_args
resolve_run_user
printf '%s|%s|%s|%s\\n' "$MATRIX_RUN_USER" "$MATRIX_RUN_USER_HOME" "$MATRIX_HOME_DIR" "$MATRIX_RUN_GROUP"`,
      { SUDO_USER: "alice", MATRIX_EXISTING_HOST_ENV: join(dir, "missing.env") },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("alice|/home/alice|/home/alice/matrix|alice");
  });

  it("keeps the legacy matrix layout for an existing install and refuses to switch accounts", () => {
    const legacy = join(dir, "host.env");
    writeFileSync(legacy, "MATRIX_SELF_HOSTED=1\nMATRIX_HOME=/home/matrix/home\n");
    const keep = run(
      `getent() { [ "$1" = passwd ] && [ "$2" = matrix ] && printf 'matrix:x:999:999::/home/matrix/home:/bin/bash\\n'; }
id() { if [ "\${1:-}" = -gn ]; then printf 'matrix\\n'; else command id "$@"; fi; }
parse_args
resolve_run_user
printf '%s|%s\\n' "$MATRIX_RUN_USER" "$MATRIX_HOME_DIR"`,
      { SUDO_USER: "alice", MATRIX_EXISTING_HOST_ENV: legacy },
    );
    expect(keep.status, keep.stderr).toBe(0);
    expect(keep.stdout.trim()).toBe("matrix|/home/matrix/home");
    const switching = run("parse_args --user alice\nresolve_run_user", { MATRIX_EXISTING_HOST_ENV: legacy });
    expect(switching.status).not.toBe(0);
    expect(switching.stderr).toContain("already runs Matrix as matrix");
  });

  it("creates a missing --user account instead of stopping on the passwd lookup", () => {
    // getent exits 2 for an unknown account; under set -e and pipefail that
    // used to end the installer before ensure_matrix_user could create it.
    const missing = `getent() { return 2; }\n`;
    const named = run(
      `${missing}parse_args --user alice
resolve_run_user
printf '%s|%s|%s|%s\\n' "$MATRIX_RUN_USER" "$MATRIX_RUN_USER_HOME" "$MATRIX_HOME_DIR" "$MATRIX_RUN_GROUP"`,
      { MATRIX_EXISTING_HOST_ENV: join(dir, "missing.env") },
    );
    expect(named.status, named.stderr).toBe(0);
    expect(named.stdout.trim()).toBe("alice|/home/alice|/home/alice/matrix|alice");
    const fallback = run(
      `${missing}parse_args
resolve_run_user
printf '%s|%s\\n' "$MATRIX_RUN_USER" "$MATRIX_HOME_DIR"`,
      { MATRIX_EXISTING_HOST_ENV: join(dir, "missing.env") },
    );
    expect(fallback.status, fallback.stderr).toBe(0);
    expect(fallback.stdout.trim()).toBe("matrix|/home/matrix/home");
  });

  it("keeps MATRIX_HOME inside the run user's home", () => {
    const result = run(
      `getent() { printf 'alice:x:1001:1001::/home/alice:/bin/bash\\n'; }
id() { if [ "\${1:-}" = -gn ]; then printf 'alice\\n'; else command id "$@"; fi; }
parse_args --user alice
resolve_run_user`,
      { MATRIX_HOME: "/srv/elsewhere", MATRIX_EXISTING_HOST_ENV: join(dir, "missing.env") },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MATRIX_HOME must stay under /home/alice");
  });

  it("writes systemd drop-ins that run Matrix as the person, without editing shipped units", () => {
    const result = run(`render_run_user_dropin alice alice`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[Service]\nUser=alice\nGroup=alice\nSupplementaryGroups=matrix docker\n");
    const zellij = run(`render_zellij_home_dropin /home/alice/matrix`);
    expect(zellij.stdout).toContain("ConditionPathExists=\nConditionPathExists=/home/alice/matrix/system/terminal-runtimes/%i.json");
    expect(zellij.stdout).toContain("Environment=MATRIX_HOME=/home/alice/matrix");
  });

  it("installs and enables the collaboration scope runtime the gateway wants", () => {
    // Found on a self-hosted laptop: matrix-gateway.service Wants= the scope
    // runtime, but the installer never installed its unit.
    const units = readFileSync(script, "utf8").split("\ninstall_systemd_units() {")[1]!.split("\n}\n")[0]!;
    expect(units).toContain("install -m 0644 /opt/matrix/systemd/matrix-scope-runtime.service /etc/systemd/system/matrix-scope-runtime.service");
    expect(units).toMatch(/systemctl enable [^\n]*matrix-scope-runtime/);
    const start = readFileSync(script, "utf8").split("\nstart_services() {")[1]!.split("\n}\n")[0]!;
    expect(start.indexOf("matrix-scope-runtime")).toBeGreaterThan(-1);
    expect(start.indexOf("matrix-scope-runtime")).toBeLessThan(start.indexOf("restart_required_service matrix-gateway"));
  });

  it("points the scope runtime at a self-host Matrix home outside /home/matrix", () => {
    // The supervisor stays root:matrix like managed VPSes; only its home and the
    // read-only workload roots behind ProtectHome=tmpfs move.
    const result = run(`render_scope_runtime_home_dropin /home/alice/matrix`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[Service]\nEnvironment=MATRIX_HOME=/home/alice/matrix\n");
    for (const root of ["bots", "agent-workspaces", "projects", "worktrees"]) {
      expect(result.stdout).toContain(`BindReadOnlyPaths=-/home/alice/matrix/${root}\n`);
    }
    expect(result.stdout).not.toContain("User=");
  });

  describe("scope runtime workload roots", () => {
    // Found in review: the gateway creates agent-workspaces/<owner>/<chat> as the
    // owner with 0750, so without setgid those children took the owner's group
    // and the capability-free root:matrix supervisor could not traverse them.
    function prepare(owner: string, existing: Record<string, string>, symlinks: string[] = []) {
      const home = join(dir, "home");
      spawnSync("mkdir", ["-p", home]);
      for (const root of Object.keys(existing)) spawnSync("mkdir", ["-p", join(home, root, "owner-data")]);
      for (const root of symlinks) spawnSync("ln", ["-s", dir, join(home, root)]);
      const owners = Object.entries(existing).map(([root, user]) => `*/${root}) echo ${user} ;;`).join("\n    ");
      const result = run(
        `install() { printf 'install %s\\n' "$*" >>"${join(dir, "calls")}"; }
chgrp() { printf 'chgrp %s\\n' "$*" >>"${join(dir, "calls")}"; }
chmod() { printf 'chmod %s\\n' "$*" >>"${join(dir, "calls")}"; }
stat() {
  case "\${@: -1}" in
    ${owners || "*/never) ;;"}
    *) echo nobody ;;
  esac
}
prepare_scope_runtime_roots "${home}" ${owner}`,
      );
      const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : [];
      return { result, home, calls };
    }

    it("creates missing roots setgid matrix, private to the owner and the matrix group", () => {
      const { result, home, calls } = prepare("alice", {});
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual(["bots", "agent-workspaces", "projects", "worktrees"].map(
        (root) => `install -d -o alice -g matrix -m 2750 ${home}/${root}`,
      ));
    });

    it("moves only an existing owner root itself into private setgid group matrix, never its contents", () => {
      const { result, home, calls } = prepare("alice", { projects: "alice", "agent-workspaces": "alice", bots: "root" }, ["worktrees"]);
      expect(result.status, result.stderr).toBe(0);
      // The exact commands bound the operations to these roots and forbid extra flags.
      expect(calls).toEqual([
        `chgrp matrix ${home}/agent-workspaces`,
        `chmod g+s,o-rwx ${home}/agent-workspaces`,
        `chgrp matrix ${home}/projects`,
        `chmod g+s,o-rwx ${home}/projects`,
      ]);
    });

    it("leaves projects to this step on self-host, so it is never created world-readable", () => {
      // Nothing outside the owner and the matrix group reads projects: nginx only
      // proxies to loopback services, code-server and the gateway run as the
      // owner, and scope workloads get their one workspace by bind mount.
      const ensure = readFileSync(script, "utf8").split("\nensure_matrix_user() {")[1]!.split("\n}\n")[0]!;
      const worldReadable = ensure.split("\n").filter((line) => line.includes("-m 0755") && line.includes("/projects"));
      expect(worldReadable).toHaveLength(1);
      expect(ensure).toMatch(/if \[ "\$MATRIX_RUN_USER" = "matrix" \]; then\n\s+install -d [^\n]*-m 0755 "\$MATRIX_HOME_DIR\/projects"/);
    });

    it("moves Pi workspaces an earlier install created into group matrix, and nothing else", () => {
      // Found in review: an upgraded install already had
      // agent-workspaces/<owner-key>/<chat> in the owner's group, so setgid on the
      // root alone left Pi Chats unable to start. Only those two gateway-managed
      // levels are fixed; chat contents and anything else stay as they were.
      const home = join(dir, "home");
      const key = "a".repeat(64);
      const workspaces = join(home, "agent-workspaces");
      for (const path of [
        join(workspaces, key, "chat_abc123", "src"),
        join(workspaces, key, "notes"),
        join(workspaces, "b".repeat(64), "chat_foreign"),
        join(workspaces, "owner-data"),
      ]) spawnSync("mkdir", ["-p", path]);
      spawnSync("ln", ["-s", dir, join(workspaces, key, "chat_link")]);
      for (const root of ["bots", "projects", "worktrees"]) spawnSync("mkdir", ["-p", join(home, root)]);
      const result = run(
        `chgrp() { printf 'chgrp %s\\n' "$*" >>"${join(dir, "calls")}"; }
chmod() { printf 'chmod %s\\n' "$*" >>"${join(dir, "calls")}"; }
install() { printf 'install %s\\n' "$*" >>"${join(dir, "calls")}"; }
stat() { case "\${@: -1}" in *chat_foreign) echo root ;; *) echo alice ;; esac; }
prepare_scope_runtime_roots "${home}" alice`,
      );
      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
      expect(calls).toContain(`chgrp matrix ${workspaces}/${key}`);
      expect(calls).toContain(`chmod g+s ${workspaces}/${key}`);
      expect(calls).toContain(`chgrp matrix ${workspaces}/${key}/chat_abc123`);
      expect(calls).toContain(`chmod g+s ${workspaces}/${key}/chat_abc123`);
      const relativeCalls = calls.map((call) => call.replace(`${home}/`, "")).join("\n");
      expect(relativeCalls).not.toMatch(/chat_abc123\/src|notes|chat_foreign|chat_link|owner-data|(?:^|\s)(?:-R|--recursive)(?=\s|$)/);
    });

    it("keeps the legacy matrix layout exactly as before", () => {
      const { result, home, calls } = prepare("matrix", { projects: "matrix" });
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual(["bots", "agent-workspaces", "worktrees"].map(
        (root) => `install -d -o matrix -g matrix -m 0750 ${home}/${root}`,
      ));
    });

  });

  it("grants the run user Matrix's group-only paths by ACL, so an already-running login works", () => {
    // The person is usually logged in while installing. Their systemd --user
    // manager (which also runs their Herdr core) keeps the groups it started
    // with, so the new matrix group alone cannot open /opt/matrix until it
    // restarts, and restarting it would end their Herdr terminals.
    const fake = join(dir, "setfacl");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, "calls")}"\n`);
    chmodSync(fake, 0o755);
    const result = run(`MATRIX_SETFACL="${fake}" grant_run_user_access alice "${dir}/opt"`);
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    // A named-user entry wins over the matrix group, so it must match the
    // group's rwx on /opt/matrix (found on a fresh VPS: the database gate could
    // not write its marker file).
    expect(calls).toContain(`-m u:alice:rwx ${dir}/opt`);
    expect(calls).toContain(`-R -m u:alice:rX ${dir}/opt/env ${dir}/opt/bin ${dir}/opt/tls`);
    expect(calls).toContain(`-d -m u:alice:rX ${dir}/opt/env ${dir}/opt/tls`);
  });

  it("does nothing for the legacy matrix run user", () => {
    const fake = join(dir, "setfacl");
    writeFileSync(fake, `#!/bin/sh\necho called >> "${join(dir, "calls")}"\n`);
    chmodSync(fake, 0o755);
    const result = run(`MATRIX_SETFACL="${fake}" grant_run_user_access matrix "${dir}/opt"`);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(dir, "calls"))).toBe(false);
  });

  it("records the installed bundle version where updates and browser use read it", () => {
    // Managed computers write app/BUNDLE_VERSION at first boot; browser use and
    // Settings > Updates fail without it.
    const opt = join(dir, "opt");
    spawnSync("mkdir", ["-p", join(opt, "app")]);
    writeFileSync(join(opt, "release.json"), '{\n  "version": "v2026.11.21-pr3533-1-1-abc1234",\n  "channel": "none"\n}\n');
    const result = run(`write_bundle_version "${opt}" "$(id -un)"`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(opt, "app", "BUNDLE_VERSION"), "utf8")).toBe("v2026.11.21-pr3533-1-1-abc1234\n");
  });

  it.each(["v2026.11.21", "3f9c2ab", "3f9c2ab-dirty", "v2026.11.21-4-g3f9c2ab-dirty"])(
    "accepts the %s version format the bundle builder can produce",
    (version) => {
      // build-host-bundle.sh falls back to `git describe --tags --always --dirty`,
      // which is a bare commit hash (maybe -dirty) when no tag is reachable.
      const opt = join(dir, "opt");
      spawnSync("mkdir", ["-p", join(opt, "app")]);
      writeFileSync(join(opt, "release.json"), `{\n  "version": "${version}",\n  "channel": "none"\n}\n`);
      const result = run(`write_bundle_version "${opt}" "$(id -un)"`);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(opt, "app", "BUNDLE_VERSION"), "utf8")).toBe(`${version}\n`);
    },
  );

  it.each(["../../etc/passwd", "v1/../x", "v1..2", ".hidden", "-rf", "v1 2", "v".repeat(129)])(
    "refuses the unsafe release version %s",
    (version) => {
      const opt = join(dir, "opt");
      spawnSync("mkdir", ["-p", join(opt, "app")]);
      writeFileSync(join(opt, "release.json"), `{\n  "version": "${version}",\n  "channel": "none"\n}\n`);
      const result = run(`write_bundle_version "${opt}" "$(id -un)"`);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(opt, "app", "BUNDLE_VERSION"))).toBe(false);
    },
  );

  it("refuses a release version that is not a plain version string", () => {
    const opt = join(dir, "opt");
    spawnSync("mkdir", ["-p", join(opt, "app")]);
    writeFileSync(join(opt, "release.json"), '{"version": "../../etc/passwd"}\n');
    const result = run(`write_bundle_version "${opt}" "$(id -un)"`);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(opt, "app", "BUNDLE_VERSION"))).toBe(false);
  });

  it("serves the UI only on loopback with an owner identity check in private modes", () => {
    const result = run(`render_nginx_site tailscale _ /etc/nginx/matrix-self-host.htpasswd on`);
    expect(result.status, result.stderr).toBe(0);
    const site = result.stdout;
    expect(site).toContain("listen 127.0.0.1:80 default_server;");
    expect(site).not.toContain("listen 80 default_server;");
    expect(site).not.toContain("auth_basic \"Matrix OS\"");
    expect(site).toContain("auth_request /_matrix_private_network_identity;");
    expect(site).toContain("location = /_matrix_private_network_identity {");
    expect(site).toContain("internal;");
    expect(site).toContain("proxy_pass http://127.0.0.1:4000/api/system/private-network/identity;");
    expect(site).toContain("location = /apps/browser-lab/viewer/websockify {");
  });

  // Review (security): a local account could send the owner's Tailscale-User-Login to
  // nginx on loopback and get the bearer; only Tailscale Serve's root-only socket may now.
  it("accepts a tailnet identity only over the root-only Tailscale Serve socket", () => {
    const site = run(`render_nginx_site tailscale _ /etc/nginx/matrix-self-host.htpasswd off`).stdout;
    expect(site).toContain("listen 127.0.0.1:80 default_server;");
    expect(site).toContain("listen unix:/run/matrix-nginx/tailnet.sock;");
    expect(site).toContain(`map "$remote_addr|$http_tailscale_user_login" $matrix_forged_identity {`);
    expect(site).toContain("if ($matrix_forged_identity) { return 403; }");
    const publicSite = run(`render_nginx_site public _ /etc/nginx/matrix-self-host.htpasswd off`).stdout;
    expect(publicSite).not.toContain("matrix_forged_identity");
    expect(publicSite).not.toContain("listen unix:");
    const source = readFileSync(script, "utf8");
    expect(source).not.toMatch(/tailscale serve[^\n]*127\.0\.0\.1:80/);
    const socketDir = source.split("\nprepare_tailnet_socket_dir() {")[1]!.split("\n}\n")[0]!;
    expect(socketDir).toContain("install -d -o root -g root -m 0700 /run/matrix-nginx");
    expect(socketDir).toContain("d /run/matrix-nginx 0700 root root -");
    const nginx = source.split("\nconfigure_nginx() {")[1]!.split("\n}\n")[0]!;
    expect(nginx).toContain("prepare_tailnet_socket_dir");
    // The installer's own checks present the identity only through that socket,
    // and prove the loopback listener refuses one.
    const identityCheck = source.split("\nwait_private_identity_ok() {")[1]!.split("\n}\n")[0]!;
    expect(identityCheck).toContain('--unix-socket "$TAILNET_SOCKET"');
    const verify = source.split("\nverify_private_access() {")[1]!.split("\n}\n")[0]!;
    expect(verify).toContain("only Tailscale Serve may present one");
  });

  it("keeps Basic Auth on the public interface only for --access public", () => {
    const site = run(`render_nginx_site public _ /etc/nginx/matrix-self-host.htpasswd off`).stdout;
    expect(site).toContain("listen 80 default_server;");
    expect(site).toContain("auth_basic \"Matrix OS\"");
    expect(site).not.toContain("auth_request");
    expect(site).not.toContain("browser-lab/viewer/websockify");
  });

  it("grants the run user only the two browser lifecycle commands", () => {
    const sudoers = run(`render_browser_sudoers alice`).stdout;
    expect(sudoers).toContain("alice ALL=(root) NOPASSWD: /usr/bin/python3 -I /usr/local/libexec/matrix-browser-runtime.py --status");
    expect(sudoers).toContain("alice ALL=(root) NOPASSWD: /usr/bin/python3 -I /usr/local/libexec/matrix-browser-runtime.py --retry");
    expect(sudoers).not.toContain("ALL=(ALL)");
    expect(sudoers).not.toContain("NOPASSWD:ALL");
  });

  it("accepts only a root-owned private auth key file and never prints the key", () => {
    const key = join(dir, "authkey");
    writeFileSync(key, "tskey-auth-secret-value\n");
    chmodSync(key, 0o644);
    const loose = run(`check_authkey_file "${key}"`);
    expect(loose.status).not.toBe(0);
    expect(loose.stderr).toContain("must not be readable by group or others");
    expect(`${loose.stdout}${loose.stderr}`).not.toContain("tskey-auth-secret-value");
    chmodSync(key, 0o600);
    // Owned by someone other than the installing (root) user.
    const wrongOwner = run(`stat() { printf '12345 600\\n'; }\ncheck_authkey_file "${key}"`);
    expect(wrongOwner.status).not.toBe(0);
    expect(wrongOwner.stderr).toContain("must be owned by root");
    const good = run(`check_authkey_file "${key}"`);
    expect(good.status, good.stderr).toBe(0);
    expect(`${good.stdout}${good.stderr}`).not.toContain("tskey-auth-secret-value");
  });

  it("passes the auth key to tailscale by file reference and deletes it afterwards", () => {
    const key = join(dir, "authkey");
    writeFileSync(key, "tskey-auth-secret-value\n", { mode: 0o600 });
    const log = join(dir, "argv.log");
    const result = run(
      `timeout() { shift; "$@"; }
tailscale() { printf '%s\\n' "$*" >>"${log}"; }
OPT_ACCESS=tailscale OPT_LOGIN_SERVER="" MATRIX_INSTALL_LOG="${join(dir, "install.log")}" tailscale_login_with_authkey "${key}"`,
    );
    expect(result.status, result.stderr).toBe(0);
    const argv = readFileSync(log, "utf8");
    expect(argv).toContain(`up --auth-key=file:${key}`);
    expect(argv).not.toContain("tskey-auth-secret-value");
    expect(existsSync(key)).toBe(false);
  });

  describe("a machine already on a private network", () => {
    // Found in review: tailscale_login reused any running connection, so a host
    // already on Tailscale (or another Headscale) kept that network while the
    // installer recorded the requested one, and those devices could not reach Matrix.
    function running(controlURL: string | null, opts: string) {
      const bin = join(dir, "bin");
      spawnSync("mkdir", ["-p", bin]);
      const prefs = controlURL === null ? "exit 1" : `printf '%s' '${JSON.stringify({ ControlURL: controlURL, WantRunning: true })}'`;
      writeFileSync(join(bin, "tailscale"), `#!/bin/sh
case "$1 $2" in
  "status --json") printf '%s' '{"BackendState":"Running","Self":{"DNSName":"box.example.","UserID":1},"User":{"1":{"LoginName":"me@example.com"}}}' ;;
  "debug prefs") ${prefs} ;;
  up*|"up "*) echo "$*" >> "${join(dir, "up")}" ;;
  *) echo "$*" >> "${join(dir, "other")}" ;;
esac
`);
      chmodSync(join(bin, "tailscale"), 0o755);
      return run(`MATRIX_INSTALL_LOG=/dev/null MATRIX_INSTALL_NODE_BIN="$(command -v node)" ${opts} tailscale_login`, {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      });
    }

    it("reuses a Tailscale connection when Tailscale is requested", () => {
      const result = running("https://controlplane.tailscale.com", "OPT_ACCESS=tailscale OPT_LOGIN_SERVER=");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("already on your private network");
      expect(existsSync(join(dir, "up"))).toBe(false);
    });

    it("reuses the same Headscale server, ignoring a trailing slash and host case", () => {
      const result = running("https://HS.example.com/", "OPT_ACCESS=headscale OPT_LOGIN_SERVER=https://hs.example.com");
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(dir, "up"))).toBe(false);
    });

    it("refuses to keep Tailscale when Headscale is requested, and says how to switch", () => {
      const result = running("https://controlplane.tailscale.com", "OPT_ACCESS=headscale OPT_LOGIN_SERVER=https://hs.example.com");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("already on Tailscale");
      expect(result.stderr).toContain("sudo tailscale logout");
      expect(result.stderr).toContain("without --login-server");
      expect(existsSync(join(dir, "up"))).toBe(false);
      expect(existsSync(join(dir, "other"))).toBe(false);
    });

    it("refuses a different Headscale server", () => {
      const result = running("https://old.example.com", "OPT_ACCESS=headscale OPT_LOGIN_SERVER=https://hs.example.com");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("https://old.example.com");
      expect(result.stderr).toContain("--login-server https://old.example.com");
      expect(result.stderr).toContain("sudo tailscale logout");
    });

    it("refuses to keep a Headscale network when Tailscale is requested", () => {
      const result = running("https://old.example.com", "OPT_ACCESS=tailscale OPT_LOGIN_SERVER=");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--access headscale --login-server https://old.example.com");
      expect(existsSync(join(dir, "up"))).toBe(false);
    });

    it("fails closed when it cannot tell which network the machine is on", () => {
      const result = running(null, "OPT_ACCESS=tailscale OPT_LOGIN_SERVER=");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("could not tell which private network");
    });
  });

  it("prints the Tailscale login link while the login is still waiting, without a terminal", () => {
    // Found while testing on a live VPS: grep buffered the link until tailscale
    // gave up, so an unattended install showed it only after it had expired.
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    const marker = join(dir, "link-seen-while-waiting");
    writeFileSync(join(bin, "tailscale"), `#!/bin/sh
case "$1" in
  up) echo "To authenticate, visit:"; echo "  https://login.tailscale.com/a/abc123"; sleep 4; [ -f "${marker}" ] && echo done >> "${marker}"; exit 1 ;;
  status) exit 1 ;;
esac
`);
    chmodSync(join(bin, "tailscale"), 0o755);
    const watcher = `( for i in 1 2 3 4 5 6; do grep -q 'Login: https://login.tailscale.com/a/abc123' "${join(dir, "out")}" 2>/dev/null && { : > "${marker}"; break; }; sleep 0.5; done ) &`;
    const result = run(`${watcher}\nOPT_ACCESS=tailscale MATRIX_TAILSCALE_LOGIN_WAIT=3 tailscale_login > "${join(dir, "out")}" 2>&1; wait`, { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, "out"), "utf8")).toContain("Login: https://login.tailscale.com/a/abc123");
    expect(readFileSync(marker, "utf8")).toContain("done");
  });

  it("finds herdr-core through the run user's own login shell, not always Bash", () => {
    // Found in review: an owner on Zsh adds herdr-core to PATH in ~/.zprofile,
    // which a Bash login shell never reads, so Herdr sessions were turned off.
    const herdr = join(dir, "herdr-core");
    writeFileSync(herdr, "#!/bin/sh\nexit 0\n");
    chmodSync(herdr, 0o755);
    const shell = join(dir, "zsh");
    writeFileSync(shell, `#!/bin/sh\necho "$*" >> "${join(dir, "shell-calls")}"\n[ "$1" = -lc ] && echo "${herdr}"\n`);
    chmodSync(shell, 0o755);
    // runuser runs under timeout, so it is a program on PATH, not a function.
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "runuser"), "#!/bin/sh\nshift 3\nexec \"$@\"\n");
    chmodSync(join(bin, "runuser"), 0o755);
    const result = run(`getent() { printf 'alice:x:1000:1000::/home/alice:%s\\n' "${shell}"; }
MATRIX_RUN_USER=alice OPT_HERDR=on
detect_herdr >/dev/null 2>&1
printf '%s|%s\\n' "$MATRIX_HERDR_CORE_BIN" "$OPT_HERDR"`, { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`${herdr}|on`);
    expect(readFileSync(join(dir, "shell-calls"), "utf8")).toContain("-lc command -v herdr-core");
  });

  it("uses Bash when the run user's login shell is missing or a no-login shell", () => {
    for (const shell of ["/usr/sbin/nologin", "/bin/false", "relative/zsh", join(dir, "missing-shell")]) {
      const result = run(`getent() { printf 'alice:x:1000:1000::/home/alice:%s\\n' "${shell}"; }
MATRIX_RUN_USER=alice; run_user_login_shell`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim(), shell).toBe("bash");
    }
  });

  it("tells the owner to rerun the installer after a late private-network login", () => {
    // Found in review: "finish later with tailscale up" left serving, the
    // tailnet URL and the browser origin unset, so browser sockets were refused.
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "tailscale"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "tailscale"), 0o755);
    const result = run(`tailscale_wait_running() { return 1; }
MATRIX_INSTALL_LOG=/dev/null OPT_ACCESS=tailscale MATRIX_TAILSCALE_LOGIN_WAIT=1 tailscale_login`, { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
    expect(result.status, result.stderr).toBe(0);
    const said = result.stdout + result.stderr;
    expect(said).toMatch(/sudo tailscale up/);
    expect(said).toMatch(/then rerun this installer/);
    expect(said).not.toMatch(/Finish later with/);
  });

  it("falls back to tailnet-only HTTP when the tailnet has no HTTPS certificates", () => {
    // Found on a live VPS: with certificates off, serve failed and the printed
    // https link never opened. Tailnet traffic is already encrypted end to end.
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "tailscale"), `#!/bin/sh
echo "$*" >> "${join(dir, "calls")}"
case "$*" in *--https=443*) exit 1 ;; esac
exit 0
`);
    chmodSync(join(bin, "tailscale"), 0o755);
    const result = run(`MATRIX_INSTALL_LOG=/dev/null; OPT_ACCESS=tailscale; MATRIX_TAILNET_URL=https://box.tail1.ts.net; configure_tailscale_serve; echo "url=$MATRIX_TAILNET_URL"`, { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, "calls"), "utf8")).toContain("serve --bg --yes --http=80 unix:/run/matrix-nginx/tailnet.sock");
    expect(result.stdout).toContain("url=http://box.tail1.ts.net");
    expect(result.stdout + result.stderr).toMatch(/HTTPS/);
  });

  it("serves on the tailnet before recording its address, so the gateway learns an HTTP fallback", () => {
    const main = readFileSync(script, "utf8").split("\nmain() {")[1]!;
    const join = main.indexOf("configure_private_network");
    const serve = main.indexOf("configure_tailscale_serve");
    const record = main.indexOf("write_env", join);
    expect(join).toBeGreaterThan(-1);
    expect(serve).toBeGreaterThan(join);
    expect(serve).toBeLessThan(record);
  });

  it("allows the private-network address as the gateway's browser origin", () => {
    // Without SHELL_ORIGIN the self-host gateway trusts only app.matrix-os.com,
    // so browser setup and the viewer failed from the printed tailnet link.
    const origin = (args: string) => run(`self_host_shell_origin ${args}`);
    expect(origin("tailscale https://box.tail1.ts.net ''").stdout.trim()).toBe("https://box.tail1.ts.net");
    expect(origin("headscale http://box.hs.example ''").stdout.trim()).toBe("http://box.hs.example");
    // A malformed recorded address is never trusted; an operator value survives.
    expect(origin("tailscale 'https://box/evil' ''").stdout.trim()).toBe("");
    expect(origin("tailscale 'https://box.ts.net\nX=1' ''").stdout.trim()).toBe("");
    expect(origin("public '' https://matrix.example.com").stdout.trim()).toBe("https://matrix.example.com");
    expect(origin("public '' 'https://evil.example/\nX=1'").stdout.trim()).toBe("");
    const writeEnv = readFileSync(script, "utf8").split("\nwrite_env() {")[1]!.split("\n}\n")[0]!;
    expect(writeEnv).toContain('self_host_shell_origin "$OPT_ACCESS" "$MATRIX_TAILNET_URL"');
    expect(writeEnv).toContain(`printf 'SHELL_ORIGIN=%s\\n' "$shell_origin" >>/opt/matrix/env/host.env`);
    expect(writeEnv).toContain('browser_lab="$(browser_lab_value "$OPT_BROWSER" "$browser_lab")"');
  });

  it("writes the browser opt-out so the gateway and lifecycle stop offering it", () => {
    const flag = (args: string) => run(`browser_lab_value ${args}`).stdout.trim();
    expect(flag("off true")).toBe("false");
    expect(flag("off ''")).toBe("false");
    // Opting back in clears the opt-out; the lifecycle writes true once Chrome is healthy.
    expect(flag("on false")).toBe("");
    expect(flag("on true")).toBe("true");
  });

  it("stops browser use on --no-browser without deleting the saved Chrome profile", () => {
    const units = join(dir, "units");
    spawnSync("mkdir", ["-p", units]);
    writeFileSync(join(units, "matrix-browser-runtime.service"), "[Service]\n");
    writeFileSync(join(units, "matrix-browser-lab.service"), "[Service]\n");
    writeFileSync(join(units, "matrix-browser-lab-chrome.service"), "[Service]\n");
    const result = run(
      `systemctl() { printf '%s\\n' "$*" >>"${join(dir, "calls")}"; }
timeout() { shift; "$@"; }
rm() { printf 'rm %s\\n' "$*" >>"${join(dir, "calls")}"; }
MATRIX_INSTALL_LOG=/dev/null MATRIX_SYSTEMD_UNIT_DIR="${units}" OPT_BROWSER=off configure_browser`,
    );
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    // The lifecycle goes first so it cannot restart Chrome behind the opt-out.
    expect(calls).toEqual([
      "rm -f /etc/sudoers.d/matrix-browser-runtime",
      "disable --now matrix-browser-runtime.service",
      "disable --now matrix-browser-lab-chrome.service",
      "disable --now matrix-browser-lab.service",
    ]);
  });

  describe("browser account", () => {
    // Review P1: the browser ran as matrix (host.env via the matrix group, root via
    // docker). It now runs as matrix-browser: neither group, own user manager, private home.
    function prepare(options: { exists?: boolean; groups?: string; primary?: string; existingHome?: boolean } = {}) {
      const root = join(dir, "root");
      spawnSync("mkdir", ["-p", root]);
      if (options.existingHome) spawnSync("mkdir", ["-p", join(root, "var/lib/matrix-browser")]);
      const calls = join(dir, "calls");
      const result = run(
        `install() { printf 'install %s\\n' "$*" >>"${calls}"; }
useradd() { printf 'useradd %s\\n' "$*" >>"${calls}"; }
gpasswd() { printf 'gpasswd %s\\n' "$*" >>"${calls}"; }
usermod() { printf 'usermod %s\\n' "$*" >>"${calls}"; }
loginctl() { printf 'loginctl %s\\n' "$*" >>"${calls}"; }
systemctl() { printf 'systemctl %s\\n' "$*" >>"${calls}"; }
id() {
  case "$*" in
    "matrix-browser") ${options.exists ? "return 0" : "return 1"} ;;
    "-u matrix-browser") echo 997 ;;
    "-nG matrix-browser") echo "${options.groups ?? "matrix-browser"}" ;;
    "-gn matrix-browser") echo "${options.primary ?? "matrix-browser"}" ;;
    *) command id "$@" ;;
  esac
}
MATRIX_INSTALL_LOG=/dev/null MATRIX_RUN_USER=alice MATRIX_BROWSER_ACCOUNT_HOME="${root}/var/lib/matrix-browser" prepare_browser_account`,
      );
      const lines = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
      return { result, root, calls: lines };
    }

    it("creates a dedicated account with no matrix or docker group, a private home and its own session", () => {
      const { result, root, calls } = prepare();
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual([
        `useradd --system --user-group --home-dir ${root}/var/lib/matrix-browser --shell /usr/sbin/nologin matrix-browser`,
        `install -d -o matrix-browser -g matrix-browser -m 0700 ${root}/var/lib/matrix-browser`,
        "loginctl enable-linger matrix-browser",
        "systemctl start user@997.service",
      ]);
      // No supplementary groups at all: never matrix, never docker.
      expect(calls.join("\n")).not.toMatch(/--groups|-G\b|-aG|usermod/);
      expect(calls.join("\n")).not.toMatch(/alice/);
    });

    it("takes an existing browser account out of the matrix and docker groups", () => {
      const { result, calls } = prepare({ exists: true, groups: "matrix-browser matrix docker" });
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain("gpasswd -d matrix-browser matrix");
      expect(calls).toContain("gpasswd -d matrix-browser docker");
      expect(calls.filter((call) => call.startsWith("useradd"))).toEqual([]);
    });

    it("refuses a browser account whose primary group is matrix or docker", () => {
      for (const primary of ["matrix", "docker"]) {
        const { result, calls } = prepare({ exists: true, primary });
        expect(result.status, primary).not.toBe(0);
        expect(result.stdout + result.stderr).toMatch(/browser account/i);
        expect(calls.filter((call) => call.startsWith("loginctl"))).toEqual([]);
      }
    });

    it("tells the browser runtime which account to use, and keeps host.env readable only by root and the matrix group", () => {
      const writeEnv = readFileSync(script, "utf8").split("\nwrite_env() {")[1]!.split("\n}\n")[0]!;
      expect(writeEnv).toContain("MATRIX_BROWSER_ACCOUNT=${MATRIX_BROWSER_ACCOUNT}");
      expect(writeEnv).toContain("chmod 0640 /opt/matrix/env/host.env");
      expect(writeEnv).toContain("chown root:matrix /opt/matrix/env/host.env");
      expect(writeEnv).toContain("chmod 0640 /opt/matrix/env/postgres.env");
      expect(writeEnv).toContain("chown root:matrix /opt/matrix/env/postgres.env");
    });

    // Found in review: an install whose browser ran as matrix lost its saved
    // logins and tabs when the browser moved to the dedicated account. The move
    // must never let root write through browser-owned (swappable) directories.
    function migrate(options: { newExists?: boolean; outside?: boolean; noLegacy?: boolean } = {}) {
      const legacyRoot = join(dir, "legacy");
      const home = join(dir, "browser-home");
      const stage = join(dir, "stage");
      const old = join(legacyRoot, ".local/share/matrix-browser-lab/chrome");
      spawnSync("mkdir", ["-p", home]);
      if (!options.noLegacy) {
        spawnSync("mkdir", ["-p", join(old, "Default")]);
        writeFileSync(join(old, "Default/Cookies"), "saved session");
      }
      if (options.outside) {
        spawnSync("rm", ["-rf", old]);
        spawnSync("mkdir", ["-p", join(dir, "elsewhere")]);
        spawnSync("ln", ["-s", join(dir, "elsewhere"), old]);
      }
      if (options.newExists) spawnSync("mkdir", ["-p", join(home, ".local/share/matrix-browser-lab/chrome")]);
      const calls = join(dir, "migrate-calls");
      const result = run(`systemctl() { printf 'systemctl %s\\n' "$*" >>"${calls}"; }
chown() { printf 'chown %s\\n' "$*" >>"${calls}"; }
install() { printf 'install %s\\n' "$*" >>"${calls}"; command install -d "\${@: -1}"; }
runuser() { printf 'runuser %s\\n' "$*" >>"${calls}"; shift 3; "$@"; }
id() { case "$*" in "-gn matrix-browser") echo matrix-browser ;; *) command id "$@" ;; esac; }
MATRIX_INSTALL_LOG=/dev/null MATRIX_LEGACY_BROWSER_ROOT="${legacyRoot}" MATRIX_LEGACY_BROWSER_USER="$(command id -un)" MATRIX_BROWSER_PROFILE_STAGE="${stage}" migrate_browser_profile matrix-browser "${home}"`);
      const lines = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
      return { result, old, home, stage, moved: join(home, ".local/share/matrix-browser-lab/chrome"), calls: lines };
    }

    it("moves an existing saved browser profile into the browser account's home", () => {
      const { result, old, home, stage, moved, calls } = migrate();
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(moved, "Default/Cookies"), "utf8")).toBe("saved session");
      expect(existsSync(old)).toBe(false);
      expect(existsSync(stage)).toBe(false);
      expect(calls).toContain("systemctl stop matrix-browser-lab-chrome.service");
      // Ownership changes only in the root-owned staging area, never in the account's home.
      expect(calls).toContain(`chown -R --no-dereference matrix-browser:matrix-browser ${stage}/matrix-browser/chrome`);
      // Inside the account's home, only the account itself creates and moves.
      expect(calls).toContain(`runuser -u matrix-browser -- mkdir -p ${home}/.local/share/matrix-browser-lab`);
      expect(calls).toContain(`runuser -u matrix-browser -- mv -T ${stage}/matrix-browser/chrome ${moved}`);
      expect(calls.filter((call) => call.startsWith("install") && call.includes(home))).toEqual([]);
    });

    it("leaves profiles alone when the account already has one or the old one points elsewhere", () => {
      for (const options of [{ newExists: true }, { outside: true }]) {
        const { result, moved, calls } = migrate(options);
        expect(result.status, result.stderr).toBe(0);
        expect(calls.filter((call) => call.startsWith("chown"))).toEqual([]);
        expect(existsSync(join(moved, "Default/Cookies"))).toBe(false);
        spawnSync("rm", ["-rf", join(dir, "legacy"), join(dir, "browser-home"), join(dir, "elsewhere"), join(dir, "stage"), join(dir, "migrate-calls")]);
      }
    });

    it("resumes a move that stopped after staging, and never deletes it", () => {
      // Found in review: a rerun after an interrupted move saw no old profile and
      // started an empty one, stranding the saved sessions in staging.
      const stage = join(dir, "stage");
      spawnSync("mkdir", ["-p", join(stage, "matrix-browser/chrome/Default"), join(dir, "browser-home")]);
      writeFileSync(join(stage, "matrix-browser/chrome/Default/Cookies"), "staged session");
      const { result, moved, calls } = migrate({ noLegacy: true });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(moved, "Default/Cookies"), "utf8")).toBe("staged session");
      expect(calls).toContain(`runuser -u matrix-browser -- mv -T ${stage}/matrix-browser/chrome ${moved}`);
      expect(existsSync(stage)).toBe(false);
    });

    it("prepares the account before installing the browser desktop", () => {
      const body = readFileSync(script, "utf8").split("\nconfigure_browser() {")[1]!.split("\n}\n")[0]!;
      expect(body.indexOf("prepare_browser_account")).toBeGreaterThan(-1);
      expect(body.indexOf("prepare_browser_account")).toBeLessThan(body.indexOf("/opt/matrix/bin/matrix-install-browser"));
    });
  });

  it("leaves systemd alone on --no-browser when browser use was never installed", () => {
    const result = run(
      `systemctl() { printf '%s\\n' "$*" >>"${join(dir, "calls")}"; }
timeout() { shift; "$@"; }
rm() { :; }
MATRIX_INSTALL_LOG=/dev/null MATRIX_SYSTEMD_UNIT_DIR="${join(dir, "none")}" OPT_BROWSER=off configure_browser`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(dir, "calls"))).toBe(false);
  });

  it("extracts the bundle as the installing account with non-writable modes whatever the caller's umask", () => {
    const src = join(dir, "src");
    spawnSync("mkdir", ["-p", join(src, "bin")]);
    writeFileSync(join(src, "release.json"), '{"version":"v1"}\n', { mode: 0o664 });
    writeFileSync(join(src, "bin/matrix-install-browser"), "x\n", { mode: 0o775 });
    const bundle = join(dir, "b.tgz");
    spawnSync("tar", ["-czf", bundle, "-C", src, "."]);
    const dest = join(dir, "opt");
    spawnSync("mkdir", ["-p", dest]);
    const result = run(`umask 002\nextract_bundle "${bundle}" "${dest}"\nstat -c '%a %n' "${dest}/release.json" "${dest}/bin"`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`644 ${dest}/release.json`);
    expect(result.stdout).toContain(`755 ${dest}/bin`);
  });

  it("records only the chosen options in telemetry", () => {
    const result = run(
      `curl() { for arg; do case "$arg" in {*) printf '%s\\n' "$arg" >"${join(dir, "payload.json")}";; esac; done; }
OPT_ACCESS=tailscale OPT_BROWSER=on OPT_HERDR=off MATRIX_INSTALL_TELEMETRY_URL=https://example.invalid/t
OPT_RUN_USER=alice MATRIX_TAILSCALE_OWNER_LOGIN=alice@example.com
capture_install_telemetry matrix_manual_install_started started 0`,
      { MATRIX_NO_TELEMETRY: "" },
    );
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(readFileSync(join(dir, "payload.json"), "utf8")) as Record<string, unknown>;
    expect(payload.accessMode).toBe("tailscale");
    expect(payload.browser).toBe("on");
    expect(payload.herdr).toBe("off");
    expect(JSON.stringify(payload)).not.toMatch(/login|authkey|tskey|alice/i);
  });

  // Review P1 (#3531 at 632a3f6f), fixed in this layer for size: four installer findings.
  describe("browser account network isolation", () => {
    // matrix-browser shared loopback with code-server (owner, --auth none) and the
    // shell proxy (adds the gateway bearer); it must reach neither, nor the
    // machine's own tailnet name, while Chrome keeps the internet and its own ports.
    it("renders an owner-matched nftables table that refuses loopback and tailnet except the browser's own ports and DNS", () => {
      const rules = run(`render_browser_isolation matrix-browser`).stdout;
      expect(rules).toContain("table inet matrix_browser_isolation {");
      expect(rules).toContain('meta skuid != "matrix-browser" accept');
      expect(rules).toContain("ct state established,related accept");
      expect(rules).toContain("ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 accept");
      expect(rules).toContain("ip daddr 127.0.0.1 tcp dport { 6901, 8730, 9222 } accept");
      expect(rules).toContain("ip daddr 127.0.0.0/8 reject");
      expect(rules).toContain("ip6 daddr ::1 reject");
      expect(rules).toContain("ip daddr 100.64.0.0/10 reject");
      expect(rules).toContain("ip6 daddr fd7a:115c:a1e0::/48 reject");
      expect(rules.indexOf("established")).toBeLessThan(rules.indexOf("127.0.0.0/8 reject"));
    });

    // Review P1 (Greptile, #3532 at 6a02cadb14): a host that resolves through
    // Tailscale's MagicDNS resolver sends DNS to 100.100.100.100, inside the
    // rejected tailnet range, so Chrome could not resolve any website.
    it("lets the browser account reach the tailnet DNS resolver on port 53 only, before the tailnet is refused", () => {
      const rules = run(`render_browser_isolation matrix-browser`).stdout;
      const v4 = "ip daddr 100.100.100.100 meta l4proto { tcp, udp } th dport 53 accept";
      const v6 = "ip6 daddr fd7a:115c:a1e0::53 meta l4proto { tcp, udp } th dport 53 accept";
      expect(rules).toContain(v4);
      expect(rules).toContain(v6);
      expect(rules.indexOf(v4)).toBeLessThan(rules.indexOf("ip daddr 100.64.0.0/10 reject"));
      expect(rules.indexOf(v6)).toBeLessThan(rules.indexOf("ip6 daddr fd7a:115c:a1e0::/48 reject"));
      expect(rules).not.toMatch(/100\.100\.100\.100(?! meta l4proto \{ tcp, udp \} th dport 53 accept)/);
    });

    it("installs the table durably and refuses to start browser use when it cannot apply it", () => {
      const unit = run(`render_browser_isolation_unit`).stdout;
      expect(unit).toContain("ExecStart=/usr/sbin/nft -f /etc/matrix/browser-isolation.nft");
      expect(unit).toContain("Before=matrix-browser-runtime.service matrix-browser-lab-vnc.service");
      expect(unit).toContain("WantedBy=multi-user.target");
      const body = readFileSync(script, "utf8").split("\nconfigure_browser() {")[1]!.split("\n}\n")[0]!;
      expect(body.indexOf("install_browser_isolation")).toBeGreaterThan(-1);
      expect(body.indexOf("install_browser_isolation")).toBeLessThan(body.indexOf("systemctl enable matrix-browser-runtime"));
      expect(body).toMatch(/install_browser_isolation \|\| \{[^}]*browser use stays off/);
      expect(readFileSync(script, "utf8")).toMatch(/apt-get install -y [^\n]*nftables/);
    });

    // Review P1 (Greptile, #3532 at b854833b31): user@<uid> is BindsTo= the table, so
    // restarting the table on a rerun stopped the browser account's user manager and
    // nothing started it again; the desktop's Files/Terminal buttons need its bus.
    it("starts the browser account's user manager again after the table restarts, and checks it", () => {
      const units = join(dir, "units");
      spawnSync("mkdir", ["-p", units]);
      const calls = join(dir, "isolation-calls");
      const body = (active: number) => `install() { case "\${@: -1}" in /etc/*) ;; *) mkdir -p "\${@: -1}" ;; esac; }
id() { echo 1234; }
render_browser_isolation() { :; }
systemctl() { echo "systemctl $*" >>"${calls}"; [ "$1" != is-active ] || return ${active}; }
nft() { :; }
MATRIX_INSTALL_LOG=/dev/null MATRIX_BROWSER_ACCOUNT=matrix-browser MATRIX_SYSTEMD_UNIT_DIR="${units}" MATRIX_BROWSER_ISOLATION_FILE="${dir}/browser-isolation.nft" install_browser_isolation`;
      const ok = run(body(0));
      expect(ok.status, ok.stderr).toBe(0);
      const log = readFileSync(calls, "utf8");
      const restart = log.indexOf("systemctl restart matrix-browser-isolation.service");
      expect(restart).toBeGreaterThan(-1);
      expect(log.indexOf("systemctl start user@1234.service")).toBeGreaterThan(restart);
      expect(log.indexOf("systemctl is-active --quiet user@1234.service")).toBeGreaterThan(log.indexOf("systemctl start user@1234.service"));
      rmSync(calls);
      expect(run(body(3)).status).not.toBe(0);
    });

    // Review P1 (#3532 at 0b159db3): ordering alone let a browser unit start without the table.
    it("binds every browser unit and the account's user manager to the table, so a failed load starts none", () => {
      const units = join(dir, "units");
      spawnSync("mkdir", ["-p", units]);
      const result = run(`install() { case "\${@: -1}" in /etc/*) ;; *) mkdir -p "\${@: -1}" ;; esac; }
id() { echo 1234; }
render_browser_isolation() { :; }
systemctl() { :; }
nft() { return 1; }
MATRIX_INSTALL_LOG=/dev/null MATRIX_BROWSER_ACCOUNT=matrix-browser MATRIX_SYSTEMD_UNIT_DIR="${units}" install_browser_isolation`);
      expect(result.status).not.toBe(0);
      const bound = ["matrix-browser-runtime.service", "matrix-browser-lab-vnc.service", "matrix-browser-lab-wm.service", "matrix-browser-lab-desktop.service", "matrix-browser-lab-panel.service", "matrix-browser-lab-chrome.service", "matrix-browser-lab.service", "user@1234.service"];
      for (const unit of bound) {
        const dropin = readFileSync(join(units, `${unit}.d/matrix-isolation.conf`), "utf8");
        expect(dropin).toContain("BindsTo=matrix-browser-isolation.service");
        expect(dropin).toContain("After=matrix-browser-isolation.service");
      }
      // The units are bound first, so any later failure leaves them unstartable.
      const body = readFileSync(script, "utf8").split("\nconfigure_browser() {")[1]!.split("\n}\n")[0]!;
      expect(body).toMatch(/install_browser_isolation \|\| \{[^}]*stop_browser_use; return 0; \}/);
    });
  });

  describe("unattended reruns keep a working access mode", () => {
    function saved(mode: string, extra = "") {
      const env = join(dir, "host.env");
      writeFileSync(env, `MATRIX_ACCESS_MODE=${mode}\n${extra}`);
      return env;
    }

    it("keeps the saved access mode when no access flag is given, and an explicit flag still wins", () => {
      const env = saved("public");
      const kept = run(`parse_args\nMATRIX_HOST_ENV_FILE="${env}" restore_saved_access_mode >/dev/null\nprintf '%s\\n' "$OPT_ACCESS"`);
      expect(kept.stdout.trim()).toBe("public");
      const explicit = run(`parse_args --access tailscale\nMATRIX_HOST_ENV_FILE="${env}" restore_saved_access_mode\nprintf '%s\\n' "$OPT_ACCESS"`);
      expect(explicit.stdout.trim()).toBe("tailscale");
      const headscale = saved("headscale", "MATRIX_TAILSCALE_LOGIN_SERVER=https://hs.example.com\n");
      const hs = run(`parse_args\nMATRIX_HOST_ENV_FILE="${headscale}" restore_saved_access_mode >/dev/null\nprintf '%s|%s\\n' "$OPT_ACCESS" "$OPT_LOGIN_SERVER"`);
      expect(hs.stdout.trim()).toBe("headscale|https://hs.example.com");
      const body = readFileSync(script, "utf8").split("\nask_install_choices() {")[1]!.split("\n}\n")[0]!;
      expect(body.indexOf("restore_saved_access_mode")).toBeLessThan(body.indexOf("ask_access_mode"));
    });

    // Review P1 (Nima, #3531 review 6045446199): the old public-only installer
    // never wrote MATRIX_ACCESS_MODE, so a flagless upgrade picked Tailscale and
    // skipped the existing-public guard.
    describe("a legacy public install with no recorded access mode", () => {
      function legacy(site: string | null, env = "MATRIX_SELF_HOSTED=1\nMATRIX_HANDLE=box\n") {
        const hostEnv = join(dir, "legacy-host.env");
        writeFileSync(hostEnv, env);
        const siteFile = join(dir, "matrix-self-host");
        if (site !== null) writeFileSync(siteFile, site);
        return (flags: string) => run(`parse_args ${flags}
MATRIX_HOST_ENV_FILE="${hostEnv}" MATRIX_NGINX_SITE_FILE="${siteFile}" restore_saved_access_mode >/dev/null
printf '%s|%s\n' "$OPT_ACCESS" "$PREVIOUS_ACCESS_MODE"`);
      }
      const publicSite = 'server {\n  listen 80 default_server;\n  server_name _;\n  auth_basic "Matrix OS";\n}\n';

      it("stays public on a flagless upgrade", () => {
        const result = legacy(publicSite)("");
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("public|public");
      });

      it("still honors an explicit --access, guarded as a switch away from public", () => {
        const result = legacy(publicSite)("--access tailscale");
        expect(result.stdout.trim()).toBe("tailscale|public");
      });

      it("does not invent a public install from a private site or a fresh machine", () => {
        const privateSite = "server {\n  listen 127.0.0.1:80 default_server;\n  listen unix:/run/matrix-nginx/tailnet.sock;\n}\n";
        expect(legacy(privateSite)("").stdout.trim()).toBe("tailscale|");
        expect(legacy(null)("").stdout.trim()).toBe("tailscale|");
        expect(legacy(publicSite, "MATRIX_HANDLE=box\n")("").stdout.trim()).toBe("tailscale|");
      });
    });

    it("keeps the public listener and fails loudly when private access is not ready", () => {
      const calls = join(dir, "switch-calls");
      const result = run(`tailscale_status_line() { printf 'NeedsLogin\\t\\t\\n'; }
write_env() { printf 'write_env %s\\n' "$OPT_ACCESS" >>"${calls}"; }
systemctl() { :; }
verify_public_websocket() { :; }
PREVIOUS_ACCESS_MODE=public OPT_ACCESS=tailscale MATRIX_TAILSCALE_OWNER_LOGIN= MATRIX_TAILNET_URL= require_private_access_ready`);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/keeping your public/i);
      expect(readFileSync(calls, "utf8")).toContain("write_env public");
      const ready = run(`tailscale_status_line() { printf 'Running\\tbox.ts.net\\talice@example.com\\n'; }
PREVIOUS_ACCESS_MODE=public OPT_ACCESS=tailscale MATRIX_TAILSCALE_OWNER_LOGIN=alice@example.com MATRIX_TAILNET_URL=https://box.ts.net TAILNET_SERVE_PORT=443 require_private_access_ready`);
      expect(ready.status, ready.stderr).toBe(0);
      const main = readFileSync(script, "utf8").split("\nmain() {")[1]!;
      expect(main.indexOf("require_private_access_ready")).toBeGreaterThan(main.indexOf("configure_tailscale_serve"));
      expect(main.indexOf("require_private_access_ready")).toBeLessThan(main.indexOf("configure_nginx"));
    });

    // Review P1 (Nima, #3531 review 6045446199): with Tailscale signed in but both
    // Serve commands failing, the installer still replaced the public site and
    // reported success, because the later checks only hit the local socket.
    function serveFixture(serveExit: number, status: string) {
      const bin = join(dir, "serve-bin");
      spawnSync("mkdir", ["-p", bin]);
      writeFileSync(join(bin, "tailscale"), `#!/bin/sh
case "$1 $2" in
  "serve --bg") exit ${serveExit} ;;
  "serve status") printf '%s' '${status}' ;;
esac
exit 0
`);
      chmodSync(join(bin, "tailscale"), 0o755);
      const calls = join(dir, "serve-calls");
      const result = run(`tailscale_status_line() { printf 'Running\tbox.ts.net\talice@example.com\n'; }
write_env() { printf 'write_env %s\n' "$OPT_ACCESS" >>"${calls}"; }
nginx() { echo "nginx $*" >>"${calls}"; }
systemctl() { echo "systemctl $*" >>"${calls}"; }
verify_public_websocket() { :; }
MATRIX_INSTALL_LOG=/dev/null PREVIOUS_ACCESS_MODE=public OPT_ACCESS=tailscale MATRIX_TAILSCALE_OWNER_LOGIN=alice@example.com MATRIX_TAILNET_URL=https://box.ts.net
configure_tailscale_serve
require_private_access_ready
echo switched-to-private`, { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
      return { result, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
    }
    const published = (port: number) => JSON.stringify({ Web: { [`box.ts.net:${port}`]: { Handlers: { "/": { Proxy: "unix:/run/matrix-nginx/tailnet.sock" } } } } });

    it("keeps a public install public and fails when Tailscale Serve cannot publish Matrix", () => {
      const { result, calls } = serveFixture(1, "{}");
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("switched-to-private");
      expect(result.stdout + result.stderr).toMatch(/Tailscale Serve/);
      expect(result.stdout + result.stderr).toMatch(/keeping your public listener/i);
      expect(calls).toContain("write_env public");
    });

    it("does not trust a Serve command that exits 0 but publishes nothing for Matrix's socket", () => {
      const other = JSON.stringify({ Web: { "box.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } } });
      const { result, calls } = serveFixture(0, other);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("switched-to-private");
      expect(calls).toContain("write_env public");
    });

    it("switches a public install to private only once Serve publishes Matrix's socket", () => {
      const { result } = serveFixture(0, published(443));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("switched-to-private");
    });

    it("never reports private access verified without an authenticated request", () => {
      const result = run(`curl() { printf '403'; }
ss() { :; }
MATRIX_INSTALL_LOG=/dev/null PREVIOUS_ACCESS_MODE= OPT_ACCESS=tailscale MATRIX_TAILSCALE_OWNER_LOGIN= verify_private_access`);
      expect(result.stdout + result.stderr).not.toMatch(/is reachable|only through Tailscale Serve/);
      expect(result.stdout + result.stderr).toMatch(/not verified/i);
      const switching = run(`curl() { printf '403'; }
restore_previous_listener() { echo restored; }
MATRIX_INSTALL_LOG=/dev/null PREVIOUS_ACCESS_MODE=public OPT_ACCESS=tailscale MATRIX_TAILSCALE_OWNER_LOGIN= verify_private_access`);
      expect(switching.status).not.toBe(0);
      expect(switching.stdout).toContain("restored");
    });
  });

  // Review P1 (#3532 at 0b159db3): a rollback restored public nginx but left the
  // gateway on the tailnet origin and private mode, so public terminals got 403.
  describe("rolling back to public access", () => {
    it("restores the public mode and origin, restarts the gateway and shell, and requires a public WebSocket upgrade", () => {
      const env = join(dir, "host.env");
      writeFileSync(env, "MATRIX_ACCESS_MODE=public\nSHELL_ORIGIN=http://matrix.example.com\n");
      const calls = join(dir, "rollback-calls");
      const body = (code: string) => `read_env_value() { sed -n "s/^$2=//p" "${env}" | grep . ; }
parse_args
MATRIX_HOST_ENV_FILE="${env}" restore_saved_access_mode >/dev/null
printf 'MATRIX_ACCESS_MODE=tailscale\\nSHELL_ORIGIN=https://box.ts.net\\n' >"${env}"
write_env() { o="$(self_host_shell_origin "$OPT_ACCESS" https://box.ts.net "$([ "$PREVIOUS_ACCESS_MODE" = public ] && echo "$PREVIOUS_SHELL_ORIGIN")" http://203.0.113.7)"; printf 'write_env %s origin=%s\\n' "$OPT_ACCESS" "$o" >>"${calls}"; printf 'SHELL_ORIGIN=%s\\n' "$o" >"${env}"; }
systemctl() { echo "systemctl $*" >>"${calls}"; }
nginx() { :; }
cat() { echo secret; }
sleep() { :; }
curl() { echo "curl $*" >>"${calls}"; printf '${code}'; }
MATRIX_INSTALL_LOG=/dev/null OPT_ACCESS=tailscale restore_previous_listener`;
      const ok = run(body("101"));
      expect(ok.status, ok.stderr).toBe(0);
      const log = readFileSync(calls, "utf8");
      expect(log).toContain("write_env public origin=http://matrix.example.com");
      expect(log).toContain("systemctl restart matrix-gateway.service matrix-shell.service");
      expect(log.indexOf("systemctl restart")).toBeLessThan(log.indexOf("curl"));
      expect(log).toMatch(/curl .*Upgrade: websocket.*http:\/\/127\.0\.0\.1\/ws/);
      // Review P2: public nginx requires the Origin host to be the Host, or a working recovery reads as failed.
      expect(log).toContain("Origin: http://matrix.example.com -H Host: matrix.example.com");
      const refused = run(body("403"));
      expect(refused.status).not.toBe(0);
    });

    // Found live: Tailscale Serve kept port 80 on the tailnet address, so public nginx could not bind.
    it("turns off Matrix's Tailscale Serve handlers before public nginx binds port 80", () => {
      const calls = join(dir, "serve-calls");
      const status = join(dir, "serve.json");
      const serve = (web: Record<string, string>) => {
        writeFileSync(status, JSON.stringify({ Web: Object.fromEntries(Object.entries(web).map(([host, proxy]) => [host, { Handlers: { "/": { Proxy: proxy } } }])) }));
        rmSync(calls, { force: true });
        return run(`tailscale() { [ "$*" = "serve status --json" ] && { cat "${status}"; return 0; }; echo "tailscale $*" >>"${calls}"; }
timeout() { shift; "$@"; }
MATRIX_INSTALL_LOG=/dev/null stop_matrix_tailscale_serve`);
      };
      const matrix = "unix:/run/matrix-nginx/tailnet.sock";
      expect(serve({ "box.ts.net:443": "http://127.0.0.1:9000" }).status).toBe(0);
      expect(existsSync(calls)).toBe(false);
      // Review P1: another app's HTTPS site on 443 stays when Matrix used HTTP on 80.
      const result = serve({ "box.ts.net:80": matrix, "box.ts.net:443": "http://127.0.0.1:9000" });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(calls, "utf8")).toBe("tailscale serve --http=80 off\n");
      serve({ "box.ts.net:443": matrix });
      expect(readFileSync(calls, "utf8")).toBe("tailscale serve --https=443 off\n");
      const main = readFileSync(script, "utf8").split("\nmain() {")[1]!;
      expect(main).toContain('[ "$OPT_ACCESS" != "public" ] || stop_matrix_tailscale_serve');
      expect(main.indexOf("stop_matrix_tailscale_serve")).toBeLessThan(main.indexOf("configure_nginx"));
      const restore = readFileSync(script, "utf8").split("\nrestore_previous_listener() {")[1]!.split("\n}\n")[0]!;
      // Found live: a reload cannot trade private nginx's 127.0.0.1:80 for 0.0.0.0:80.
      expect(restore).not.toContain("systemctl reload nginx");
      expect(restore.indexOf("stop_matrix_tailscale_serve")).toBeLessThan(restore.indexOf("systemctl restart nginx"));
    });

    it("never keeps a stale tailnet origin for a public install", () => {
      const writeEnv = readFileSync(script, "utf8").split("\nwrite_env() {")[1]!.split("\n}\n")[0]!;
      expect(writeEnv).toContain('saved_origin="${PREVIOUS_SHELL_ORIGIN:-$saved_origin}"');
      expect(writeEnv).toContain('[ "$saved_origin" != "$MATRIX_TAILNET_URL" ] || saved_origin=""');
      const failing = readFileSync(script, "utf8").split("\nprivate_access_failed() {")[1]!.split("\n}\n")[0]!;
      expect(failing).toMatch(/restore_previous_listener \|\| fail "\$1 Restoring public access failed/);
    });
  });

  it("records the public address the summary prints as the gateway's browser origin", () => {
    // Review P1: a public install with MATRIX_DOMAIN left SHELL_ORIGIN unset, so the
    // Browser viewer and retry refused the printed address.
    const origin = (args: string) => run(`self_host_shell_origin ${args}`).stdout.trim();
    expect(origin("public '' '' http://matrix.example.com")).toBe("http://matrix.example.com");
    expect(origin("public '' https://saved.example.com http://matrix.example.com")).toBe("https://saved.example.com");
    expect(origin("tailscale https://box.ts.net '' http://matrix.example.com")).toBe("https://box.ts.net");
    expect(run(`MATRIX_DOMAIN=matrix.example.com public_ui_origin`).stdout.trim()).toBe("http://matrix.example.com");
    expect(run(`hostname() { echo '203.0.113.7 10.0.0.2'; }\nMATRIX_DOMAIN=_ public_ui_origin`).stdout.trim()).toBe("http://203.0.113.7");
    const writeEnv = readFileSync(script, "utf8").split("\nwrite_env() {")[1]!.split("\n}\n")[0]!;
    expect(writeEnv).toContain('"$(public_ui_origin)"');
  });

  describe("browser profile move and the lifecycle", () => {
    it("finishes the move before the browser lifecycle is enabled, with the lifecycle stopped during it", () => {
      const body = readFileSync(script, "utf8").split("\nconfigure_browser() {")[1]!.split("\n}\n")[0]!;
      expect(body.indexOf("systemctl disable --now matrix-browser-runtime")).toBeGreaterThan(-1);
      expect(body.indexOf("systemctl disable --now matrix-browser-runtime")).toBeLessThan(body.indexOf("prepare_browser_account"));
      expect(body.indexOf("prepare_browser_account")).toBeLessThan(body.indexOf("systemctl enable matrix-browser-runtime"));
    });

    it("places a staged profile even when a fresh one was created, keeping the fresh one aside", () => {
      const home = join(dir, "browser-home");
      const stage = join(dir, "stage");
      const fresh = join(home, ".local/share/matrix-browser-lab/chrome");
      spawnSync("mkdir", ["-p", join(stage, "matrix-browser/chrome/Default"), join(fresh, "Default")]);
      writeFileSync(join(stage, "matrix-browser/chrome/Default/Cookies"), "saved session");
      writeFileSync(join(fresh, "Default/Cookies"), "fresh");
      const result = run(`systemctl() { :; }
chown() { :; }
runuser() { shift 3; "$@"; }
id() { case "$*" in "-gn matrix-browser") echo matrix-browser ;; *) command id "$@" ;; esac; }
MATRIX_INSTALL_LOG=/dev/null MATRIX_LEGACY_BROWSER_ROOT="${join(dir, "legacy")}" MATRIX_BROWSER_PROFILE_STAGE="${stage}" migrate_browser_profile matrix-browser "${home}"`);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(fresh, "Default/Cookies"), "utf8")).toBe("saved session");
      const parent = join(home, ".local/share/matrix-browser-lab");
      const asides = readdirSync(parent).filter((name) => name.startsWith("chrome.replaced-"));
      expect(asides).toHaveLength(1);
      const aside = join(parent, asides[0]!);
      expect(readFileSync(join(aside, "Default/Cookies"), "utf8")).toBe("fresh");
      expect(existsSync(stage)).toBe(false);
    });
  });

});
