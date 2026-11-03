import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("installs OS setup UI through the actual flat host-bin updater and restores it on rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-ui-update-"));
  try {
    const source = join(root, "source"), staged = join(root, "staged"), installed = join(root, "installed");
    await mkdir(source); await mkdir(installed);
    execFileSync("cp", ["-a", "scripts/spikes/browser-vps/.", source]);
    await mkdir(join(source, "lab/dist/assets"), { recursive: true });
    await writeFile(join(source, "lab/dist/index.html"), '<html><head><title>Browser Lab</title></head><script src="./assets/current.js"></script></html>');
    await writeFile(join(source, "lab/dist/assets/current.js"), "candidate asset");
    const { stageBrowserRuntime } = await import("../../../scripts/stage-browser-preview.mjs");
    await stageBrowserRuntime(source, staged);
    await writeFile(join(installed, "matrix-browser-ui-index.html"), "previous UI");
    await writeFile(join(installed, "matrix-browser-ui-old.js"), "previous asset");
    await writeFile(join(installed, "unrelated-host-file"), "preserved");
    const updater = await readFile("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");
    const definitions = ["install_host_bin_payload", "record_update_payload_directory", "restore_regular_file_atomic", "restore_update_payload_directory"]
      .map(name => {
        const definition = updater.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
        if (!definition) throw new Error(`Missing updater function ${name}`);
        return definition;
      }).join("\n");
    const script = `set -euo pipefail
BIN_DIR="$TEST_ROOT/installed"
UPDATE_TRANSACTION_DIR="$TEST_ROOT/transaction"
sudo() {
  if [ "$1" != install ]; then command "$@"; return; fi
  shift
  local arguments=()
  while [ "$#" -gt 0 ]; do
    case "$1" in -o|-g) shift 2 ;; *) arguments+=("$1"); shift ;; esac
  done
  command install "\${arguments[@]}"
}
log() { printf '%s\\n' "$*" >&2; }
${definitions}
record_update_payload_directory "$TEST_ROOT/staged" "$BIN_DIR" bin
install_host_bin_payload "$TEST_ROOT/staged"
test -f "$BIN_DIR/matrix-browser-ui-current.js"
grep -q matrix-browser-product "$BIN_DIR/matrix-browser-ui-index.html"
grep -q './assets/current.js' "$BIN_DIR/matrix-browser-ui-index.html"
test ! -e "$BIN_DIR/matrix-browser-ui-old.js"
test "$(cat "$BIN_DIR/unrelated-host-file")" = preserved
restore_update_payload_directory "$BIN_DIR" bin
test "$(cat "$BIN_DIR/matrix-browser-ui-index.html")" = 'previous UI'
test "$(cat "$BIN_DIR/matrix-browser-ui-old.js")" = 'previous asset'
test ! -e "$BIN_DIR/matrix-browser-ui-current.js"
`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 15_000, env: { ...process.env, TEST_ROOT: root } });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
