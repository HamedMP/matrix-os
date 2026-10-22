import { existsSync, mkdtempSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("protected funded host repair delivery", () => {
  it.skipIf(process.getuid?.() !== 0 || process.platform !== "linux"
    || process.env.MATRIX_DISPOSABLE_ROOT_TEST !== "true" || !existsSync("/.dockerenv"))
  ("executes the emitted program lifecycle in a disposable root Linux container", () => {
    const result = spawnSync("python3", ["-I", "tests/deploy/customer-vps/funded-host-generated.test.py"], {
      encoding: "utf8", timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* test/);
    expect(result.stderr).toMatch(/\nOK\s*$/);
    expect(result.stderr).not.toContain("skipped=");
  });

  it("builds self-contained protected code and inlined trusted bootstrap without staged imports", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-funded-component-")); roots.push(root);
    const agent = join(root, "agent");
    copyFileSync("distro/customer-vps/host-bin/matrix-sync-agent", agent);
    const build = spawnSync(process.execPath, ["scripts/prepare-funded-host-component.mjs", agent, join(root, "component")], {
      encoding: "utf8", timeout: 10_000,
    });
    expect(build.status, build.stderr).toBe(0);
    const built = readFileSync(join(root, "component", "reconcile.py"), "utf8");
    const syntax = spawnSync("python3", ["-I", "-c", "import sys;compile(sys.stdin.read(),'<protected>','exec')"], {
      input: built, encoding: "utf8", timeout: 10_000,
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    const shell = spawnSync("bash", ["-n", agent], { encoding: "utf8", timeout: 10_000 });
    expect(shell.status, shell.stderr).toBe(0);
    expect(readFileSync(agent, "utf8")).toContain("sudo /usr/bin/python3 -I -");
    expect(built).toContain("REPAIR_SOURCE = ");
    expect(readFileSync(join(root, "component", "matrix-funded-host-config.service"), "utf8")).not.toContain("[Install]");
    expect(readFileSync(join(root, "component", "matrix-funded-host-config.service"), "utf8")).toContain("TimeoutStopSec=1800");
  });

  it.each(["unchanged", "new-targets", "new-trigger", "record-allocation-failed"])("retires consumed retry identities while preserving %s requests", race => {
    const root = mkdtempSync(join(tmpdir(), "matrix-funded-retry-")); roots.push(root);
    const source = readFileSync("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");
    const prepare = source.slice(source.indexOf("prepare_triggered_update() {"), source.indexOf("\n# ── Poll for updates"));
    const library = readFileSync("distro/customer-vps/host-bin/matrix-update-request-rejection", "utf8");
    const script = `
APP_DIR=${JSON.stringify(root)}
UPDATE_TRIGGER="$APP_DIR/.update-now"
UPDATE_MARKER="$APP_DIR/.update-available.json"
UPDATE_VERSION_FILE="$APP_DIR/.update-version"
UPDATE_CHANNEL_FILE="$APP_DIR/.update-channel"
UPDATE_PHASE_MARKER="$APP_DIR/update-phase"
UPDATE_ERROR_MARKER="$APP_DIR/update-error"
sudo() { command "$@"; }
log() { :; }
current_version() { echo installed; }
funded_host_bootstrap() { echo "retry:$2"; }
${library}
echo installed > "$UPDATE_VERSION_FILE"
echo stable > "$UPDATE_CHANNEL_FILE"
touch "$UPDATE_TRIGGER"
expected="$(update_request_identity)"
mktemp() {
 case "$1" in *.update-rejected-targets.*)
  ${race === "new-targets" ? 'echo replacement > "$APP_DIR/new-version"; mv "$APP_DIR/new-version" "$UPDATE_VERSION_FILE"; echo beta > "$APP_DIR/new-channel"; mv "$APP_DIR/new-channel" "$UPDATE_CHANNEL_FILE"; touch "$UPDATE_TRIGGER"' : race === "new-trigger" ? 'echo new-trigger > "$UPDATE_TRIGGER"' : race === "record-allocation-failed" ? "return 1" : ":"}
 ;; esac
 command mktemp "$@"
}
${race === "record-allocation-failed" ? 'if schedule_current_funded_retry "$expected"; then exit 8; fi' : 'schedule_current_funded_retry "$expected" || exit 1'}
${race === "new-targets" ? '[ "$(cat "$UPDATE_VERSION_FILE")" = replacement ] && [ "$(cat "$UPDATE_CHANNEL_FILE")" = beta ] && ! update_target_was_rejected "$UPDATE_VERSION_FILE" && ! update_target_was_rejected "$UPDATE_CHANNEL_FILE" || exit 2' : race === "record-allocation-failed" ? '! update_target_was_rejected "$UPDATE_VERSION_FILE" && ! update_target_was_rejected "$UPDATE_CHANNEL_FILE" || exit 9' : 'update_target_was_rejected "$UPDATE_VERSION_FILE" && update_target_was_rejected "$UPDATE_CHANNEL_FILE" || exit 3'}
${race === "unchanged" ? '[ ! -e "$UPDATE_TRIGGER" ] || exit 4' : '[ -e "$UPDATE_TRIGGER" ] || exit 5'}
${race === "unchanged" ? `echo '{"version":"newer","channel":"stable"}' > "$UPDATE_MARKER"
touch "$UPDATE_TRIGGER"
json_field() { python3 -c "import json,sys;print(json.load(sys.stdin).get(sys.argv[1],''))" "$2" <<< "$1"; }
release_url_for_version() { echo "$1"; }
fetch_manifest() { echo '{"version":"installed"}'; }
installed_terminal_runtime_is_ready() { return 0; }
${prepare}
prepare_triggered_update || exit 6
[ "$prepare_triggered_update_action" = apply ] || exit 7` : ""}
`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    if (race === "record-allocation-failed") expect(result.stdout).not.toContain("retry:");
    else expect(result.stdout).toContain("retry:installed");
  });

  it.each(["explicit", "passive"])("%s prior-version request retains current artifact pending guarded rollback", trigger => {
    const source = readFileSync("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");
    const start = source.indexOf("apply_update() {");
    const end = source.indexOf("\nrun_apply_update()", start);
    const apply = source.slice(start, end).trim();
    const root = mkdtempSync(join(tmpdir(), "matrix-funded-update-")); roots.push(root);
    const marker = join(root, "marker"); copyFileSync("package.json", marker);
    const script = `
UPDATE_MARKER=${JSON.stringify(marker)}
update_request_identity() { echo fingerprint; }
load_trusted_apply_manifest() { echo '{}'; }
json_field() { case "$2" in version) echo prior;; sha256) echo hash;; url) echo url;; esac; }
current_version() { echo current; }
sudo() { return 0; }
compare_host_bundle_versions() { echo older; }
reject_unchanged_update_request() { echo claimed; }
funded_host_bootstrap() { echo "protected:$1:$2:$3"; }
write_update_error() { echo "$1"; }
log() { :; }
${apply}
apply_update ${trigger}
`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("funded_rollback_required");
    if (trigger === "explicit") expect(result.stdout).toContain("protected:rollback:current:prior");
    else expect(result.stdout).not.toContain("protected:");
  });
});
