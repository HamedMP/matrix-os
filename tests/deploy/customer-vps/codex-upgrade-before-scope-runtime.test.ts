import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const predecessorPath = "tests/deploy/customer-vps/fixtures/browser-predecessor-updater.sh";
const updaterPath = "distro/customer-vps/host-bin/matrix-sync-agent";
const stagePath = "scripts/stage-host-codex.sh";
const runnerName = "matrix-codex";
const archiveMember = "codex-x86_64-unknown-linux-musl";
const hostName = "codex-code-mode-host";
const hostArchiveMember = "codex-code-mode-host-x86_64-unknown-linux-musl";

function shellFunction(source: string, name: string): string {
  const definition = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
  if (!definition) throw new Error(`Missing updater function ${name}`);
  return definition;
}

it.each(["0.162.1", null])(
  "keeps first-upgrade and rollback working with previous release binary %s",
  async previous => {
    const root = await mkdtemp(join(tmpdir(), "matrix-codex-release-"));
    try {
      const staged = join(root, "staged");
      const installed = join(root, "installed");
      await mkdir(staged);
      await mkdir(installed);
      const versionScript = (version: string) => `#!/bin/sh\necho 'codex-cli ${version}'\n`;
      await writeFile(join(root, "terminal-codex"), versionScript("0.162.1"), { mode: 0o755 });
      if (previous) await writeFile(join(installed, runnerName), versionScript(previous), { mode: 0o755 });
      await writeFile(join(root, archiveMember), versionScript("0.171.0"), { mode: 0o755 });
      const archive = join(root, "codex.tar.gz");
      execFileSync("tar", ["-czf", archive, "-C", root, archiveMember]);
      const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
      await writeFile(join(root, hostArchiveMember), "#!/bin/sh\necho 'code-mode-host'\n", { mode: 0o755 });
      const hostArchive = join(root, "code-mode-host.tar.gz");
      execFileSync("tar", ["-czf", hostArchive, "-C", root, hostArchiveMember]);
      const hostDigest = createHash("sha256").update(await readFile(hostArchive)).digest("hex");

      for (const [codexDigest, sidecarDigest] of [["0".repeat(64), hostDigest], [digest, "0".repeat(64)]]) {
        const rejected = spawnSync("bash", [stagePath, archive, codexDigest, hostArchive, sidecarDigest, staged], { encoding: "utf8" });
        expect(rejected.status).toBe(1);
        await expect(readFile(join(staged, runnerName))).rejects.toHaveProperty("code", "ENOENT");
        await expect(readFile(join(staged, hostName))).rejects.toHaveProperty("code", "ENOENT");
      }
      const packaged = spawnSync("bash", [stagePath, archive, digest, hostArchive, hostDigest, staged], { encoding: "utf8" });
      expect(packaged.status, packaged.stderr).toBe(0);

      const predecessor = await readFile(predecessorPath, "utf8");
      const updater = await readFile(updaterPath, "utf8");
      const transaction = ["record_update_payload_directory", "restore_regular_file_atomic", "restore_update_payload_directory"]
        .map(name => shellFunction(updater, name)).join("\n");
      const result = spawnSync("bash", ["-c", `set -euo pipefail
BIN_DIR="$TEST_ROOT/installed"
UPDATE_TRANSACTION_DIR="$TEST_ROOT/transaction"
sudo() {
  local tool="$1"
  shift
  case "$tool" in
    install)
      local args=()
      while [ "$#" -gt 0 ]; do
        case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
      done
      command install "\${args[@]}" ;;
    mv)
      if [ "$1" = -Tf ]; then shift; fi
      command mv -f "$@" ;;
    *) command "$tool" "$@" ;;
  esac
}
log() { printf '%s\\n' "$*" >&2; }
${shellFunction(predecessor, "install_host_bin_payload")}
${transaction}
record_update_payload_directory "$TEST_ROOT/staged" "$BIN_DIR" bin
install_host_bin_payload "$TEST_ROOT/staged"
# The predecessor starts the incoming scope runtime after this host-bin step.
test "$("$BIN_DIR/matrix-codex" --version)" = 'codex-cli 0.171.0'
# Codex resolves its shell-tool sidecar next to the running executable.
test "$("$BIN_DIR/codex-code-mode-host")" = 'code-mode-host'
test "$("$TEST_ROOT/terminal-codex" --version)" = 'codex-cli 0.162.1'
restore_update_payload_directory "$BIN_DIR" bin
if [ -n "$PREVIOUS" ]; then
  test "$("$BIN_DIR/matrix-codex" --version)" = "codex-cli $PREVIOUS"
else
  test ! -e "$BIN_DIR/matrix-codex"
fi
test ! -e "$BIN_DIR/codex-code-mode-host"
test "$("$TEST_ROOT/terminal-codex" --version)" = 'codex-cli 0.162.1'
`], {
        encoding: "utf8", timeout: 15_000,
        env: { ...process.env, TEST_ROOT: root, PREVIOUS: previous ?? "" },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
