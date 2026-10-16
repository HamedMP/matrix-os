import { access, readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants } from "node:fs";
import { describe, expect, it } from "vitest";

const installerPath = "distro/customer-vps/host-bin/matrix-install-hermes";
const servicePath = "distro/customer-vps/systemd/matrix-hermes.service";

describe("customer VPS Hermes release", () => {
  it("pins the verified upstream release by immutable commit", async () => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain('HERMES_RELEASE="${HERMES_RELEASE:-v0.22.0}"');
    expect(installer).toContain(
      'HERMES_COMMIT="${HERMES_COMMIT:-e06df9c2eae6901f4c88f464e0ae6e753c0428b8}"',
    );
    expect(installer).toContain(
      'https://raw.githubusercontent.com/NousResearch/hermes-agent/$HERMES_COMMIT/scripts/install.sh',
    );
    expect(installer).toContain(
      'bash "$HERMES_INSTALLER_PATH" --branch main --commit "$HERMES_COMMIT" --skip-setup',
    );
    expect(installer).not.toContain("NousResearch/hermes-agent/main/scripts/install.sh");
  });

  it("uses upstream PM to persist the Anthropic extra across generation rebuilds", async () => {
    const installer = await readFile(installerPath, "utf8");
    expect(installer).toContain('timeout 600 "$MATRIX_RUNTIME_HOME/.local/bin/hermes" pm install --extra anthropic');
    expect(installer).not.toContain("uv --no-config pip install");
    expect(installer).not.toContain("--force-commit");
    expect(installer).not.toMatch(/anthropic==|openai==/);
  });

  it("runs the single canonical owner reconciliation after PM extras and bundled setup", async () => {
    const installer = await readFile(installerPath, "utf8");
    const hook = installer.indexOf('if [ -f "$MATRIX_APP_DIR/scripts/reconcile-agent-npm-prefix.mjs" ]; then');
    expect(hook).toBeGreaterThan(installer.indexOf('pm install --extra anthropic'));
    expect(hook).toBeGreaterThan(installer.indexOf('"$MATRIX_APP_DIR/scripts/configure-hermes-matrix-defaults.mjs"\n'));
    expect(installer.match(/scripts\/reconcile-agent-npm-prefix\.mjs"\n/g)).toHaveLength(1);
    const root = await mkdtemp(join(tmpdir(), "hermes-reconcile-hook-"));
    try {
      await mkdir(join(root, "node/bin"), { recursive: true });
      await mkdir(join(root, "app/scripts"), { recursive: true });
      await writeFile(join(root, "app/scripts/reconcile-agent-npm-prefix.mjs"), "fixture");
      await writeFile(join(root, "node/bin/node"), '#!/bin/sh\nprintf "%s\\n" "$HOME" "$MATRIX_RUNTIME_HOME" "$HERMES_HOME" "$MATRIX_NODE_PREFIX" "$@" > "$MATRIX_RUNTIME_HOME/hook-invocation"\n', { mode: 0o755 });
      const block = installer.slice(hook, installer.indexOf("\nfi", hook) + 3);
      execFileSync("bash", ["-c", `set -eu\nMATRIX_RUNTIME_HOME="$1"\nMATRIX_APP_DIR="$1/app"\nMATRIX_NODE_PREFIX="$1/node"\nHERMES_HOME="$1/.hermes"\nrun_installer_as_runtime_user() { "$@"; }\n${block}`, "fixture", root]);
      expect(await readFile(join(root, "hook-invocation"), "utf8")).toBe([root, root, `${root}/.hermes`, `${root}/node`, `${root}/app/scripts/reconcile-agent-npm-prefix.mjs`, ""].join("\n"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([0, 42])("propagates PM dependency status %i before reporting success", async status => {
    const root = await mkdtemp(join(tmpdir(), "hermes-provision-"));
    try {
      const installer = await readFile(installerPath, "utf8");
      const block = installer.slice(installer.indexOf('log "installing pinned Hermes native-provider dependencies"'), installer.indexOf("for cli in uv uvx hermes; do"));
      await mkdir(join(root, ".local/bin"), { recursive: true });
      await writeFile(join(root, ".local/bin/timeout"), '#!/bin/sh\n[ "$1" = 600 ] || exit 99\nshift\nexec "$@"\n', { mode: 0o755 });
      await writeFile(join(root, ".local/bin/hermes"), `#!/bin/sh\nprintf '%s\\n' "$HERMES_HOME" "$@" > "$HOME/invocation"\nexit ${status}\n`, { mode: 0o755 });
      const script = `set -eu\nMATRIX_RUNTIME_HOME="$1"\nHERMES_HOME="$1/.hermes"\nlog() { :; }\nrun_installer_as_runtime_user() { "$@"; }\n${block}\nprintf success > "$1/success"\n`;
      let exitStatus = 0;
      try { execFileSync("bash", ["-c", script, "fixture", root]); }
      catch (error) { exitStatus = (error as { status: number }).status; }
      expect(exitStatus).toBe(status);
      expect(await readFile(join(root, "invocation"), "utf8")).toBe([`${root}/.hermes`, "pm", "install", "--extra", "anthropic", ""].join("\n"));
      if (status === 0) expect(await readFile(join(root, "success"), "utf8")).toBe("success");
      else await expect(access(join(root, "success"))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps owner state outside the managed source update", async () => {
    const installer = await readFile(installerPath, "utf8");

    expect(installer).toContain('HERMES_HOME="${HERMES_HOME:-$MATRIX_RUNTIME_HOME/.hermes}"');
    expect(installer).not.toMatch(/rm\s+-rf\s+[^\n]*\$HERMES_HOME/);
    expect(installer).toContain(
      "systemctl is-active --quiet matrix-hermes-dashboard.service",
    );
    expect(installer).not.toContain(
      "systemctl is-enabled --quiet matrix-hermes-dashboard.service",
    );
    expect(installer).toContain("restore_hermes_dashboard");
    expect(installer).toContain("trap restore_hermes_dashboard EXIT");
  });

  it("ships the installer unit and schedules upgrades only after host-bundle commit", async () => {
    const service = await readFile(servicePath, "utf8");
    const updater = await readFile("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");
    const commitIndex = updater.indexOf("if commit_release_metadata; then");
    const reconcileIndex = updater.indexOf("reconcile_hermes_release ||", commitIndex);

    expect(service).toContain("ExecStart=/opt/matrix/bin/matrix-install-hermes");
    expect(service).toContain("TimeoutStartSec=1800");
    expect(updater).toContain('if [ -f "/etc/systemd/system/matrix-hermes.service" ]; then');
    expect(updater).toContain("systemctl enable matrix-hermes.service");
    expect(updater).toContain("systemctl restart --no-block matrix-hermes.service");
    expect(commitIndex).toBeGreaterThan(-1);
    expect(reconcileIndex).toBeGreaterThan(commitIndex);
    await expect(access(servicePath, constants.R_OK)).resolves.toBeUndefined();
  });

  it("keeps failed post-commit Hermes scheduling retryable across poll cycles", async () => {
    const updater = await readFile("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");
    const commitIndex = updater.indexOf("if commit_release_metadata; then");
    const markIndex = updater.indexOf(
      'mark_hermes_reconciliation_pending "$version"',
      commitIndex,
    );
    const reconcileIndex = updater.indexOf("reconcile_hermes_release", markIndex);

    expect(updater).toContain(
      'readonly HERMES_RECONCILE_MARKER="$STAGING_DIR/hermes-reconcile-pending"',
    );
    expect(updater).toContain("mark_hermes_reconciliation_pending() {");
    expect(updater).toContain("maybe_reconcile_hermes_release() {");
    expect(updater).toContain('sudo rm -f -- "$HERMES_RECONCILE_MARKER"');
    expect(markIndex).toBeGreaterThan(commitIndex);
    expect(reconcileIndex).toBeGreaterThan(markIndex);
    expect(updater).toMatch(
      /maybe_reconcile_hermes_release \|\| log "WARN: Hermes release reconciliation retry failed"/,
    );
  });
});
