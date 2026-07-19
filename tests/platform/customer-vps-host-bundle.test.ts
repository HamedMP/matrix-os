import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CODEX_VERIFIED_VERSION } from '../../packages/contracts/src/index.js';

function sha256(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function runDevBundleGate(env: Record<string, string>) {
  const root = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'matrix-dev-bundle-gate-'));
  const outputPath = join(tempDir, 'github-output');

  try {
    const result = spawnSync('bash', [join(root, 'scripts/ci/dev-bundle-gate.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        ...env,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);

    return {
      output: readFileSync(outputPath, 'utf8'),
      stdout: result.stdout,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('customer VPS host bundle', () => {
  it('build script packages the systemd entrypoint binaries', () => {
    const root = process.cwd();
    const script = readFileSync(join(root, 'scripts/build-host-bundle.sh'), 'utf8');

    expect(script).toContain('matrix-host-bundle.tar.gz');
    expect(script).toContain('matrix-gateway');
    expect(script).toContain('matrix-shell');
    expect(script).toContain('matrix-code');
    expect(script).toContain('matrix-sync-agent');
    expect(script).toContain('sha256sum');
    expect(script).toContain('pnpm rebuild node-pty');
    expect(script).toContain('scripts/build-default-apps.mjs');
    expect(script).toContain('generateTemplateManifest');
    expect(script).toContain('home/.template-manifest.json');
    expect(script).toContain('scripts/reset-shipped-icons.mjs');
    expect(script).toContain('scripts/sync-matrix-agent-skills.sh');
    expect(script).toContain('scripts/host-bundle-release.mjs" write-release');
    expect(script).toContain('HOST_BUNDLE_INCREMENTAL_EXCLUDE_PREFIXES="${HOST_BUNDLE_INCREMENTAL_EXCLUDE_PREFIXES:-node_modules/}"');
    expect(script).toContain('scripts/host-bundle-incremental-manifest.mjs" "$STAGE_DIR/app" "$STAGE_DIR/incremental-manifest.json" "$DIST_DIR/objects"');
    expect(script).toContain('scripts/host-bundle-release.mjs" write-manifest');
    expect(script).toContain('bin app runtime systemd release.json incremental-manifest.json');
    expect(script).toContain('manifest.json');
    expect(script).toContain('release.json');
    expect(script).toContain('incremental-manifest.json');
    expect(script).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:?set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY before building the customer host bundle');
    expect(script).toContain('GH_VERSION="${HOST_BUNDLE_GH_VERSION:-2.86.0}"');
    expect(script).toContain('GH_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_ARCHIVE}"');
    expect(script).toContain('install -m 0755 "$DIST_DIR/$GH_DIST/bin/gh" "$STAGE_DIR/runtime/node/bin/gh"');
    expect(script).toContain('install -m 0755 "$DIST_DIR/$GH_DIST/bin/gh" "$STAGE_DIR/app/node_modules/.bin/gh"');
    expect(script).toContain('chmod 0755 "$STAGE_DIR/bin/matrix-owner-env" "$STAGE_DIR/bin/matrix-gateway"');
    expect(script).toContain('tar -xzf "$DIST_DIR/$ZELLIJ_ARCHIVE" -C "$STAGE_DIR/bin" zellij');
    expect(script).toContain('test -x "$STAGE_DIR/bin/zellij"');
    expect(script).toContain('rm -rf "$STAGE_DIR/app/shell/.next/cache" "$STAGE_DIR/app/shell/e2e" "$STAGE_DIR/app/shell/node_modules"');
    expect(script).toContain('find "$STAGE_DIR/app/home/apps" -type d -name node_modules -prune -exec rm -rf {} +');
    expect(script).toContain('matrix-update');
    expect(script).toContain('cp -a "$ROOT_DIR/distro/customer-vps/systemd/." "$STAGE_DIR/systemd/"');
    expect(script).toContain('matrix-messaging-health');
    expect(script).toContain('"$STAGE_DIR/runtime/node/bin/gh"');
    expect(script).toContain('bin app runtime systemd release.json');
  });

  it('host bundle defers heavy optional tools to selectable boot-time packs', () => {
    const root = process.cwd();
    const script = readFileSync(join(root, 'scripts/build-host-bundle.sh'), 'utf8');
    const installer = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-install-tool-pack'), 'utf8');
    const hermesInstaller = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-install-hermes'), 'utf8');
    const ownerEnv = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-owner-env'), 'utf8');
    const gateway = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-gateway'), 'utf8');
    const shell = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-shell'), 'utf8');
    const code = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-code'), 'utf8');
    const symphony = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-symphony'), 'utf8');

    expect(script).toContain('matrix-install-tool-pack');
    expect(script).toContain('matrix-owner-env');
    expect(hermesInstaller).toContain('setpriv --reuid "$MATRIX_RUNTIME_USER"');
    expect(installer).toContain('setpriv --reuid "$MATRIX_RUNTIME_USER"');
    expect(script).not.toContain('curl --fail --location --max-time 180 "$CODE_SERVER_URL"');
    expect(script).not.toContain('tar -xzf "$DIST_DIR/$CODE_SERVER_ARCHIVE"');
    expect(script).not.toContain('"$STAGE_DIR/runtime/node/bin/npm" install -g --prefix "$STAGE_DIR/runtime/node"');
    expect(installer).toContain('install_coding_agents()');
    expect(installer).toContain('finish_agent_install()');
    expect(installer).toContain('install_code_server()');
    expect(installer).toContain('install_hermes()');
    expect(installer).toContain('@anthropic-ai/claude-code@latest');
    expect(installer).toContain(`CODEX_VERSION="${CODEX_VERIFIED_VERSION}"`);
    expect(installer).toContain('"@openai/codex@${CODEX_VERSION}"');
    expect(installer).toContain('OPENCODE_AI_VERSION="${OPENCODE_AI_VERSION:-latest}"');
    expect(installer).toContain('PI_CODING_AGENT_VERSION="${PI_CODING_AGENT_VERSION:-latest}"');
    expect(installer).toContain('"opencode-ai@${OPENCODE_AI_VERSION}"');
    expect(installer).toContain('run_npm_install()');
    expect(installer).toContain('run_as_root()');
    expect(installer).toContain('[ -x "$MATRIX_RUNTIME_DIR/code-server/bin/code-server" ]');
    expect(installer).not.toContain('command -v code-server >/dev/null 2>&1');
    expect(installer).toContain('run_as_root rm -rf "$MATRIX_RUNTIME_DIR/code-server"');
    expect(installer).toContain('run_as_root mv "$tmp_dir/$CODE_SERVER_DIST" "$MATRIX_RUNTIME_DIR/code-server"');
    expect(installer).not.toContain('sudo rm -rf "$MATRIX_RUNTIME_DIR/code-server"');
    expect(installer).toContain('resolve_runtime_user()');
    expect(installer).toContain('runtime user ${MATRIX_RUNTIME_USER} not found; using current user ${current_user}');
    expect(installer).toContain('run_as_matrix "$timeout_bin" 900 "$NODE_PREFIX/bin/npm" "$@"');
    expect(installer).toContain('run_npm_install install -g --ignore-scripts --prefix "$NODE_PREFIX"');
    expect(installer).toContain('"@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}"');
    expect(installer).toContain('node_prefix_chmod()');
    expect(installer).toContain('if ! command -v flock >/dev/null 2>&1; then');
    expect(installer).toContain('install_claude_code_package()');
    expect(installer).toContain('install_codex_package()');
    expect(installer).toContain('install_opencode_package()');
    expect(installer).toContain('install_pi_package()');
    expect(installer).toMatch(/install_coding_agents\(\) \{\n  log "installing coding agent CLIs"\n  install_claude_code_package\n  install_codex_package\n  install_opencode_package\n  install_pi_package\n  finish_agent_install\n  log "coding agent CLIs installed"\n\}/);
    expect(installer).toContain('curl --fail --location --retry 3 --retry-delay 5 --retry-all-errors');
    expect(installer).toContain('sync-matrix-agent-skills.sh');
    expect(installer).toContain('claude-code|codex|opencode|pi|coding-agents|code-server|hermes|linux-tools|all');
    expect(installer).toContain('claude-code) with_pack_lock "$pack" install_claude_code ;;');
    expect(installer).toContain('codex) with_pack_lock "$pack" install_codex ;;');
    expect(installer).toContain('opencode) with_pack_lock "$pack" install_opencode ;;');
    expect(installer).toContain('pi) with_pack_lock "$pack" install_pi ;;');
    expect(installer).toContain('return 75');
    expect(installer).not.toContain('exit 0');
    expect(installer).toContain('systemctl start matrix-linux-tools.service');
    expect(installer).toContain('sudo systemctl start matrix-linux-tools.service');
    expect(installer).toContain('failed=0');
    expect(installer).toContain('if ! wait "$pid"; then');
    expect(installer).toContain('exit "$failed"');
    expect(installer).not.toMatch(/wait "\$pid_coding_agents" "\$pid_code_server"/);
    expect(ownerEnv).toContain('matrix_export_owner_env()');
    expect(ownerEnv).toContain('export HOME="$MATRIX_HOME"');
    expect(ownerEnv).toContain('export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"');
    expect(ownerEnv).toContain('export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"');
    expect(ownerEnv).toContain('matrix_prepend_path_once()');
    expect(ownerEnv).toContain('matrix_prepend_path_once "$HOME/.local/bin"');
    expect(ownerEnv).toContain('matrix_prepend_path_once "/opt/matrix/bin"');
    expect(ownerEnv).toContain('matrix_reconcile_owner_home()');
    expect(ownerEnv).toContain('failed to copy %s to %s; leaving legacy directory in place');
    expect(ownerEnv).toContain('failed to remove legacy %s after copy; leaving in place');
    expect(ownerEnv).toContain('matrix_migrate_legacy_dotdir ".local" 0755 "$owner" "$group"');
    expect(ownerEnv).toContain('matrix_migrate_legacy_dotdir ".hermes" 0700 "$owner" "$group"');
    expect(hermesInstaller).toContain('source /opt/matrix/bin/matrix-owner-env');
    expect(hermesInstaller).toContain('matrix_install_owner_dirs "$MATRIX_RUNTIME_USER" "$MATRIX_RUNTIME_USER"');
    expect(hermesInstaller).toContain('matrix_migrate_legacy_dotdir ".hermes" 0700');
    expect(hermesInstaller).toContain('HOME="$MATRIX_RUNTIME_HOME"');
    expect(hermesInstaller).toContain('HERMES_HOME="$HERMES_HOME"');
    expect(hermesInstaller).toContain('XDG_CONFIG_HOME="$MATRIX_RUNTIME_HOME/.config"');
    for (const launcher of [gateway, shell, code, symphony]) {
      expect(launcher).toContain('if declare -F matrix_reconcile_owner_home >/dev/null 2>&1; then');
      expect(launcher).toContain('matrix_reconcile_owner_home "${MATRIX_RUNTIME_USER:-matrix}" "${MATRIX_RUNTIME_GROUP:-${MATRIX_RUNTIME_USER:-matrix}}"');
    }
  });

  it('packages an asynchronous developer tools first-boot service', () => {
    const root = process.cwd();
    const unit = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-developer-tools.service'), 'utf8');
    const gatewayUnit = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-gateway.service'), 'utf8');
    const codeServerUnit = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-code-server.service'), 'utf8');
    const codeUnit = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-code.service'), 'utf8');
    const installer = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-install-developer-tools'), 'utf8');

    expect(unit).toContain('Description=Matrix OS optional developer tools');
    expect(gatewayUnit).toContain('Environment=MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER=1');
    expect(unit).toContain('After=network-online.target matrix-restore.service');
    expect(unit).toContain('EnvironmentFile=/opt/matrix/env/host.env');
    expect(unit).toContain('ExecStart=/opt/matrix/bin/matrix-install-developer-tools --tools-only');
    expect(unit).toContain('Restart=on-failure');
    expect(installer).toContain('is_tool_installed()');
    expect(installer).toContain('grep -qxF "$tool" "$INSTALLED_FILE" && [ -x "/opt/matrix/runtime/node/bin/${bin_name}" ]');
    expect(installer).toContain('optional developer tool ${tool} already installed; skipping');
    expect(installer).toContain('TOOLS="${MATRIX_DEVELOPER_TOOLS-codex claude-code opencode pi}"');
    expect(installer).not.toContain('TOOLS="${MATRIX_DEVELOPER_TOOLS:-codex claude-code opencode pi}"');
    expect(installer).toContain('ensure_agent_sandbox_runtime()');
    expect(installer).toContain('apt-get install -y software-properties-common');
    expect(installer).toContain('add-apt-repository -y universe');
    expect(installer).toContain('apt-get install -y bubblewrap socat');
    expect(installer).toContain("cat >/etc/apparmor.d/bwrap <<'EOF'");
    expect(installer).toContain('systemctl reload apparmor');
    expect(installer).toContain('ensure_agent_sandbox_runtime');
    expect(installer.match(/\|\| return 1/g)?.length).toBeGreaterThanOrEqual(7);
    expect(installer).toContain('command -v bwrap >/dev/null 2>&1 && command -v socat >/dev/null 2>&1');
    expect(installer).toContain('if ! ensure_agent_sandbox_runtime; then');
    expect(installer).toContain('coding-agent sandbox provisioning failed');
    expect(installer).toContain('MODE="${1:-}"');
    expect(installer).toContain('if [ "$MODE" != "--tools-only" ]; then');
    expect(installer).toContain('if [ "$MODE" = "--sandbox-only" ]; then');
    expect(gatewayUnit).toContain('ExecStartPre=+/opt/matrix/bin/matrix-install-developer-tools --sandbox-only');
    expect(gatewayUnit).toContain('TimeoutStartSec=720');
    expect(codeServerUnit).toContain('Description=Install Matrix OS code-server runtime');
    expect(codeServerUnit).toContain('ConditionPathExists=!/opt/matrix/runtime/code-server/bin/code-server');
    expect(codeServerUnit).toContain('ExecStart=/opt/matrix/bin/matrix-install-tool-pack code-server');
    expect(codeServerUnit).not.toContain('ExecStartPost=-/bin/systemctl start matrix-code.service');
    expect(codeUnit).toContain('Description=Matrix OS customer code editor');
    expect(codeUnit).toContain('After=matrix-restore.service');
    expect(codeUnit).not.toContain('After=matrix-restore.service matrix-code-server.service');
    expect(codeUnit).not.toContain('Wants=matrix-code-server.service');
    expect(codeUnit).toContain('ExecStart=/opt/matrix/bin/matrix-code');
    expect(codeUnit).toContain('TimeoutStartSec=1800');
    expect(codeUnit).toContain('ConditionPathExists=/opt/matrix/bin/matrix-code');
    expect(codeUnit).not.toContain('ConditionPathExists=/opt/matrix/runtime/code-server/bin/code-server');
  });

  it('owner env canonicalizes Hermes home and migrates legacy Hermes data', () => {
    const root = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'matrix-owner-env-'));
    const matrixHome = join(tempDir, 'home');
    const legacyHome = join(tempDir, 'legacy');
    const legacyJobDir = join(legacyHome, '.hermes', 'jobs');

    try {
      mkdirSync(legacyJobDir, { recursive: true });
      writeFileSync(join(legacyJobDir, 'watcher.json'), '{"status":"paused"}\n');

      const result = spawnSync('bash', ['-c', `
set -euo pipefail
source "$OWNER_ENV"
matrix_export_owner_env
matrix_reconcile_owner_home "$(id -un)" "$(id -gn)"
printf 'HOME=%s\\nHERMES_HOME=%s\\n' "$HOME" "$HERMES_HOME"
test -f "$MATRIX_HOME/.hermes/jobs/watcher.json"
test -L "$MATRIX_LEGACY_HOME/.hermes"
test "$(readlink "$MATRIX_LEGACY_HOME/.hermes")" = "$MATRIX_HOME/.hermes"
`], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          OWNER_ENV: join(root, 'distro/customer-vps/host-bin/matrix-owner-env'),
          MATRIX_HOME: matrixHome,
          MATRIX_LEGACY_HOME: legacyHome,
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain(`HOME=${matrixHome}`);
      expect(result.stdout).toContain(`HERMES_HOME=${matrixHome}/.hermes`);
      expect(existsSync(join(matrixHome, '.hermes', 'jobs', 'watcher.json'))).toBe(true);
      expect(lstatSync(join(legacyHome, '.hermes')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bundled home sync preserves customized default app files', () => {
    const root = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'matrix-bundled-home-sync-'));
    const appDir = join(tempDir, 'app');
    const homeDir = join(tempDir, 'home');
    const bundledNotes = join(appDir, 'home', 'apps', 'notes', 'src');
    const homeNotes = join(homeDir, 'apps', 'notes', 'src');

    try {
      mkdirSync(bundledNotes, { recursive: true });
      mkdirSync(homeNotes, { recursive: true });

      writeFileSync(join(appDir, 'home', '.template-manifest.json'), JSON.stringify({
        'apps/notes/src/App.tsx': sha256('bundled v2'),
      }, null, 2));
      writeFileSync(join(homeDir, '.template-manifest.json'), JSON.stringify({
        'apps/notes/src/App.tsx': sha256('bundled v1'),
      }, null, 2));
      writeFileSync(join(appDir, 'home', 'apps', 'notes', 'src', 'App.tsx'), 'bundled v2');
      writeFileSync(join(homeDir, 'apps', 'notes', 'src', 'App.tsx'), 'custom user app');

      const result = spawnSync('bash', [join(root, 'distro/customer-vps/host-bin/matrix-sync-bundled-home-assets')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_DIR: appDir,
          MATRIX_HOME: homeDir,
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(join(homeDir, 'apps', 'notes', 'src', 'App.tsx'), 'utf8')).toBe('custom user app');
      expect(readFileSync(join(homeDir, 'system', 'logs', 'template-sync.log'), 'utf8')).toContain(
        'Skipped: apps/notes/src/App.tsx (customized by user)',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bundled home sync upgrades pre-manifest system-owned first-party app files', () => {
    const root = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'matrix-bundled-home-sync-system-app-'));
    const appDir = join(tempDir, 'app');
    const homeDir = join(tempDir, 'home');
    const bundledResourceManager = join(appDir, 'home', 'apps', 'resource-manager', 'src');
    const homeResourceManager = join(homeDir, 'apps', 'resource-manager', 'src');

    try {
      mkdirSync(bundledResourceManager, { recursive: true });
      mkdirSync(homeResourceManager, { recursive: true });
      mkdirSync(join(appDir, 'home', 'apps', 'resource-manager'), { recursive: true });
      mkdirSync(join(homeDir, 'apps', 'resource-manager'), { recursive: true });

      const bundledManifest = JSON.stringify({
        name: 'Resource Manager',
        slug: 'resource-manager',
        author: 'system',
        listingTrust: 'first_party',
      }, null, 2);
      const oldSystemManifest = JSON.stringify({
        name: 'Resource Manager',
        slug: 'resource-manager',
        author: 'system',
        listingTrust: 'first_party',
      }, null, 2);
      writeFileSync(join(appDir, 'home', '.template-manifest.json'), JSON.stringify({
        'apps/resource-manager/matrix.json': sha256(bundledManifest),
        'apps/resource-manager/src/App.tsx': sha256('new bridged app'),
      }, null, 2));
      writeFileSync(join(homeDir, '.template-manifest.json'), '{}');
      writeFileSync(join(appDir, 'home', 'apps', 'resource-manager', 'matrix.json'), bundledManifest);
      writeFileSync(join(appDir, 'home', 'apps', 'resource-manager', 'src', 'App.tsx'), 'new bridged app');
      writeFileSync(join(homeDir, 'apps', 'resource-manager', 'matrix.json'), oldSystemManifest);
      writeFileSync(join(homeDir, 'apps', 'resource-manager', 'src', 'App.tsx'), 'old mock app');

      const result = spawnSync('bash', [join(root, 'distro/customer-vps/host-bin/matrix-sync-bundled-home-assets')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_DIR: appDir,
          MATRIX_HOME: homeDir,
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(join(homeDir, 'apps', 'resource-manager', 'src', 'App.tsx'), 'utf8')).toBe('new bridged app');
      expect(JSON.parse(readFileSync(join(homeDir, '.template-manifest.json'), 'utf8'))).toMatchObject({
        'apps/resource-manager/matrix.json': sha256(bundledManifest),
        'apps/resource-manager/src/App.tsx': sha256('new bridged app'),
      });
      expect(readFileSync(join(homeDir, 'system', 'logs', 'template-sync.log'), 'utf8')).toContain(
        'Updated: apps/resource-manager/src/App.tsx',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bundled home sync caches first-party app ownership by slug', () => {
    const script = readFileSync(
      join(process.cwd(), 'distro/customer-vps/host-bin/matrix-sync-bundled-home-assets'),
      'utf8',
    );

    expect(script).toContain('systemOwnedFirstPartyAppCache');
    expect(script).toContain('systemOwnedFirstPartyAppCache.has(slug)');
    expect(script).toContain('systemOwnedFirstPartyAppCache.set(slug');
  });

  it('bundled home sync recovers from a corrupt installed manifest', () => {
    const root = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'matrix-bundled-home-sync-corrupt-'));
    const appDir = join(tempDir, 'app');
    const homeDir = join(tempDir, 'home');
    const bundledNotes = join(appDir, 'home', 'apps', 'notes', 'src');
    const homeNotes = join(homeDir, 'apps', 'notes', 'src');

    try {
      mkdirSync(bundledNotes, { recursive: true });
      mkdirSync(homeNotes, { recursive: true });

      writeFileSync(join(appDir, 'home', '.template-manifest.json'), JSON.stringify({
        'apps/notes/src/App.tsx': sha256('bundled v2'),
      }, null, 2));
      writeFileSync(join(homeDir, '.template-manifest.json'), '{"apps/notes/src/App.tsx":');
      writeFileSync(join(appDir, 'home', 'apps', 'notes', 'src', 'App.tsx'), 'bundled v2');
      writeFileSync(join(homeDir, 'apps', 'notes', 'src', 'App.tsx'), 'bundled v2');

      const result = spawnSync('bash', [join(root, 'distro/customer-vps/host-bin/matrix-sync-bundled-home-assets')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_DIR: appDir,
          MATRIX_HOME: homeDir,
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(readFileSync(join(homeDir, '.template-manifest.json'), 'utf8'))).toEqual({
        'apps/notes/src/App.tsx': sha256('bundled v2'),
      });
      expect(readFileSync(join(homeDir, 'system', 'logs', 'template-sync.log'), 'utf8')).toContain(
        'Ignoring invalid installed manifest',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bundled home sync rotates its log before appending past the size cap', () => {
    const root = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'matrix-bundled-home-sync-log-'));
    const appDir = join(tempDir, 'app');
    const homeDir = join(tempDir, 'home');
    const logDir = join(homeDir, 'system', 'logs');
    const logPath = join(logDir, 'template-sync.log');

    try {
      mkdirSync(join(appDir, 'home'), { recursive: true });
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(appDir, 'home', '.template-manifest.json'), '{}');
      writeFileSync(logPath, 'x'.repeat(240));

      const result = spawnSync('bash', [join(root, 'distro/customer-vps/host-bin/matrix-sync-bundled-home-assets')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_DIR: appDir,
          MATRIX_HOME: homeDir,
          TEMPLATE_SYNC_LOG_MAX_BYTES: '128',
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('x'.repeat(240));
      expect(readFileSync(logPath, 'utf8')).toContain('Template sync completed');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bundled home sync treats log write failures as best effort', () => {
    const root = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'matrix-bundled-home-sync-log-fail-'));
    const appDir = join(tempDir, 'app');
    const homeDir = join(tempDir, 'home');
    const logDir = join(homeDir, 'system', 'logs');
    const logPath = join(logDir, 'template-sync.log');

    try {
      mkdirSync(join(appDir, 'home'), { recursive: true });
      mkdirSync(logPath, { recursive: true });
      writeFileSync(join(appDir, 'home', '.template-manifest.json'), JSON.stringify({
        'apps/notes/src/App.tsx': sha256('bundled v1'),
      }, null, 2));
      mkdirSync(join(appDir, 'home', 'apps', 'notes', 'src'), { recursive: true });
      writeFileSync(join(appDir, 'home', 'apps', 'notes', 'src', 'App.tsx'), 'bundled v1');

      const result = spawnSync('bash', [join(root, 'distro/customer-vps/host-bin/matrix-sync-bundled-home-assets')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_DIR: appDir,
          MATRIX_HOME: homeDir,
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toContain('unable to write template sync log');
      expect(JSON.parse(readFileSync(join(homeDir, '.template-manifest.json'), 'utf8'))).toEqual({
        'apps/notes/src/App.tsx': sha256('bundled v1'),
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('host bundle manifest keeps the sync-agent compatibility fields', () => {
    const root = process.cwd();
    const releaseScript = readFileSync(join(root, 'scripts/host-bundle-release.mjs'), 'utf8');

    expect(releaseScript).toContain('sha256: checksum');
    expect(releaseScript).toContain('size: bundleStat.size');
    expect(releaseScript).toContain('severity');
    expect(releaseScript).toContain('updateType');
    expect(releaseScript).toContain('bundleSha256: checksum');
    expect(releaseScript).toContain('incrementalManifest');
    expect(releaseScript).toContain('system-bundles/${release.version}/incremental-manifest.json');
  });

  it('publish script keeps platform secrets out of curl arguments', () => {
    const root = process.cwd();
    const publishScript = readFileSync(join(root, 'scripts/publish-release.sh'), 'utf8');

    expect(publishScript).toContain('AUTH_HEADER_FILE="$(mktemp)"');
    expect(publishScript).toContain('printf \'Authorization: Bearer %s\\n\' "$PLATFORM_SECRET" > "$AUTH_HEADER_FILE"');
    expect(publishScript).toContain('-H "@$AUTH_HEADER_FILE"');
    expect(publishScript).not.toContain('-H "Authorization: Bearer ${PLATFORM_SECRET}"');
  });

  it('publish script writes immutable R2 objects without overwriting existing keys', () => {
    const root = process.cwd();
    const publishScript = readFileSync(join(root, 'scripts/publish-release.sh'), 'utf8');

    expect(publishScript).toContain('upload_immutable_object()');
    expect(publishScript).toContain('object_exists()');
    expect(publishScript).toContain('verify_existing_bundle()');
    expect(publishScript).toContain('verify_existing_checksum()');
    expect(publishScript).toContain('verify_existing_incremental_manifest()');
    expect(publishScript).toContain('write_incremental_object_list()');
    expect(publishScript).toContain('HOST_BUNDLE_INCREMENTAL_UPLOAD_CONCURRENCY');
    expect(publishScript).toContain('upload_content_addressed_object()');
    expect(publishScript).toContain('incremental_requires_full_bundle()');
    expect(publishScript).toContain('Incremental manifest requires full bundle; skipping incremental file object uploads.');
    expect(publishScript).toContain('if incremental_requires_full_bundle; then');
    expect(publishScript).toContain('if ! incremental_requires_full_bundle; then');
    expect(publishScript).toContain('PreconditionFailed');
    expect(publishScript).toContain('incremental_upload_pids=()');
    expect(publishScript).toContain('incremental_upload_pids+=("$!")');
    expect(publishScript).toContain('while [ "${#incremental_upload_pids[@]}" -ge "$INCREMENTAL_UPLOAD_CONCURRENCY" ]; do');
    expect(publishScript).toContain('wait "$first_pid" || return');
    expect(publishScript).toContain('for upload_pid in "${incremental_upload_pids[@]}"; do');
    expect(publishScript).not.toContain('jobs -pr');
    expect(publishScript).not.toContain('wait -n');
    expect(publishScript).toContain('object_size "$BUNDLE_KEY"');
    expect(publishScript).toContain('bundle_object_sha256 "$BUNDLE_KEY"');
    expect(publishScript).toContain('checksum_object_sha256 "$CHECKSUM_KEY"');
    expect(publishScript).not.toContain('existing immutable bundle is missing checksum object');
    expect(publishScript).toContain('aws s3api put-object');
    expect(publishScript).toContain('--if-none-match');
    expect(publishScript).toContain('local metadata_sha256="${4:-$SHA256}"');
    expect(publishScript).toContain('--metadata "sha256=$metadata_sha256"');
    expect(publishScript).toContain('upload_immutable_object "$BUNDLE" "$BUNDLE_KEY" "application/gzip"');
    expect(publishScript).toContain('upload_immutable_object "$CHECKSUM_FILE" "$CHECKSUM_KEY" "text/plain; charset=utf-8"');
    expect(publishScript).toContain('upload_content_addressed_object "$object_file" "$object_key" "application/octet-stream" "$object_sha256"');
    expect(publishScript).not.toContain('verify_existing_content_object()');
    expect(publishScript).not.toContain('verify_existing_content_object "$object_key" "$object_size" "$object_sha256"');
    expect(publishScript).toContain('validate_incremental_object_list()');
    expect(publishScript).toContain('validate_incremental_object_list');
    expect(publishScript).toContain('(^|[^0-9])412([^0-9]|$)');
    expect(publishScript).toContain('upload_immutable_object "$INCREMENTAL_MANIFEST" "$INCREMENTAL_MANIFEST_KEY" "application/json; charset=utf-8" "$INCREMENTAL_MANIFEST_SHA256"');
    expect(publishScript).toContain(': "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID or R2_ENDPOINT}"');
    expect(publishScript).toContain('if [ -z "${R2_ENDPOINT:-}" ]; then');
    expect(publishScript).not.toContain('aws s3 cp "$BUNDLE" "s3://$R2_BUCKET/$BUNDLE_KEY"');
  });

  it('publish script falls back to the checked-in Node R2 publisher when aws is unavailable', () => {
    const root = process.cwd();
    const publishScript = readFileSync(join(root, 'scripts/publish-release.sh'), 'utf8');
    const nodePublisher = readFileSync(join(root, 'scripts/publish-release-r2.mjs'), 'utf8');

    expect(publishScript).toContain('command -v aws');
    expect(publishScript).toContain('scripts/publish-release-r2.mjs');
    expect(publishScript).toContain('exec node "$ROOT_DIR/scripts/publish-release-r2.mjs"');
    expect(nodePublisher).toContain('IfNoneMatch: "*"');
    expect(nodePublisher).toContain('existing immutable bundle has no checksum metadata');
    expect(nodePublisher).toContain('incrementalManifestKey');
    expect(nodePublisher).toContain('incremental-manifest.json');
    expect(nodePublisher).toContain('incrementalObjectEntries');
    expect(nodePublisher).toContain('incrementalRequiresFullBundle');
    expect(nodePublisher).toContain('validateIncrementalObjects');
    expect(nodePublisher).toContain('await validateIncrementalObjects(incrementalObjects);');
    expect(nodePublisher).toContain('Incremental manifest requires full bundle; skipping incremental file object uploads.');
    expect(nodePublisher).toContain('system-bundles/objects/sha256/${file.sha256}');
    expect(nodePublisher).toContain('Uploading ${incrementalObjects.length} incremental file objects');
    expect(nodePublisher).toContain('"application/octet-stream"');
    expect(nodePublisher).not.toContain('head.Metadata?.sha256 && head.Metadata.sha256 !== expectedSha256');
    expect(nodePublisher).toContain('R2_ACCESS_KEY_ID');
    expect(nodePublisher).toContain('R2_SECRET_ACCESS_KEY');
    expect(nodePublisher).toContain('AbortSignal.timeout(30_000)');
    expect(nodePublisher).toContain('const accountId = process.env.R2_ACCOUNT_ID;');
    expect(nodePublisher).toContain('process.env.R2_ENDPOINT ||');
    expect(nodePublisher).toContain('(accountId ? `https://${accountId}.r2.cloudflarestorage.com` : required("R2_ACCOUNT_ID"))');
  });

  it('host bundle release workflow stamps the resolved channel into release metadata before packaging', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain('channel: ${{ steps.channel.outputs.channel }}');
    expect(workflow).toContain('id: channel');
    expect(workflow).toContain('HOST_BUNDLE_CHANNEL: ${{ steps.channel.outputs.channel }}');
    expect(workflow).toContain('HOST_BUNDLE_CHANNEL: ${{ needs.build.outputs.channel }}');
    expect(workflow).toContain("PLATFORM_PUBLIC_URL: ${{ vars.PLATFORM_PUBLIC_URL || 'https://app.matrix-os.com' }}");
    expect(workflow).toContain('R2_ACCOUNT_ID: ${{ secrets.R2_BUNDLES_ACCOUNT_ID || secrets.R2_ACCOUNT_ID }}');
    expect(workflow).toContain('timeout-minutes: 20');
    expect(workflow).toContain('AWS_ACCESS_KEY_ID: ${{ secrets.R2_BUNDLES_ACCESS_KEY_ID || secrets.R2_ACCESS_KEY_ID }}');
    expect(workflow).toContain('AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_BUNDLES_SECRET_ACCESS_KEY || secrets.R2_SECRET_ACCESS_KEY }}');
    expect(workflow).toContain("R2_BUCKET: ${{ vars.R2_BUNDLES_BUCKET || vars.R2_BUCKET || 'matrixos-sync' }}");
    expect(workflow).toContain("R2_ENDPOINT: ${{ vars.R2_BUNDLES_ENDPOINT || vars.R2_ENDPOINT || format('https://{0}.r2.cloudflarestorage.com', secrets.R2_BUNDLES_ACCOUNT_ID || secrets.R2_ACCOUNT_ID) }}");
    expect(workflow).toContain('-X POST "${PLATFORM_PUBLIC_URL%/}/vps/deploy"');
    expect(workflow).not.toContain('HOST_BUNDLE_CHANNEL: ${{ steps.meta.outputs.channel }}');
    expect(workflow).not.toContain('-X POST "https://app.matrix-os.com/vps/deploy"');
  });

  it('preview VPS workflow publishes deployable host bundle artifacts', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');

    expect(workflow).toContain('VERSION="${REQUESTED_VERSION:-v$(date -u +%Y.%m.%d)-pr${PR_NUMBER}-${HEAD_SHA:0:7}}"');
    expect(workflow).toContain('dist/host-bundle/incremental-manifest.json');
    expect(workflow).toContain('dist/host-bundle/objects/**');
    expect(workflow).toContain('./scripts/publish-release.sh "$VERSION" --channel none');
    expect(workflow).toContain('-X POST "${PLATFORM_PUBLIC_URL}/vps/deploy"');
  });

  it('preview VPS workflow uses the durable preview provision contract', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');

    expect(workflow).toContain('-X POST "${PLATFORM_PUBLIC_URL}/vps/preview/provision"');
    expect(workflow).toContain('{clerkUserId: $owner, handle: $handle, runtimeSlot: $handle}');
    expect(workflow).not.toContain('-X POST "${PLATFORM_PUBLIC_URL}/vps/provision"');
    expect(workflow).not.toContain('"runtimeSlot":"preview"');
  });

  it('preview VPS workflow accepts only a valid 202 provision response', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');

    expect(workflow).toContain('if [ "$code" != "202" ]; then');
    expect(workflow).toContain('accepted_machine_id="$(jq -er');
    expect(workflow).toContain('.status == "provisioning" or .status == "running"');
    expect(workflow).toContain('.etaSeconds | type == "number" and . >= 0');
  });

  it('preview VPS workflow requires immediate fleet visibility after acceptance', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');

    expect(workflow).toContain('Immediate fleet visibility for ${HANDLE}: ${status}');
    expect(workflow).toContain('select(.handle == $h and .machineId == $id and .runtimeSlot == $h)');
    expect(workflow).toContain('if [ "$status" != "provisioning" ] && [ "$status" != "running" ]; then');
    expect(workflow.indexOf('Immediate fleet visibility for ${HANDLE}: ${status}'))
      .toBeLessThan(workflow.indexOf('deadline=$((SECONDS + 600))'));
  });

  it('preview VPS workflow safely resumes an existing active preview', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');

    expect(workflow).toContain('provisioning|running)');
    expect(workflow).toContain('if [ "$runtime_slot" = "$HANDLE" ]; then');
    expect(workflow).toContain('Reusing existing ${HANDLE} machine ${accepted_machine_id} (${status})');
    expect(workflow).toContain('requires exact-slot adoption from ${runtime_slot:-unset}');
    expect(workflow).toContain('needs_provision=true');
    expect(workflow).toContain('absent|failed)');
    expect(workflow.match(/\/vps\/preview\/provision/g)).toHaveLength(1);
  });

  it('preview VPS workflow prefers active same-handle rows over failed history', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');

    expect(workflow).toContain('if .status == "running" then 0');
    expect(workflow).toContain('elif .status == "provisioning" then 1');
    expect(workflow).toContain('elif .status == "failed" then 2');
    expect(workflow).toContain('sort_by(._preview_rank, (if .runtimeSlot == $h then 0 else 1 end), .provisionedAt)');
  });

  it('manual preview dispatch resolves the target PR head and validates a pinned version', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');

    expect(workflow).toContain('gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}"');
    expect(workflow).toContain('head_sha="$(jq -r .head.sha <<< "$pr_json")"');
    expect(workflow).toContain('head_repo="$(jq -r .head.repo.full_name <<< "$pr_json")"');
    expect(workflow).toContain('if [ "$head_repo" != "$GITHUB_REPOSITORY" ]; then');
    expect(workflow).toContain('ref: ${{ needs.gate.outputs.head_sha }}');
    expect(workflow).toContain('REQUESTED_VERSION: ${{ needs.gate.outputs.requested_version }}');
    expect(workflow).toContain('VERSION="${REQUESTED_VERSION:-v$(date -u +%Y.%m.%d)-pr${PR_NUMBER}-${HEAD_SHA:0:7}}"');
    expect(workflow).toContain('Invalid pinned preview version');
    expect(workflow).toContain('[ "${REQUESTED_VERSION##*-}" != "${head_sha:0:7}" ]');
  });

  it('manual preview verification uses a short-lived token from an active QA session', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');

    expect(workflow).toContain('verify_inventory:');
    expect(workflow).toContain('action="verify"');
    expect(workflow).toContain('https://api.clerk.com/v1/users/${PREVIEW_CLERK_USER_ID}');
    expect(workflow).toContain('Configured preview verification user is unavailable (HTTP ${user_code}).');
    expect(workflow).toContain('https://api.clerk.com/v1/sessions?user_id=${PREVIEW_CLERK_USER_ID}&status=active&limit=10');
    expect(workflow).toContain('https://api.clerk.com/v1/sessions/${session_id}/tokens');
    expect(workflow).toContain("--data-binary '{\"expires_in_seconds\":60}'");
    expect(workflow.match(/Clerk-API-Version: 2025-11-10/g)).toHaveLength(3);
    expect(workflow).toContain('"${PLATFORM_PUBLIC_URL}/api/auth/computers"');
    expect(workflow).toContain('select(.handle == $h and .runtimeSlot == $h and .kind == "preview")');
    expect(workflow).not.toContain('echo "$session_token"');
    expect(workflow).not.toContain('/sessions/${session_id}/revoke');
  });

  it('pinned preview redeploys skip bundle build and immutable publication', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8');

    expect(workflow).toContain('action="deploy_existing"');
    expect(workflow).toContain("if: needs.gate.outputs.action == 'deploy'");
    expect(workflow).toContain("if: always() && ((needs.gate.outputs.action == 'deploy' && needs.build.result == 'success') || needs.gate.outputs.action == 'deploy_existing')");
    expect(workflow).toContain("if: needs.gate.outputs.action == 'deploy'");
    expect(workflow).toContain("VERSION: ${{ needs.gate.outputs.action == 'deploy_existing' && needs.gate.outputs.requested_version || needs.build.outputs.version }}");
  });

  it('host bundle release workflow can skip dev bundles only through explicit manual input', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain('skip_dev_bundle:');
    expect(workflow).toContain('Dev bundle gate');
    expect(workflow).toContain('SKIP_DEV_BUNDLE_INPUT');
    expect(workflow).toContain('scripts/ci/dev-bundle-gate.sh');
    expect(workflow).toContain("needs.dev-bundle-gate.outputs.should_build == 'true'");
    expect(workflow).toContain('Validate public build environment');
    expect(workflow).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}');
    expect(workflow).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required for host bundle releases.');
    expect(workflow).toContain('pk_test_Y2xlcmsuZXhhbXBsZS5jb20k');
    expect(workflow).toContain('Refusing to publish a host bundle with the example Clerk publishable key.');
    expect(workflow).not.toContain('HEAD_COMMIT_MESSAGE');
    expect(workflow).not.toContain('CHANGED_FILES="$changed_files"');
    expect(workflow).not.toContain('continue-on-error: true');
  });

  it('host bundle release workflow waits for same-sha CI instead of duplicating the full suite', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('name: Same-SHA CI gate');
    expect(workflow).toContain('TARGET_SHA: ${{ github.sha }}');
    expect(workflow).toContain('CI_WORKFLOW_FILE: ci.yml');
    expect(workflow).toContain('--workflow "$CI_WORKFLOW_FILE"');
    expect(workflow).toContain('--commit "$TARGET_SHA"');
    expect(workflow).toContain('Could not read CI workflow status for $TARGET_SHA; retrying...');
    expect(workflow).toContain('gh run view "$success_id"');
    expect(workflow).toContain('Could not read CI jobs for $TARGET_SHA; retrying...');
    expect(workflow).toContain('Timed out verifying CI jobs for $TARGET_SHA after repeated GitHub API failures');
    expect(workflow).toContain('CI workflow run passed but a job was not successful for $TARGET_SHA');
    expect(workflow).toContain('CI passed for $TARGET_SHA');
    expect(workflow).toContain('All same-SHA CI runs are completed but none succeeded for $TARGET_SHA');
    expect(workflow).toContain('Timed out waiting for CI to pass on $TARGET_SHA');
    expect(workflow).toContain('after repeated GitHub API failures');
    expect(workflow).toContain('needs: [dev-bundle-gate, ci-gate]');
    expect(workflow).not.toContain('run: bun run typecheck');
    expect(workflow).not.toContain('run: bun run test');
  });

  it('host bundle release workflow keeps tag pushes triggerable', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain('tags:');
    expect(workflow).toContain('- "v*"');
    expect(workflow).not.toContain('paths-ignore:');
  });

  it('host bundle release workflow uploads only publishable bundle artifacts', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain('name: Upload bundle artifact');
    expect(workflow).toContain('dist/host-bundle/matrix-host-bundle.tar.gz');
    expect(workflow).toContain('dist/host-bundle/matrix-host-bundle.tar.gz.sha256');
    expect(workflow).toContain('dist/host-bundle/incremental-manifest.json');
    expect(workflow).toContain('dist/host-bundle/objects/**');
    expect(workflow).toContain('dist/host-bundle/manifest.json');
    expect(workflow).toContain('dist/host-bundle/release.json');
    expect(workflow).not.toContain('path: dist/host-bundle/');
    expect(workflow).not.toContain('dist/host-bundle/stage');
  });

  it('host bundle release workflow normalizes downloaded artifact layout before publishing', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain('path: dist/host-bundle-artifact');
    expect(workflow).toContain('name: Normalize downloaded bundle artifact');
    expect(workflow).toContain('BUNDLE_FILE="$(find "$ARTIFACT_DIR" -type f -name matrix-host-bundle.tar.gz -print -quit)"');
    expect(workflow).toContain('TARGET_DIR="dist/host-bundle"');
    expect(workflow).toContain('for file in matrix-host-bundle.tar.gz matrix-host-bundle.tar.gz.sha256 incremental-manifest.json manifest.json release.json; do');
    expect(workflow).toContain('cp "$SOURCE_DIR/$file" "$TARGET_DIR/$file"');
    expect(workflow).toContain('cp -a "$SOURCE_DIR/objects" "$TARGET_DIR/objects"');
  });

  it('host bundle release workflow cancels only superseded dev-channel builds', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain("group: host-bundle-release-${{ github.event_name == 'workflow_dispatch' && inputs.channel || github.ref_type == 'tag' && github.ref_name || 'dev' }}");
    expect(workflow).toContain("cancel-in-progress: ${{ github.ref_type != 'tag' && (github.event_name != 'workflow_dispatch' || inputs.channel == 'dev' || inputs.channel == '') }}");
    expect(workflow).not.toContain('cancel-in-progress: false');
  });

  it('host bundle release workflow generates friendly stable changelogs from commit subjects', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('node scripts/release-changelog.mjs --base "$BASE_SHA" --head "$GITHUB_SHA"');
    expect(workflow).toContain('DELIMITER="CHANGELOG_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}_${GITHUB_SHA}"');
    expect(workflow).toContain('changelog<<$DELIMITER');
    expect(workflow).not.toContain('changelog<<EOF');
  });

  it('dev bundle gate builds branch pushes even when commit messages request a skip', () => {
    const result = runDevBundleGate({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_TYPE: 'branch',
      HEAD_COMMIT_MESSAGE: 'feat: update docs [skip dev-bundle]',
      SKIP_DEV_BUNDLE_INPUT: 'false',
      CHANGED_FILES: 'packages/kernel/src/index.ts',
    });

    expect(result.output).toContain('should_build=true');
    expect(result.output).toContain('reason=host bundle build required');
  });

  it('dev bundle gate builds main branch pushes even for metadata-only changes', () => {
    const result = runDevBundleGate({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_TYPE: 'branch',
      HEAD_COMMIT_MESSAGE: 'docs: update landing page',
      SKIP_DEV_BUNDLE_INPUT: 'false',
      CHANGED_FILES: ['www/content/docs/index.mdx', 'docs/dev/releases.md', 'README.md', 'AGENTS.md'].join('\n'),
    });

    expect(result.output).toContain('should_build=true');
    expect(result.output).toContain('reason=host bundle build required');
  });

  it('dev bundle gate only skips when workflow dispatch explicitly requests it', () => {
    const result = runDevBundleGate({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_TYPE: 'branch',
      HEAD_COMMIT_MESSAGE: 'docs: update workflow notes',
      SKIP_DEV_BUNDLE_INPUT: 'true',
      CHANGED_FILES: 'packages/gateway/src/index.ts',
    });

    expect(result.output).toContain('should_build=false');
    expect(result.output).toContain('reason=skip_dev_bundle workflow input was true');
  });

  it('dev bundle gate builds tag releases even for metadata-only tag targets', () => {
    const result = runDevBundleGate({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_TYPE: 'tag',
      HEAD_COMMIT_MESSAGE: 'docs: release notes [skip dev-bundle]',
      SKIP_DEV_BUNDLE_INPUT: 'false',
      CHANGED_FILES: 'README.md',
    });

    expect(result.output).toContain('should_build=true');
    expect(result.output).toContain('reason=tag releases always build by default');
  });

  it('dev bundle gate builds branch pushes with host-bundle-relevant changes', () => {
    const result = runDevBundleGate({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_TYPE: 'branch',
      HEAD_COMMIT_MESSAGE: 'feat: update gateway',
      SKIP_DEV_BUNDLE_INPUT: 'false',
      CHANGED_FILES: ['docs/dev/releases.md', 'packages/gateway/src/index.ts'].join('\n'),
    });

    expect(result.output).toContain('should_build=true');
    expect(result.output).toContain('reason=host bundle build required');
  });

  it('update launcher triggers the sync agent update and rollback paths', () => {
    const root = process.cwd();
    const updater = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-update'), 'utf8');

    expect(updater).toContain('/opt/matrix/app/.update-available.json');
    expect(updater).toContain('/opt/matrix/app/.update-channel');
    expect(updater).toContain('/opt/matrix/app/.update-version');
    expect(updater).toContain('touch /opt/matrix/app/.update-now');
    expect(updater).toContain('touch /opt/matrix/app/.rollback-now');
    expect(updater).toContain('touch /opt/matrix/app/.update-repair-now');
    expect(updater).toContain('repair)');
    expect(updater).toContain('matrix-update --no-tail repair');
    expect(updater).toContain('if [ "$tail_logs" -eq 0 ]; then');
    expect(updater).toContain('stable|canary|beta|dev|v[0-9]*|main-[A-Za-z0-9]*');
    expect(updater).toContain('journalctl -u matrix-sync-agent -f --no-pager -n 20');
    expect(updater).toContain('Usage: matrix-update [--no-tail] [apply|rollback|repair|stable|canary|beta|dev|v<version>|main-<build>]');
  });

  it('sync agent installs bundled messaging systemd units during updates', () => {
    const root = process.cwd();
    const syncAgent = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-sync-agent'), 'utf8');

    expect(syncAgent).toContain('write_symphony_env()');
    expect(syncAgent).toContain('/opt/matrix/env/symphony.env');
    expect(syncAgent).toContain('sudo install -o root -g matrix -m 0640 "$temp_file" "$SYMPHONY_ENV_FILE" || status=$?');
    expect(syncAgent).toContain('rm -f "$temp_file"');
    expect(syncAgent).toContain("sudo find \"$extract_dir/systemd\" -maxdepth 1 -name 'matrix-*.service'");
    expect(syncAgent).toContain('sudo systemctl daemon-reload');
    expect(syncAgent).toContain('sudo systemctl enable matrix-code-server.service');
    expect(syncAgent).toContain('sudo systemctl start --no-block matrix-code-server.service || true');
    expect(syncAgent).toContain('sudo systemctl enable matrix-developer-tools.service');
    expect(syncAgent).toContain('sudo systemctl start --no-block matrix-developer-tools.service || true');
    expect(syncAgent).toContain('Code-server runtime service enabled');
    expect(syncAgent).toContain('sudo systemctl enable matrix-code.service');
    expect(syncAgent).toContain('sudo systemctl start --no-block matrix-code.service || true');
    expect(syncAgent).toContain('Code editor service enabled');
    expect(syncAgent).toContain('Messaging runtimes missing; units installed but not enabled');
    expect(syncAgent).toContain('sudo systemctl enable matrix-homeserver.service matrix-bridge-telegram.service matrix-bridge-whatsapp.service');
    const daemonReload = syncAgent.indexOf('sudo systemctl daemon-reload');
    const gatewayStart = syncAgent.indexOf('sudo systemctl start matrix-gateway matrix-shell', daemonReload);
    expect(daemonReload).toBeGreaterThan(-1);
    expect(gatewayStart).toBeGreaterThan(daemonReload);
  });

  it('sync agent periodically cleans stale local bundle artifacts', () => {
    const root = process.cwd();
    const syncAgent = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-sync-agent'), 'utf8');

    expect(syncAgent).toContain('readonly STAGING_ARTIFACT_TTL_SECONDS="${MATRIX_STAGING_ARTIFACT_TTL_SECONDS:-86400}"');
    expect(syncAgent).toContain('readonly STAGING_CLEANUP_INTERVAL_SECONDS="${MATRIX_STAGING_CLEANUP_INTERVAL_SECONDS:-3600}"');
    expect(syncAgent).toContain("find \"$STAGING_DIR\" -mindepth 1 -maxdepth 1 \\( -name 'failed-*' -o -name 'bundle-*' \\) -print0");
    expect(syncAgent).toContain('maybe_clean_staging');
    expect(syncAgent).toContain('clean_staging || true');
    expect(syncAgent).toContain('last_staging_cleanup="$(date +%s)"');
  });

  it('sync agent reports low disk update failures and supports safe repair cleanup', () => {
    const root = process.cwd();
    const syncAgent = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-sync-agent'), 'utf8');

    expect(syncAgent).toContain('readonly UPDATE_ERROR_MARKER="$APP_DIR/.update-error.json"');
    expect(syncAgent).toContain('readonly UPDATE_REPAIR_TRIGGER="$APP_DIR/.update-repair-now"');
    expect(syncAgent).toContain('readonly UPDATE_FREE_BUFFER_KB="${MATRIX_UPDATE_FREE_BUFFER_KB:-1048576}"');
    expect(syncAgent).toContain('readonly UPDATE_EXPANSION_FACTOR="${MATRIX_UPDATE_EXPANSION_FACTOR:-8}"');
    expect(syncAgent).toContain('write_update_error()');
    expect(syncAgent).toContain('write_update_error "insufficient_disk_space"');
    expect(syncAgent).toContain('ERROR: insufficient disk space for update');
    expect(syncAgent).toContain('perform_update_repair()');
    expect(syncAgent).toContain('df -Pk /tmp');
    expect(syncAgent).toContain('WARN: /tmp and update staging are on different filesystems');
    expect(syncAgent).toContain("find /tmp -xdev -user matrix -type f -mtime +1 \\( -name '*.so' -o -path '/tmp/node-compile-cache/*' \\)");
    expect(syncAgent).toContain('sudo rm -f "$UPDATE_REPAIR_TRIGGER"');
    expect(syncAgent).toContain('Repair complete; retrying pending update');
  });

  it('sync agent replaces the app tree with root permissions', () => {
    const root = process.cwd();
    const syncAgent = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-sync-agent'), 'utf8');

    expect(syncAgent).toContain('sudo rm -rf "$APP_DIR.rollback"');
    expect(syncAgent).toContain('sudo mv "$APP_DIR" "$APP_DIR.rollback"');
    expect(syncAgent).toContain('sudo mv "$extract_dir/app" "$APP_DIR"');
    expect(syncAgent).toContain('sudo chown -R matrix:matrix "$APP_DIR"');
    expect(syncAgent).toContain('echo "$version" | sudo tee "$VERSION_FILE" >/dev/null');
    expect(syncAgent).toContain('sudo rm -f "$UPDATE_TRIGGER"');
    expect(syncAgent).toContain('prepare_triggered_update');
    expect(syncAgent).toContain('restart_sync_agent_after_update');
    expect(syncAgent).toContain('sudo systemctl restart --no-block matrix-sync-agent.service');
    expect(syncAgent).toContain('release_url_for_version');
    expect(syncAgent).toContain('release_url_for_channel');
    expect(syncAgent).toContain('default_update_channel');
    expect(syncAgent).toContain('channel="$(default_update_channel)"');
    expect(syncAgent).toContain('marker_channel="$(json_field "$manifest" channel)"');
    expect(syncAgent).toContain('prepared release metadata missing');
    expect(syncAgent).toContain('url="$(manifest_url)"');
    expect(syncAgent).toContain('No update available on ${target} — nothing to apply');
    expect(syncAgent).toContain('Requested release metadata fetch failed — skipping apply');
    expect(syncAgent).toContain('readonly RELEASE_FILE="/opt/matrix/release.json"');
    expect(syncAgent).toContain('sudo install -o root -g matrix -m 0644 "$extract_dir/release.json" "$RELEASE_FILE"');
    expect(syncAgent).toContain('rm -f "$UPDATE_MARKER"');
    expect(syncAgent).toContain('Update failed — will retry on next trigger');
    expect(syncAgent).toContain('Update (via SIGUSR1) failed — will retry on next trigger');
    expect(syncAgent).toContain('PLATFORM_INTERNAL_URL:-https://app.matrix-os.com');
    expect(syncAgent).toContain('sudo rm -f "$ROLLBACK_TRIGGER"');
    expect(syncAgent).toContain('return 0');
    expect(syncAgent).toContain('for _ in $(seq 1 18); do');
    expect(syncAgent).toContain('sudo mv "$APP_DIR" "$STAGING_DIR/failed-$(date +%s)"');
    expect(syncAgent).toContain('sudo mv "$APP_DIR.rollback" "$APP_DIR"');
  });

  it('gateway launcher performs the customer VPS registration callback', () => {
    const root = process.cwd();
    const launcher = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-gateway'), 'utf8');

    expect(launcher).toContain('MATRIX_PLATFORM_REGISTER_URL');
    expect(launcher).toContain('/hetzner/v1/metadata/instance-id');
    expect(launcher).toContain('/hetzner/v1/metadata/public-ipv4');
    expect(launcher).toContain('/vps/register');
    expect(launcher).toContain('curl --fail --silent --show-error --max-time 10');
    expect(launcher).toContain('MATRIX_REGISTRATION_TOKEN');
    expect(launcher).toContain('/opt/matrix/app/node_modules/.bin');
    expect(launcher).toContain('matrix_prepend_path_once "/opt/matrix/app/node_modules/.bin"');
    expect(launcher).toContain('export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"');
    expect(launcher).toContain('sync_bundled_home_assets');
    expect(launcher).toContain('sync-matrix-agent-skills.sh');
    expect(launcher).toContain('MATRIX_SKILL_TARGETS=matrix,claude,codex');
    expect(launcher).toContain('matrix-sync-bundled-home-assets');
    expect(launcher).toContain('MATRIX_SYNC_BUNDLED_HOME_ASSETS');
    expect(launcher).toMatch(
      /else\s+echo "matrix-gateway: bundled home sync script not executable: \$sync_script" >&2\s+return 1\s+fi/
    );
    expect(launcher).toContain('cd "$APP_DIR"');
    expect(launcher).not.toContain('cp -a "$bundled_home/." "$MATRIX_HOME"');
    expect(launcher).not.toContain('rm -rf "$dst_app/$path"');
    expect(launcher).not.toContain('desktop.json');
    expect(launcher).not.toContain('theme.json');
    expect(launcher).not.toContain('system/wallpapers');
  });

  it('restore script resolves matrixctl from the installed host bin directory', () => {
    const root = process.cwd();
    const restore = readFileSync(join(root, 'distro/customer-vps/matrix-restore.sh'), 'utf8');

    expect(restore).toContain('if /opt/matrix/bin/matrixctl r2 exists "$key"; then');
    expect(restore).toContain('check_r2_exists_or_skip_restore system/vps-meta.json "VPS metadata"');
    expect(restore).toContain('latest_pointer_key="system/db/latest"');
    expect(restore).toContain('/opt/matrix/bin/matrixctl r2 get "$latest_pointer_key" "$latest_file"');
  });

  it('platform Cloud Run workflow smokes signed host bundle URLs before promotion', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('curl --fail --silent --show-error --max-time 10 "$CANDIDATE_URL/health"');
    expect(workflow).toContain('$CANDIDATE_URL/system-bundles/channels/dev.json');
    expect(workflow).toContain("jq -r '.url // empty'");
    expect(workflow).toContain('sync_bucket="$(gcloud secrets versions access latest --secret=r2-bucket)"');
    expect(workflow).toContain('bundle_bucket="$(gcloud secrets versions access latest --secret=r2-bundles-bucket)"');
    expect(workflow).toContain('CUSTOMER_VPS_TLS_VERIFY=false');
    expect(workflow).toContain('MATRIX_BILLING_PROVIDER=stripe');
    expect(workflow).toContain('Dedicated host bundle bucket secret matches the sync bucket secret; refusing to promote.');
    expect(workflow).toContain('grep -Fq -- "$sync_bucket"');
    expect(workflow).toContain('Candidate host bundle signer returned the configured sync bucket; refusing to promote.');
    expect(workflow).toContain("grep -Fq 'r2.cloudflarestorage.com'");
    expect(workflow).toContain('Candidate host bundle signer returned a native R2 URL outside the bundle bucket; refusing to promote.');
    expect(workflow).toContain('curl --fail --silent --show-error --max-time 20 --range 0-0 "$bundle_url"');
  });
});
