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

    expect(installer).toContain('HERMES_RELEASE="${HERMES_RELEASE:-v2026.9.21}"');
    expect(installer).toContain(
      'HERMES_COMMIT="${HERMES_COMMIT:-d337b736aa1e8ebecfab043842d13e4a2d2f48a3}"',
    );
    expect(installer).toContain(
      'https://raw.githubusercontent.com/NousResearch/hermes-agent/$HERMES_COMMIT/scripts/install.sh',
    );
    expect(installer).toContain(
      'bash "$HERMES_INSTALLER_PATH" --branch main --commit "$HERMES_COMMIT" --force-commit --skip-setup',
    );
    expect(installer).not.toContain("NousResearch/hermes-agent/main/scripts/install.sh");
  });

  it("installs the optional native SDK from the pinned upstream dependency contract", async () => {
    const installer = await readFile(installerPath, "utf8");
    const sourceInstall = installer.indexOf('bash "$HERMES_INSTALLER_PATH" --branch main');
    const extraInstall = installer.indexOf('"${HERMES_HOME}/hermes-agent[anthropic]"');
    expect(extraInstall).toBeGreaterThan(sourceInstall);
    expect(installer).toContain('timeout 300 "${MATRIX_RUNTIME_HOME}/.local/bin/uv" --no-config pip install');
    expect(installer).toContain('--python "${HERMES_HOME}/hermes-agent/venv/bin/python"');
    expect(installer).toContain('--index-url https://pypi.org/simple');
    expect(installer).not.toMatch(/anthropic==|openai==/);
  });

  it.each([0, 42])("propagates dependency install status %i before reporting success", async status => {
    const root = await mkdtemp(join(tmpdir(), "hermes-provision-"));
    try {
      const installer = await readFile(installerPath, "utf8");
      const block = installer.slice(installer.indexOf('log "installing pinned Hermes native-provider dependencies"'), installer.indexOf("for cli in uv uvx hermes; do"));
      await mkdir(join(root, ".local/bin"), { recursive: true });
      // macOS has no GNU timeout; this fixture only checks process status wiring.
      await writeFile(join(root, ".local/bin/timeout"), '#!/bin/sh\n[ "$1" = 300 ] || exit 99\nshift\nexec "$@"\n', { mode: 0o755 });
      await writeFile(join(root, ".local/bin/uv"), `#!/bin/sh\nprintf '%s\\n' "$UV_HTTP_TIMEOUT" "$@" > "$HOME/invocation"\nexit ${status}\n`, { mode: 0o755 });
      const script = `set -eu\nMATRIX_RUNTIME_HOME="$1"\nHERMES_HOME="$1/.hermes"\nlog() { :; }\nrun_installer_as_runtime_user() { "$@"; }\n${block}\nprintf success > "$1/success"\n`;
      let exitStatus = 0;
      try { execFileSync("bash", ["-c", script, "fixture", root]); }
      catch (error) { exitStatus = (error as { status: number }).status; }
      expect(exitStatus).toBe(status);
      expect(await readFile(join(root, "invocation"), "utf8")).toBe([
        "60", "--no-config", "pip", "install", "--python", `${root}/.hermes/hermes-agent/venv/bin/python`,
        "--index-url", "https://pypi.org/simple", "--editable", `${root}/.hermes/hermes-agent[anthropic]`, "",
      ].join("\n"));
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
