import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Outcome: after an update that raises the Codex pin, shared Codex Chat keeps
// working. The scope supervisor admits only the exact pinned release and reads
// the installed version once at start, so an older managed binary must be
// upgraded before the supervisor starts, not by the later background service.
const installerPath = "distro/customer-vps/host-bin/matrix-install-developer-tools";
const installer = readFileSync(installerPath, "utf8");
const syncAgent = readFileSync("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");
const pin = installer.match(/^CODEX_VERSION="([0-9.]+)"$/m)?.[1];
if (!pin) throw new Error("Missing Codex pin");
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** Runs the real installer with a fake managed prefix and a fake tool pack. */
function run(installed: string | null, pack: "upgrades" | "fails" | "stays-old" = "upgrades") {
  const root = mkdtempSync(join(tmpdir(), "codex-upgrade-before-scope-"));
  temporary.push(root);
  const prefix = join(root, "node");
  const state = join(root, "state");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  const codex = join(prefix, "bin/codex");
  const script = (version: string) => `#!/bin/sh\nprintf 'codex-cli %s\\n' '${version}'\n`;
  if (installed) writeFileSync(codex, script(installed), { mode: 0o755 });
  const packBody = pack === "fails" ? "exit 1"
    : pack === "stays-old" ? "exit 0"
    : `cp ${JSON.stringify(join(root, "pinned-codex"))} ${JSON.stringify(codex)}`;
  writeFileSync(join(root, "pinned-codex"), script(pin!), { mode: 0o755 });
  const toolPack = join(root, "tool-pack");
  writeFileSync(toolPack, `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(root, "pack-calls"))}\n${packBody}\n`, { mode: 0o755 });
  const source = installer
    .replace("if [ -r /opt/matrix/env/host.env ]; then\n  source /opt/matrix/env/host.env\nfi\n", "")
    .replaceAll("/opt/matrix/bin/matrix-install-tool-pack", toolPack);
  const copy = join(root, "installer");
  writeFileSync(copy, source, { mode: 0o755 });
  const result = spawnSync("bash", [copy, "--codex-upgrade-only"], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, MATRIX_NODE_PREFIX: prefix, MATRIX_DEVELOPER_TOOLS_STATE_DIR: state },
  });
  const calls = existsSync(join(root, "pack-calls")) ? readFileSync(join(root, "pack-calls"), "utf8") : "";
  const version = existsSync(codex) ? spawnSync(codex, { encoding: "utf8" }).stdout.trim() : null;
  return { result, calls, version, state };
}

describe("managed Codex upgrade before the scope supervisor starts", () => {
  it("upgrades an older managed Codex to the pin and touches nothing else", () => {
    const { result, calls, version, state } = run("0.162.1");
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toBe("codex\n");
    expect(version).toBe(`codex-cli ${pin}`);
    // The optional-tool bookkeeping belongs to the background service.
    expect(existsSync(join(state, "failed-tools"))).toBe(false);
    expect(existsSync(join(state, "installed-tools"))).toBe(false);
  });

  it.each([pin, "9.0.0"])("leaves current or newer %s alone", version => {
    const outcome = run(version);
    expect(outcome.result.status).toBe(0);
    expect(outcome.calls).toBe("");
    expect(outcome.version).toBe(`codex-cli ${version}`);
  });

  it("does not install Codex for an owner who never had it", () => {
    const outcome = run(null);
    expect(outcome.result.status).toBe(0);
    expect(outcome.calls).toBe("");
    expect(outcome.version).toBeNull();
  });

  it.each(["fails", "stays-old"] as const)("reports failure when the package step %s", pack => {
    expect(run("0.162.1", pack).result.status).toBe(1);
  });

  it("runs bounded and non-fatal in the updater before the supervisor is started", () => {
    const upgrade = syncAgent.indexOf('"$BIN_DIR/matrix-install-developer-tools" --codex-upgrade-only');
    const start = syncAgent.indexOf("sudo systemctl start matrix-scope-runtime.service");
    expect(upgrade).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(upgrade);
    // After the new host binaries land, so the new pin decides.
    expect(upgrade).toBeGreaterThan(syncAgent.indexOf('install_host_bin_payload "$extract_dir/bin"'));
    const call = syncAgent.slice(syncAgent.lastIndexOf("\n", syncAgent.lastIndexOf("if ", upgrade)), upgrade);
    expect(call).toContain("/usr/bin/timeout --kill-after=30 600");
    expect(syncAgent.slice(upgrade, start)).toContain("WARN: managed Codex upgrade deferred");
  });
});
