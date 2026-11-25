import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Review P1 (#3532 cutover): a public install switching to private wrote the
// private host.env and nginx site, then tested and restarted nginx, before any
// code that could roll back. An nginx test failure left the private site on
// disk, and a restart failure took the only listener down, so the owner lost
// the UI. These tests source the real installer (functions only).
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

describe("self-host public-to-private cutover", () => {
  let dir: string;
  let site: string;
  let backup: string;
  let calls: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matrix-cutover-"));
    site = join(dir, "matrix-self-host");
    backup = join(dir, "matrix-self-host.previous-site");
    calls = join(dir, "calls");
    writeFileSync(site, "public site\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Host commands recorded instead of run; the real restore_previous_listener runs. */
  function cutover(steps: string, websocket = "101") {
    return run(`stop_matrix_tailscale_serve() { echo "serve off" >>"${calls}"; }
nginx() { echo "nginx $*" >>"${calls}"; }
systemctl() { echo "systemctl $*" >>"${calls}"; }
write_env() { echo "write_env $OPT_ACCESS" >>"${calls}"; }
verify_public_websocket() { echo "verify public" >>"${calls}"; [ "${websocket}" = 101 ]; }
MATRIX_INSTALL_LOG=/dev/null PREVIOUS_ACCESS_MODE=public OPT_ACCESS=tailscale
begin_private_cutover
${steps}`, { MATRIX_NGINX_SITE_FILE: site, MATRIX_NGINX_SITE_BACKUP: backup });
  }
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");

  it("restores the public site, mode and services when the private nginx config fails its test", () => {
    const result = cutover(`printf 'private site\\n' >"${site}"
run_required "testing nginx configuration" false`);
    expect(result.status).not.toBe(0);
    expect(readFileSync(site, "utf8")).toBe("public site\n");
    expect(log()).toContain("write_env public");
    expect(log()).toContain("systemctl restart nginx");
    expect(log()).toContain("systemctl restart matrix-gateway.service matrix-shell.service");
    expect(log()).toContain("verify public");
    expect(result.stdout + result.stderr).toMatch(/restoring your public listener/i);
  });

  it("restores public access when nginx fails to restart mid-cutover, or the installer exits through set -e", () => {
    const steps = [
      // The cutover's restart fails; the restore's restart works.
      `systemctl() { echo "systemctl $*" >>"${calls}"; [ "$*" != "restart nginx" ] || grep -q "write_env public" "${calls}"; }
restart_required_service nginx`,
      `false`,
    ];
    for (const step of steps) {
      rmSync(calls, { force: true });
      writeFileSync(site, "public site\n");
      const result = cutover(`printf 'private site\\n' >"${site}"
${step}`);
      expect(result.status, step).not.toBe(0);
      expect(readFileSync(site, "utf8"), step).toBe("public site\n");
      expect(log(), step).toContain("write_env public");
    }
  });

  it("saves the live public site, never an older run's copy", () => {
    writeFileSync(backup, "stale site from an older run\n");
    const result = cutover(`printf 'private site\\n' >"${site}"
fail "boom"`);
    expect(result.status).not.toBe(0);
    expect(readFileSync(site, "utf8")).toBe("public site\n");
  });

  it("restores once when a verification failure already rolled back", () => {
    const result = cutover(`private_access_failed "verification failed."`);
    expect(result.status).not.toBe(0);
    expect(log().match(/write_env public/g)).toHaveLength(1);
  });

  it("reports a rollback that could not bring public access back", () => {
    const result = cutover(`fail "boom"`, "403");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/public access did not come back/i);
  });

  it("keeps private access once it is verified, even if a later step fails, and does nothing outside a cutover", () => {
    const verified = cutover(`printf 'private site\\n' >"${site}"
end_private_cutover
fail "pairing failed"`);
    expect(verified.status).not.toBe(0);
    expect(readFileSync(site, "utf8")).toBe("private site\n");
    expect(log()).not.toContain("write_env public");
    const ok = cutover(`end_private_cutover`);
    expect(ok.status, ok.stderr).toBe(0);
    expect(log()).not.toContain("write_env public");
    // An install that is not switching from public never arms the rollback.
    const rerun = run(`write_env() { echo "write_env $OPT_ACCESS" >>"${calls}"; }
MATRIX_INSTALL_LOG=/dev/null PREVIOUS_ACCESS_MODE=tailscale OPT_ACCESS=tailscale
begin_private_cutover
fail "boom"`, { MATRIX_NGINX_SITE_FILE: site, MATRIX_NGINX_SITE_BACKUP: backup });
    expect(rerun.status).not.toBe(0);
    expect(log()).not.toContain("write_env public");
  });

  it("arms the rollback before the private env and site are written, and disarms it only after verification", () => {
    const main = readFileSync(script, "utf8").split("\nmain() {")[1]!.split("\n}\n")[0]!;
    const begin = main.indexOf("begin_private_cutover");
    const ready = main.indexOf("require_private_access_ready");
    expect(begin).toBeGreaterThan(ready);
    expect(begin).toBeLessThan(main.indexOf("write_env", ready));
    expect(begin).toBeLessThan(main.indexOf("configure_nginx"));
    const end = main.indexOf("end_private_cutover");
    expect(end).toBeGreaterThan(main.indexOf("verify_services"));
    expect(end).toBeLessThan(main.indexOf("pair_with_primary"));
    const cleanup = readFileSync(script, "utf8").split("\ncleanup_install_tmp() {")[1]!.split("\n}\n")[0]!;
    expect(cleanup).toContain("rollback_failed_private_cutover");
    // The private site replaces the public one in a single rename.
    const nginx = readFileSync(script, "utf8").split("\nconfigure_nginx() {")[1]!.split("\n}\n")[0]!;
    expect(nginx).toMatch(/render_nginx_site [^\n]*>"\$\{?next\}?"/);
    expect(nginx).toMatch(/mv -f "\$\{?next\}?" "\$\{?site\}?"/);
  });
});
