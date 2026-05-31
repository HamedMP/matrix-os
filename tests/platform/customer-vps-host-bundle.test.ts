import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
    expect(script).toContain('scripts/sync-matrix-agent-skills.sh');
    expect(script).toContain('scripts/host-bundle-release.mjs" write-release');
    expect(script).toContain('scripts/host-bundle-release.mjs" write-manifest');
    expect(script).toContain('bin app runtime systemd release.json');
    expect(script).toContain('manifest.json');
    expect(script).toContain('release.json');
    expect(script).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:?set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY before building the customer host bundle');
    expect(script).toContain('CODE_SERVER_VERSION="${HOST_BUNDLE_CODE_SERVER_VERSION:-4.116.0}"');
    expect(script).toContain('CODE_SERVER_URL="https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${CODE_SERVER_ARCHIVE}"');
    expect(script).toContain('GH_VERSION="${HOST_BUNDLE_GH_VERSION:-2.86.0}"');
    expect(script).toContain('GH_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_ARCHIVE}"');
    expect(script).toContain('install -m 0755 "$DIST_DIR/$GH_DIST/bin/gh" "$STAGE_DIR/runtime/node/bin/gh"');
    expect(script).toContain('install -m 0755 "$DIST_DIR/$GH_DIST/bin/gh" "$STAGE_DIR/app/node_modules/.bin/gh"');
    expect(script).toContain('runtime/code-server');
    expect(script).toContain('/opt/matrix/runtime/code-server/bin/code-server "$@"');
    expect(script).toContain('chmod 0755 "$STAGE_DIR/bin/matrix-gateway"');
    expect(script).toContain('chmod -R g+rwX "$STAGE_DIR/runtime/node/lib/node_modules" "$STAGE_DIR/runtime/node/bin"');
    expect(script).toContain('find "$STAGE_DIR/runtime/node/lib/node_modules" "$STAGE_DIR/runtime/node/bin" -type d -exec chmod g+s {} +');
    expect(script).toContain('rm -rf "$STAGE_DIR/app/shell/.next/cache" "$STAGE_DIR/app/shell/e2e" "$STAGE_DIR/app/shell/node_modules"');
    expect(script).toContain('find "$STAGE_DIR/app/home/apps" -type d -name node_modules -prune -exec rm -rf {} +');
    expect(script).toContain('matrix-update');
    expect(script).toContain('cp -a "$ROOT_DIR/distro/customer-vps/systemd/." "$STAGE_DIR/systemd/"');
    expect(script).toContain('matrix-messaging-health');
    expect(script).toContain('"$STAGE_DIR/runtime/node/bin/gh"');
    expect(script).toContain('bin app runtime systemd release.json');
  });

  it('host bundle manifest keeps the sync-agent compatibility fields', () => {
    const root = process.cwd();
    const releaseScript = readFileSync(join(root, 'scripts/host-bundle-release.mjs'), 'utf8');

    expect(releaseScript).toContain('sha256: checksum');
    expect(releaseScript).toContain('size: bundleStat.size');
    expect(releaseScript).toContain('severity');
    expect(releaseScript).toContain('updateType');
    expect(releaseScript).toContain('bundleSha256: checksum');
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
    expect(publishScript).toContain('object_size "$BUNDLE_KEY"');
    expect(publishScript).toContain('bundle_object_sha256 "$BUNDLE_KEY"');
    expect(publishScript).toContain('checksum_object_sha256 "$CHECKSUM_KEY"');
    expect(publishScript).not.toContain('existing immutable bundle is missing checksum object');
    expect(publishScript).toContain('aws s3api put-object');
    expect(publishScript).toContain('--if-none-match');
    expect(publishScript).toContain('--metadata "sha256=$SHA256"');
    expect(publishScript).toContain('upload_immutable_object "$BUNDLE" "$BUNDLE_KEY" "application/gzip"');
    expect(publishScript).toContain('upload_immutable_object "$CHECKSUM_FILE" "$CHECKSUM_KEY" "text/plain; charset=utf-8"');
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
    expect(nodePublisher).not.toContain('head.Metadata?.sha256 && head.Metadata.sha256 !== expectedSha256');
    expect(nodePublisher).toContain('R2_ACCESS_KEY_ID');
    expect(nodePublisher).toContain('R2_SECRET_ACCESS_KEY');
    expect(nodePublisher).toContain('AbortSignal.timeout(30_000)');
  });

  it('host bundle release workflow stamps the resolved channel into release metadata before packaging', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain('channel: ${{ steps.channel.outputs.channel }}');
    expect(workflow).toContain('id: channel');
    expect(workflow).toContain('HOST_BUNDLE_CHANNEL: ${{ steps.channel.outputs.channel }}');
    expect(workflow).toContain('HOST_BUNDLE_CHANNEL: ${{ needs.build.outputs.channel }}');
    expect(workflow).toContain("PLATFORM_PUBLIC_URL: ${{ vars.PLATFORM_PUBLIC_URL || 'https://app.matrix-os.com' }}");
    expect(workflow).toContain('-X POST "${PLATFORM_PUBLIC_URL%/}/vps/deploy"');
    expect(workflow).not.toContain('HOST_BUNDLE_CHANNEL: ${{ steps.meta.outputs.channel }}');
    expect(workflow).not.toContain('-X POST "https://app.matrix-os.com/vps/deploy"');
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
    expect(workflow).toContain('dist/host-bundle/manifest.json');
    expect(workflow).toContain('dist/host-bundle/release.json');
    expect(workflow).not.toContain('path: dist/host-bundle/');
    expect(workflow).not.toContain('dist/host-bundle/stage');
  });

  it('host bundle release workflow cancels only superseded dev-channel builds', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain("group: host-bundle-release-${{ github.event_name == 'workflow_dispatch' && inputs.channel || github.ref_type == 'tag' && github.ref_name || 'dev' }}");
    expect(workflow).toContain("cancel-in-progress: ${{ github.ref_type != 'tag' && (github.event_name != 'workflow_dispatch' || inputs.channel == 'dev' || inputs.channel == '') }}");
    expect(workflow).not.toContain('cancel-in-progress: false');
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
    expect(updater).toContain('stable|canary|beta|dev|v[0-9]*|main-[A-Za-z0-9]*');
    expect(updater).toContain('journalctl -u matrix-sync-agent -f --no-pager -n 20');
    expect(updater).toContain('Usage: matrix-update [apply|rollback|stable|canary|beta|dev|v<version>|main-<build>]');
  });

  it('sync agent installs bundled messaging systemd units during updates', () => {
    const root = process.cwd();
    const syncAgent = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-sync-agent'), 'utf8');

    expect(syncAgent).toContain("sudo find \"$extract_dir/systemd\" -maxdepth 1 -name 'matrix-*.service'");
    expect(syncAgent).toContain('sudo systemctl daemon-reload');
    expect(syncAgent).toContain('Messaging runtimes missing; units installed but not enabled');
    expect(syncAgent).toContain('sudo systemctl enable matrix-homeserver.service matrix-bridge-telegram.service matrix-bridge-whatsapp.service');
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
    expect(launcher).toContain('export PATH="/opt/matrix/bin:/opt/matrix/app/node_modules/.bin:/opt/matrix/runtime/node/bin:/usr/local/bin:$PATH"');
    expect(launcher).toContain('export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"');
    expect(launcher).toContain('sync_bundled_home_assets');
    expect(launcher).toContain('sync-matrix-agent-skills.sh');
    expect(launcher).toContain('MATRIX_SKILL_TARGETS=matrix,claude,codex');
    expect(launcher).toContain('$MATRIX_HOME/system/icons');
    expect(launcher).toContain('[ -e "$target" ] && continue');
    expect(launcher).toContain('find "$bundled_home/apps" -type f -name matrix.json');
    expect(launcher).toContain('matrix.json package.json index.html vite.config.ts tsconfig.json src public dist .build-stamp');
    expect(launcher).toContain('cd "$APP_DIR"');
    expect(launcher).not.toContain('cp -a "$bundled_home/." "$MATRIX_HOME"');
    expect(launcher).not.toContain('desktop.json');
    expect(launcher).not.toContain('theme.json');
    expect(launcher).not.toContain('system/wallpapers');
  });

  it('restore script resolves matrixctl from the installed host bin directory', () => {
    const root = process.cwd();
    const restore = readFileSync(join(root, 'distro/customer-vps/matrix-restore.sh'), 'utf8');

    expect(restore).toContain('/opt/matrix/bin/matrixctl r2 exists system/vps-meta.json');
    expect(restore).toContain('latest_pointer_key="system/db/latest"');
    expect(restore).toContain('/opt/matrix/bin/matrixctl r2 get "$latest_pointer_key" "$latest_file"');
  });
});
