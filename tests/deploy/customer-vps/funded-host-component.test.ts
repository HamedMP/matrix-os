import { mkdtempSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("protected funded host repair delivery", () => {
  it("exercises real archive/file descriptors and strict response/transport contracts", () => {
    const result = spawnSync("python3", ["-I", "tests/deploy/customer-vps/funded-host-component.test.py"], {
      encoding: "utf8", timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("OK");
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
