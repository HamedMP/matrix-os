import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Review P1s (#3532 cutover): a public install switching to private must never
// lose its public UI. Failures during the switch restore it; failures before the
// switch leave the live site and the recorded public mode untouched. These tests
// source the real installer (functions only).
const root = process.cwd();
const script = join(root, "scripts/install-server.sh");
const source = readFileSync(script, "utf8");
const body = (name: string) => source.split(`\n${name}() {`)[1]!.split("\n}\n")[0]!;

function run(steps: string, env: Record<string, string> = {}) {
  const result = spawnSync("bash", ["-c", `set -Eeuo pipefail\nsource "$INSTALLER"\n${steps}`], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", INSTALLER: script, MATRIX_INSTALL_SOURCE_ONLY: "1",
      MATRIX_INSTALL_NONINTERACTIVE: "1", MATRIX_INSTALL_COLOR: "never", MATRIX_NO_TELEMETRY: "1", ...env },
  });
  return { status: result.status, out: result.stdout + result.stderr, stdout: result.stdout };
}

describe("self-host public-to-private cutover", () => {
  let dir: string, site: string, backup: string, calls: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matrix-cutover-"));
    [site, backup, calls] = ["matrix-self-host", "matrix-self-host.previous-site", "calls"].map((name) => join(dir, name));
    writeFileSync(site, "public site\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Host commands recorded instead of run; the real restore_previous_listener runs. */
  function cutover(steps: string, { websocket = "101", from = "public", arm = true } = {}) {
    return run(`stop_matrix_tailscale_serve() { echo "serve off" >>"${calls}"; }
nginx() { echo "nginx $*" >>"${calls}"; }
systemctl() { echo "systemctl $*" >>"${calls}"; }
write_env() { echo "write_env $OPT_ACCESS" >>"${calls}"; }
verify_public_websocket() { echo "verify public" >>"${calls}"; [ "${websocket}" = 101 ]; }
MATRIX_INSTALL_LOG=/dev/null PREVIOUS_ACCESS_MODE=${from} OPT_ACCESS=tailscale
${arm ? "begin_private_cutover" : ""}
${steps}`, { MATRIX_NGINX_SITE_FILE: site, MATRIX_NGINX_SITE_BACKUP: backup });
  }
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  const reset = () => { rmSync(calls, { force: true }); writeFileSync(site, "public site\n"); };
  const privateSite = () => `printf 'private site\\n' >"${site}"\n`;

  it("restores the public site, mode and services when the private nginx config fails its test", () => {
    const result = cutover(`${privateSite()}run_required "testing nginx configuration" false`);
    expect(result.status).not.toBe(0);
    expect(readFileSync(site, "utf8")).toBe("public site\n");
    for (const call of ["write_env public", "systemctl restart nginx", "systemctl restart matrix-gateway.service matrix-shell.service", "verify public"]) {
      expect(log()).toContain(call);
    }
    expect(result.out).toMatch(/restoring your public listener/i);
    expect(existsSync(backup)).toBe(false);
  });

  it("restores public access when nginx fails to restart, the installer exits through set -e, or an older backup exists", () => {
    const steps = [
      // The cutover's restart fails; the restore's restart works.
      `systemctl() { echo "systemctl $*" >>"${calls}"; [ "$*" != "restart nginx" ] || grep -q "write_env public" "${calls}"; }
restart_required_service nginx`,
      `false`,
      `fail "boom"`,
    ];
    for (const step of steps) {
      reset();
      writeFileSync(backup, "stale site from an older run\n");
      const result = cutover(privateSite() + step);
      expect(result.status, step).not.toBe(0);
      expect(readFileSync(site, "utf8"), step).toBe("public site\n");
      expect(log(), step).toContain("write_env public");
    }
  });

  it("restores once after a verification failure, and reports a rollback that did not bring public access back", () => {
    expect(cutover(`private_access_failed "verification failed."`).status).not.toBe(0);
    expect(log().match(/write_env public/g)).toHaveLength(1);
    const failed = cutover(`fail "boom"`, { websocket: "403" });
    expect(failed.status).not.toBe(0);
    expect(failed.out).toMatch(/public access did not come back/i);
  });

  it("keeps verified private access when a later step fails, drops the backup, and never arms outside a switch", () => {
    const verified = cutover(`${privateSite()}end_private_cutover\nfail "pairing failed"`);
    expect(verified.status).not.toBe(0);
    expect(readFileSync(site, "utf8")).toBe("private site\n");
    expect(existsSync(backup)).toBe(false);
    expect(log()).not.toContain("write_env public");
    expect(cutover(`fail "boom"`, { from: "tailscale" }).status).not.toBe(0);
    expect(log()).not.toContain("write_env public");
  });

  // Review P1 (Greptile, #3532 at 6d0cbe0590): a readiness failure before the
  // cutover restored an older run's backup over the live public site.
  it("leaves the live public site alone when readiness fails before the cutover", () => {
    writeFileSync(site, "public site with newer changes\n");
    writeFileSync(backup, "stale site from an older run\n");
    const result = cutover(`restore_previous_listener`, { arm: false });
    expect(result.status, result.out).toBe(0);
    expect(readFileSync(site, "utf8")).toBe("public site with newer changes\n");
    expect(log()).not.toContain("systemctl restart nginx");
    expect(log()).toContain("write_env public");
  });

  // Review P1 (#3532 at 6d0cbe0590): the env phase recorded private before the
  // cutover was armed, so a bundle failure and a flagless retry skipped the guard.
  it("records public in host.env until the cutover begins, and private from then on", () => {
    const mode = (steps: string, from = "public", to = "tailscale") =>
      run(`PREVIOUS_ACCESS_MODE=${from} OPT_ACCESS=${to} MATRIX_INSTALL_LOG=/dev/null\n${steps}\nenv_access_mode`,
        { MATRIX_NGINX_SITE_FILE: site, MATRIX_NGINX_SITE_BACKUP: backup }).stdout.trim();
    expect(mode("")).toBe("public");
    expect(mode("begin_private_cutover")).toBe("tailscale");
    expect(mode("begin_private_cutover\nend_private_cutover")).toBe("tailscale");
    expect(mode("", "tailscale", "headscale")).toBe("headscale");
    expect(mode("", "public", "public")).toBe("public");
    // Every use of OPT_ACCESS inside write_env sees the recorded mode.
    expect(body("write_env").split("\n").slice(0, 4).join("\n")).toMatch(/local OPT_ACCESS="\$access"/);
  });

  it("arms the rollback before the private env and site are written, and disarms it only after verification", () => {
    const main = body("main");
    const begin = main.indexOf("begin_private_cutover");
    const ready = main.indexOf("require_private_access_ready");
    expect(begin).toBeGreaterThan(ready);
    expect(begin).toBeLessThan(main.indexOf("write_env", ready));
    expect(begin).toBeLessThan(main.indexOf("configure_nginx"));
    const end = main.indexOf("end_private_cutover");
    expect(end).toBeGreaterThan(main.indexOf("verify_services"));
    expect(end).toBeLessThan(main.indexOf("pair_with_primary"));
    expect(body("cleanup_install_tmp")).toContain("rollback_failed_private_cutover");
    // The private site replaces the public one in a single rename.
    expect(body("configure_nginx")).toMatch(/render_nginx_site [^\n]*>"\$\{?next\}?"/);
    expect(body("configure_nginx")).toMatch(/mv -f "\$\{?next\}?" "\$\{?site\}?"/);
  });
});
