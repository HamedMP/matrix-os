import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import {
  loadCustomerVpsCloudInitTemplate,
  redactCloudInitSecrets,
  renderCloudInitTemplate,
  type CustomerHostConfig,
} from '../../packages/platform/src/customer-vps-cloud-init.js';

describe('platform/customer-vps-cloud-init', () => {
  it('rendered user_data stays under the Hetzner 32KiB limit with headroom', async () => {
    // Hetzner rejects servers whose user_data exceeds 32768 bytes with a
    // generic 422 invalid_input; the platform surfaces it as
    // provider_unavailable. Render with realistically long values and
    // require headroom below the hard cap so template growth fails CI
    // before it can fail provisioning.
    const HETZNER_USER_DATA_LIMIT = 32_768;
    const HEADROOM = 1_024;
    const longInput: CustomerHostConfig = {
      ...input,
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'user_2abcdefghijklmnopqrstuvwxyz012345',
      handle: 'a-sixty-three-character-handle-padded-to-the-validation-maxim',
      runtimeSlot: 'preview-runtime-slot-max-32-chars',
      imageVersion: '0.0.0-pr10000.abcdef012345',
      updateChannel: 'canary',
      hostBundleUrl:
        'https://app.matrix-os.com/system-bundles/0.0.0-pr10000.abcdef012345/matrix-host-bundle.tar.gz',
      registrationToken: 'r'.repeat(64),
      platformVerificationToken: 'v'.repeat(64),
      r2AccessKeyId: 'k'.repeat(32),
      r2SecretAccessKey: 's'.repeat(64),
      r2Prefix: 'matrixos-sync/user_2abcdefghijklmnopqrstuvwxyz012345/',
      postgresPassword: 'p'.repeat(48),
    };
    const template = await loadCustomerVpsCloudInitTemplate();
    const rendered = renderCloudInitTemplate(template, longInput);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(
      HETZNER_USER_DATA_LIMIT - HEADROOM,
    );
  });

  const input: CustomerHostConfig = {
    machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
    clerkUserId: 'user_123',
    handle: 'alice',
    runtimeSlot: 'staging',
    developerTools: 'codex claude-code opencode pi',
    imageVersion: 'stable',
    updateChannel: 'stable',
    hostBundleUrl: 'https://platform.example/system-bundles/stable/matrix-host-bundle.tar.gz',
    platformRegisterUrl: 'https://platform.example/vps/register',
    platformInternalUrl: 'https://platform.example',
    platformVerificationToken: 'platform-verification-secret',
    registrationToken: 'registration-secret',
    r2AccessKeyId: 'r2-access-key',
    r2SecretAccessKey: 'r2-secret-key',
    r2Endpoint: 'https://r2.example',
    r2AccountId: 'account-id',
    r2Bucket: 'matrixos-sync',
    r2Prefix: 'matrixos-sync/user_123/',
    postgresPassword: 'postgres-secret',
    posthogToken: 'phc_public',
    posthogProjectToken: 'phc_project',
    posthogHost: 'https://eu.i.posthog.com',
    posthogPublicHost: 'https://eu.posthog.com',
    posthogApiHost: '/relay',
  };

  function runMatrixctlExistsWithFakeAws(exitCode: number, stderr: string) {
    const root = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'second-matrixctl-r2-'));
    const fakeAwsPath = join(tempDir, 'aws');
    writeFileSync(
      fakeAwsPath,
      `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit ${exitCode}\n`,
    );
    chmodSync(fakeAwsPath, 0o755);

    try {
      return spawnSync('bash', [join(root, 'distro/customer-vps/matrixctl'), 'r2', 'exists', 'system/db/latest'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ''}`,
          R2_BUCKET: 'matrixos-sync',
          R2_PREFIX: 'matrixos-sync/user_123/',
          R2_ENDPOINT: 'https://r2.example',
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  function runRestoreWithFakeMatrixctl(existsStatus: number) {
    const root = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'second-restore-r2-'));
    const fakeMatrixctlPath = join(tempDir, 'matrixctl');
    const restorePath = join(tempDir, 'matrix-restore.sh');
    const restoreFlag = join(tempDir, 'restore-complete');

    writeFileSync(
      fakeMatrixctlPath,
      `#!/usr/bin/env bash
if [ "$1" = "r2" ] && [ "$2" = "exists" ]; then
  exit ${existsStatus}
fi
echo "unexpected matrixctl call: $*" >&2
exit 99
`,
    );
    chmodSync(fakeMatrixctlPath, 0o755);

    const restoreScript = readFileSync(join(root, 'distro/customer-vps/matrix-restore.sh'), 'utf8')
      .split('/opt/matrix/bin/matrixctl')
      .join(fakeMatrixctlPath)
      .replace('restore_flag="/opt/matrix/restore-complete"', `restore_flag=${JSON.stringify(restoreFlag)}`)
      .replace('latest_file="/var/lib/matrix/db/latest"', `latest_file=${JSON.stringify(join(tempDir, 'latest'))}`)
      .replace('snapshot_path="/var/lib/matrix/db/latest.dump"', `snapshot_path=${JSON.stringify(join(tempDir, 'latest.dump'))}`)
      .replace(
        'mkdir -p /home/matrix/home /home/matrix/projects /var/lib/matrix/db',
        'mkdir -p "$SECOND_RESTORE_TEST_ROOT/home" "$SECOND_RESTORE_TEST_ROOT/projects" "$SECOND_RESTORE_TEST_ROOT/db"',
      );
    writeFileSync(restorePath, restoreScript);
    chmodSync(restorePath, 0o755);

    try {
      const result = spawnSync('bash', [restorePath], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          SECOND_RESTORE_TEST_ROOT: tempDir,
        },
      });
      return {
        result,
        restoreFlagExists: existsSync(restoreFlag),
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it('renders required host variables into the cloud-init template', () => {
    const rendered = renderCloudInitTemplate(
      'id={{machineId}}\nuser={{clerkUserId}}\nhandle={{handle}}\nurl={{platformRegisterUrl}}\nr2={{r2Prefix}}\n',
      input,
    );

    expect(rendered).toContain('id=9f05824c-8d0a-4d83-9cb4-b312d43ff112');
    expect(rendered).toContain('user=user_123');
    expect(rendered).toContain('handle=alice');
    expect(rendered).toContain('url=https://platform.example/vps/register');
    expect(rendered).toContain('r2=matrixos-sync/user_123/');
  });

  it('renders a non-empty host bundle URL into customer cloud-init', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const rendered = renderCloudInitTemplate(cloudInit, input);

    expect(rendered).toContain(
      'MATRIX_HOST_BUNDLE_URL=https://platform.example/system-bundles/stable/matrix-host-bundle.tar.gz',
    );
    expect(rendered).toContain('MATRIX_RUNTIME_SLOT=staging');
    expect(rendered).toContain('MATRIX_UPDATE_CHANNEL=stable');
    expect(rendered).toContain('MATRIX_IMAGE_VERSION=stable');
    expect(rendered).not.toContain('MATRIX_HOST_BUNDLE_URL=\n');
  });

  it('renders a non-empty platform verification token into customer cloud-init', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const rendered = renderCloudInitTemplate(cloudInit, input);

    expect(rendered).toContain('UPGRADE_TOKEN=platform-verification-secret');
    expect(rendered).toContain('MATRIX_AUTH_TOKEN=platform-verification-secret');
    expect(rendered).toContain('MATRIX_CODE_PROXY_TOKEN=platform-verification-secret');
    expect(rendered).toContain('PLATFORM_INTERNAL_URL=https://platform.example');
    expect(rendered).toContain('path: /opt/matrix/env/symphony.env');
    expect(rendered).toContain('MATRIX_HANDLE=alice');
    expect(rendered).toContain('UPGRADE_TOKEN=platform-verification-secret');
    expect(rendered).not.toContain('UPGRADE_TOKEN=\n');
    expect(rendered).not.toContain('MATRIX_AUTH_TOKEN=\n');
    expect(rendered).not.toContain('MATRIX_CODE_PROXY_TOKEN=\n');
    expect(rendered).not.toContain('PLATFORM_INTERNAL_URL=\n');
  });

  it('renders R2 credentials for customer host backups into customer cloud-init', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const rendered = renderCloudInitTemplate(cloudInit, input);

    expect(rendered).toContain("AWS_ACCESS_KEY_ID='r2-access-key'");
    expect(rendered).toContain("AWS_SECRET_ACCESS_KEY='r2-secret-key'");
    expect(rendered).toContain("R2_ENDPOINT='https://r2.example'");
    expect(rendered).not.toContain("AWS_ACCESS_KEY_ID=''\n");
    expect(rendered).not.toContain("AWS_SECRET_ACCESS_KEY=''\n");
  });

  it('renders public PostHog project-key telemetry into customer host env', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const rendered = renderCloudInitTemplate(cloudInit, input);

    expect(rendered).toContain('POSTHOG_TOKEN=phc_public');
    expect(rendered).toContain('POSTHOG_PROJECT_TOKEN=phc_project');
    expect(rendered).toContain('POSTHOG_HOST=https://eu.i.posthog.com');
    expect(rendered).toContain('NEXT_PUBLIC_POSTHOG_KEY=phc_public');
    expect(rendered).toContain('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_project');
    expect(rendered).toContain('NEXT_PUBLIC_POSTHOG_HOST=https://eu.posthog.com');
    expect(rendered).toContain('NEXT_PUBLIC_POSTHOG_API_HOST=/relay');
  });

  it('renders valid YAML for the production customer cloud-init', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const rendered = renderCloudInitTemplate(cloudInit, input);
    const document = parseDocument(rendered);

    expect(document.errors).toEqual([]);
  });

  it('routes hosted app runtime paths to the gateway', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(cloudInit).toContain('location /apps/ {\n          proxy_pass http://127.0.0.1:4000;');
  });

  it('keeps write_files independent of the matrix group creation order', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(cloudInit.indexOf('groups:\n  - matrix')).toBeGreaterThanOrEqual(0);
    expect(cloudInit.indexOf('groups:\n  - matrix')).toBeLessThan(cloudInit.indexOf('write_files:'));
    expect(cloudInit).toContain('primary_group: matrix');
    expect(cloudInit).not.toContain('owner: root:matrix');
    expect(cloudInit).toContain('chown root:matrix /opt/matrix/postgres-compose.yml');
  });

  it('uses cloud-init user schema fields accepted by Ubuntu 24.04', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(cloudInit).toContain('homedir: /home/matrix');
    expect(cloudInit).not.toContain('    home: /home/matrix');
  });

  it('starts Matrix services before optional Hermes install work', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const codeServerBlock = cloudInit.slice(
      cloudInit.indexOf('path: /etc/systemd/system/matrix-code-server.service'),
      cloudInit.indexOf('path: /etc/systemd/system/matrix-sync-agent.service'),
    );

    expect(cloudInit).toContain('path: /etc/systemd/system/matrix-hermes.service');
    expect(cloudInit).toContain('ExecStart=/opt/matrix/bin/matrix-install-hermes');
    expect(cloudInit).toContain('ExecStartPost=-/bin/systemctl start matrix-code.service');
    expect(cloudInit).toContain('path: /etc/systemd/system/matrix-code-server.service');
    expect(codeServerBlock).toContain('Description=Install Matrix OS code-server runtime');
    expect(codeServerBlock).toContain('ConditionPathExists=!/opt/matrix/runtime/code-server/bin/code-server');
    expect(codeServerBlock).toContain('ExecStart=/opt/matrix/bin/matrix-install-tool-pack code-server');
    expect(codeServerBlock).not.toContain('ExecStartPost=-/bin/systemctl start matrix-code.service');
    expect(cloudInit).toContain('TimeoutStartSec=1800');
    expect(cloudInit).toContain(
      'systemctl enable matrix-restore.service matrix-gateway.service matrix-shell.service matrix-code-server.service matrix-code.service matrix-sync-agent.service matrix-symphony.service matrix-hermes.service matrix-hermes-dashboard.service matrix-linux-tools.service matrix-developer-tools.service matrix-db-backup.timer nginx',
    );
    expect(cloudInit).toContain(
      'systemctl start matrix-restore.service matrix-gateway.service matrix-shell.service matrix-sync-agent.service matrix-symphony.service',
    );
    expect(cloudInit).not.toContain(
      'systemctl start matrix-restore.service matrix-gateway.service matrix-shell.service matrix-code.service matrix-sync-agent.service matrix-symphony.service',
    );
    expect(cloudInit).toContain('systemctl start --no-block matrix-code-server.service || echo "matrix-host: code-server runtime install will retry via systemd" >&2');
    expect(cloudInit).toContain('systemctl start --no-block matrix-code.service || echo "matrix-host: code editor will retry via systemd" >&2');
    expect(cloudInit).toContain('systemctl start --no-block matrix-hermes.service || echo "matrix-host: optional Hermes install will retry via systemd" >&2');
    expect(cloudInit).toContain('systemctl start --no-block matrix-hermes-dashboard.service || echo "matrix-host: optional Hermes dashboard will retry via systemd" >&2');
    expect(cloudInit.indexOf('systemctl start matrix-restore.service matrix-gateway.service')).toBeLessThan(
      cloudInit.indexOf('systemctl start --no-block matrix-hermes.service'),
    );
    expect(cloudInit.indexOf('systemctl start --no-block matrix-hermes.service')).toBeLessThan(
      cloudInit.indexOf('systemctl start --no-block matrix-hermes-dashboard.service'),
    );
    expect(cloudInit).not.toContain('\n    /opt/matrix/bin/matrix-install-hermes\n');
  });

  it('stages and enables the Hermes dashboard loopback service', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const buildScript = readFileSync(join(root, 'scripts/build-host-bundle.sh'), 'utf8');
    const wrapper = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-hermes-dashboard'), 'utf8');
    const unit = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-hermes-dashboard.service'), 'utf8');

    expect(wrapper).toContain('source /opt/matrix/env/host.env');
    expect(wrapper).toContain('source /opt/matrix/bin/matrix-owner-env');
    expect(wrapper).toContain('HERMES_BIN=');
    expect(wrapper).toContain('dashboard --host 127.0.0.1 --port 9119');
    expect(wrapper).toContain('exit 0');

    expect(unit).toContain('Description=Matrix OS Hermes dashboard API (loopback)');
    expect(unit).toContain('After=matrix-hermes.service network-online.target');
    expect(unit).toContain('Wants=network-online.target');
    expect(unit).toContain('ConditionPathExists=/opt/matrix/bin/matrix-hermes-dashboard');
    expect(unit).toContain('User=matrix');
    expect(unit).toContain('Group=matrix');
    expect(unit).toContain('EnvironmentFile=/opt/matrix/env/host.env');
    expect(unit).toContain('ExecStart=/opt/matrix/bin/matrix-hermes-dashboard');
    expect(unit).toContain('Restart=on-failure');

    expect(cloudInit).toContain('path: /etc/systemd/system/matrix-hermes-dashboard.service');
    expect(cloudInit).toContain('ExecStart=/opt/matrix/bin/matrix-hermes-dashboard');

    expect(buildScript).toContain('"$STAGE_DIR/bin/matrix-hermes-dashboard"');
  });

  it('loads the production customer VPS cloud-init template', async () => {
    const cloudInit = await loadCustomerVpsCloudInitTemplate();

    expect(cloudInit).toContain('runcmd:');
    expect(cloudInit).toContain('systemctl enable matrix-restore.service matrix-gateway.service matrix-shell.service matrix-code-server.service matrix-code.service matrix-sync-agent.service matrix-symphony.service matrix-hermes.service matrix-hermes-dashboard.service matrix-linux-tools.service matrix-developer-tools.service matrix-db-backup.timer');
    expect(cloudInit).toContain('install -o root -g root -m 0644 /opt/matrix/systemd/*.service /etc/systemd/system/');
    expect(cloudInit).toContain('/opt/matrix/messaging /opt/matrix/messaging/bin');
    expect(cloudInit).toContain('if [ -x /opt/matrix/messaging/bin/synapse ] && [ -x /opt/matrix/messaging/bin/mautrix-telegram ] && [ -x /opt/matrix/messaging/bin/mautrix-whatsapp ]; then');
    expect(cloudInit).toContain('systemctl enable matrix-homeserver.service matrix-bridge-telegram.service matrix-bridge-whatsapp.service');
    expect(cloudInit).toContain('messaging runtimes not installed; units installed but not enabled');
    expect(cloudInit).toContain('for optional_bin in matrix-hermes-dashboard matrix-install-linux-tools matrix-install-developer-tools matrix-messaging-health matrix-messaging-backup matrix-messaging-restore; do');
    expect(cloudInit).toContain('MATRIX_HOST_BUNDLE_URL={{hostBundleUrl}}');
    expect(cloudInit).toContain('MATRIX_IMAGE_VERSION={{imageVersion}}');
    expect(cloudInit).toContain('MATRIX_UPDATE_CHANNEL={{updateChannel}}');
    expect(cloudInit).toContain('UPGRADE_TOKEN={{platformVerificationToken}}');
    expect(cloudInit).toContain('MATRIX_AUTH_TOKEN={{platformVerificationToken}}');
    expect(cloudInit).toContain('MATRIX_CODE_PROXY_TOKEN={{platformVerificationToken}}');
    expect(cloudInit).toContain('PLATFORM_INTERNAL_URL={{platformInternalUrl}}');
    expect(cloudInit).toContain('POSTHOG_TOKEN={{posthogToken}}');
    expect(cloudInit).toContain('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN={{posthogProjectToken}}');
    expect(cloudInit).toContain("AWS_ACCESS_KEY_ID='{{r2AccessKeyId}}'");
    expect(cloudInit).toContain("AWS_SECRET_ACCESS_KEY='{{r2SecretAccessKey}}'");
  });

  it('keeps installed release metadata readable by the gateway after first boot', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(cloudInit).toContain('chown root:matrix /opt/matrix/release.json');
    expect(cloudInit).toContain('chmod 0644 /opt/matrix/release.json');
  });

  it('routes code.matrix-os.com to the customer host code proxy', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(cloudInit).toContain('server_name code.matrix-os.com');
    expect(cloudInit).toContain('proxy_pass http://127.0.0.1:8787');
    expect(cloudInit).toContain('proxy_set_header X-Matrix-Code-Proxy-Token $http_x_matrix_code_proxy_token');
    expect(cloudInit).toContain('if ($http_x_forwarded_host = "code.matrix-os.com")');
    expect(cloudInit).toContain('error_page 418 = @matrix_code_proxy');
  });

  it('copies customer VPS cloud-init assets into the runtime image', () => {
    const root = process.cwd();
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('COPY distro/customer-vps /app/distro/customer-vps');
  });

  it('uses a retrying bounded download for the host bundle and sha sidecar', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(cloudInit).toContain('curl --fail --location --retry 3 --retry-delay 5 --retry-all-errors --connect-timeout 10 --max-time 900 "$MATRIX_HOST_BUNDLE_URL"');
    expect(cloudInit).toContain('curl --fail --location --retry 3 --retry-delay 5 --retry-all-errors --connect-timeout 10 --max-time 30 "${MATRIX_HOST_BUNDLE_URL}.sha256"');
  });

  it('exposes selectable coding agent CLIs on customer hosts', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const gateway = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-gateway'), 'utf8');
    const buildScript = readFileSync(join(root, 'scripts/build-host-bundle.sh'), 'utf8');
    const toolPackInstaller = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-install-tool-pack'), 'utf8');

    expect(buildScript).toContain('matrix-install-tool-pack');
    expect(buildScript).toContain('https://astral.sh/uv/install.sh');
    expect(buildScript).toContain('UV_INSTALL_DIR="$STAGE_DIR/runtime/node/bin"');
    expect(buildScript).toContain('scripts/install-hermes-matrix-skills.sh');
    expect(buildScript).toContain('scripts/sync-matrix-agent-skills.sh');
    expect(buildScript).toContain('cp -a "$ROOT_DIR/skills" "$STAGE_DIR/app/skills"');
    expect(toolPackInstaller).toContain('install_coding_agents()');
    expect(toolPackInstaller).toContain('finish_agent_install()');
    expect(toolPackInstaller).toContain('install_code_server()');
    expect(toolPackInstaller).toContain('@anthropic-ai/claude-code@latest');
    expect(toolPackInstaller).toContain('@openai/codex@latest');
    expect(toolPackInstaller).toContain('OPENCODE_AI_VERSION="${OPENCODE_AI_VERSION:-latest}"');
    expect(toolPackInstaller).toContain('PI_CODING_AGENT_VERSION="${PI_CODING_AGENT_VERSION:-latest}"');
    expect(toolPackInstaller).toContain('"opencode-ai@${OPENCODE_AI_VERSION}"');
    expect(toolPackInstaller).toContain('run_npm_install()');
    expect(toolPackInstaller).toContain('resolve_runtime_user()');
    expect(toolPackInstaller).toContain('runtime user ${MATRIX_RUNTIME_USER} not found; using current user ${current_user}');
    expect(toolPackInstaller).toContain('run_as_matrix "$timeout_bin" 900 "$NODE_PREFIX/bin/npm" "$@"');
    expect(toolPackInstaller).toContain('run_npm_install install -g --ignore-scripts --prefix "$NODE_PREFIX"');
    expect(toolPackInstaller).toContain('"@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}"');
    expect(toolPackInstaller).toContain('node_prefix_chmod()');
    expect(toolPackInstaller).toContain('if ! command -v flock >/dev/null 2>&1; then');
    expect(toolPackInstaller).toContain('install_claude_code_package()');
    expect(toolPackInstaller).toContain('install_codex_package()');
    expect(toolPackInstaller).toContain('install_opencode_package()');
    expect(toolPackInstaller).toContain('install_pi_package()');
    expect(toolPackInstaller).toMatch(/install_coding_agents\(\) \{\n  log "installing coding agent CLIs"\n  install_claude_code_package\n  install_codex_package\n  install_opencode_package\n  install_pi_package\n  finish_agent_install\n  log "coding agent CLIs installed"\n\}/);
    expect(toolPackInstaller).toContain('claude-code|codex|opencode|pi|coding-agents|code-server|hermes|linux-tools|all');
    expect(toolPackInstaller).toContain('claude-code) with_pack_lock "$pack" install_claude_code ;;');
    expect(toolPackInstaller).toContain('codex) with_pack_lock "$pack" install_codex ;;');
    expect(toolPackInstaller).toContain('opencode) with_pack_lock "$pack" install_opencode ;;');
    expect(toolPackInstaller).toContain('pi) with_pack_lock "$pack" install_pi ;;');
    expect(toolPackInstaller).toContain('CODE_SERVER_VERSION="${HOST_BUNDLE_CODE_SERVER_VERSION:-4.116.0}"');
    expect(toolPackInstaller).toContain('CODE_SERVER_URL="https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${CODE_SERVER_ARCHIVE}"');
    expect(toolPackInstaller).toContain('runtime/code-server');
    expect(toolPackInstaller).toContain('/opt/matrix/runtime/code-server/bin/code-server "$@"');
    expect(cloudInit).toContain("MATRIX_DEVELOPER_TOOLS='{{developerTools}}'");
    expect(cloudInit).toContain('matrix-developer-tools.service');
    expect(cloudInit).toContain('systemctl start --no-block matrix-developer-tools.service');
    expect(cloudInit).toContain('path: /etc/profile.d/matrix-runtime.sh');
    expect(cloudInit).toContain('export MATRIX_HOME="${MATRIX_HOME:-/home/matrix/home}"');
    expect(cloudInit).toContain('export HOME="$MATRIX_HOME"');
    expect(cloudInit).toContain('export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"');
    expect(cloudInit).toContain('export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"');
    expect(cloudInit).toContain('export PATH="$HOME/.local/bin:/opt/matrix/bin:/opt/matrix/runtime/node/bin:$PATH"');
    expect(cloudInit).toContain('install -d -o matrix -g matrix -m 0755 /home/matrix /home/matrix/home /home/matrix/home/.local /home/matrix/home/.local/bin /home/matrix/home/.local/share /home/matrix/home/.cache /home/matrix/home/.config');
    expect(cloudInit).toContain('usermod -d /home/matrix/home matrix');
    expect(cloudInit).toContain('ensure_owner_link .local 0755');
    expect(cloudInit).toContain('ensure_owner_link .cache 0755');
    expect(cloudInit).toContain('ensure_owner_link .config 0755');
    expect(cloudInit).toContain('ensure_owner_link .hermes 0700');
    expect(cloudInit).toContain('install -d -o matrix -g matrix -m 0700 /home/matrix/home/.ssh');
    expect(cloudInit).toContain('ln -sfn /home/matrix/home/.ssh /home/matrix/.ssh');
    expect(cloudInit).toContain('ln -sfn /home/matrix/home /home/matrixos/home');
    expect(cloudInit).toContain('DEBIAN_FRONTEND=noninteractive apt-get install -y software-properties-common');
    expect(cloudInit).toContain('add-apt-repository -y universe');
    expect(cloudInit).toContain('DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap build-essential ca-certificates cmatrix curl docker.io elixir erlang-base erlang-crypto erlang-inets erlang-public-key erlang-ssl erlang-tools file git postgresql-client procps nginx openssl socat sudo unzip');
    expect(cloudInit).toContain("cat >/etc/apparmor.d/bwrap <<'EOF'");
    expect(cloudInit).toContain('profile bwrap /usr/bin/bwrap flags=(unconfined) {');
    expect(cloudInit).toContain('      userns,');
    expect(cloudInit).toContain('systemctl reload apparmor');
    expect(cloudInit.indexOf('add-apt-repository -y universe')).toBeLessThan(
      cloudInit.indexOf('DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap build-essential ca-certificates cmatrix'),
    );
    expect(cloudInit.indexOf('DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap build-essential ca-certificates cmatrix')).toBeLessThan(
      cloudInit.indexOf("cat >/etc/apparmor.d/bwrap <<'EOF'"),
    );
    expect(cloudInit).toContain('for cli in node npm npx claude codex opencode pi code-server uv uvx; do');
    expect(cloudInit).toContain('ln -sf "/opt/matrix/runtime/node/bin/${cli}" "/usr/local/bin/${cli}"');
    expect(cloudInit).toContain('/opt/matrix/bin/matrix-install-hermes');
    expect(cloudInit).toContain('/opt/matrix/bin/matrix-install-linux-tools');
    expect(cloudInit).toContain('path: /etc/systemd/system/matrix-linux-tools.service');
    expect(cloudInit).toContain('ExecStart=/opt/matrix/bin/matrix-install-linux-tools');
    expect(cloudInit).toContain('Restart=on-failure');
    expect(cloudInit).toContain('systemctl start --no-block matrix-linux-tools.service || echo "matrix-host: optional Linux tools install will retry via systemd" >&2');
    expect(cloudInit).not.toContain('sudo -H -u matrix /opt/matrix/bin/matrix-install-linux-tools');
    expect(cloudInit).toContain('export HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"');
    expect(cloudInit).toContain('export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"');
    expect(cloudInit).toContain('export MANPATH="/home/linuxbrew/.linuxbrew/share/man:${MANPATH:-}:"');
    expect(cloudInit).not.toContain('brew shellenv');
    expect(gateway).toContain('matrix_prepend_path_once "/opt/matrix/app/node_modules/.bin"');
    expect(gateway).toContain('MATRIX_SKILL_TARGETS=matrix,claude,codex');
    expect(cloudInit).toContain('DATABASE_URL=postgresql://matrix:{{postgresPassword}}@127.0.0.1:5432/matrix');
    expect(cloudInit).not.toContain('owner: root:matrix');
    expect(cloudInit).not.toContain("printf '%s\\n' \"$MATRIX_IMAGE_VERSION\" >/opt/matrix/app/BUNDLE_VERSION");
    expect(cloudInit).toContain('bundle_version="$(sed -n');
    expect(cloudInit).toContain("printf '%s\\n' \"$bundle_version\" >/opt/matrix/app/BUNDLE_VERSION");
    expect(cloudInit).toContain('chmod -R g+rwX /opt/matrix/app');
  });

  it('grants the customer matrix user passwordless sudo for host installers', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    expect(cloudInit).toContain('sudo');
    expect(cloudInit).toContain('DEBIAN_FRONTEND=noninteractive apt-get install -y software-properties-common');
    expect(cloudInit).toContain('add-apt-repository -y universe');
    expect(cloudInit).toContain('DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap build-essential ca-certificates cmatrix curl docker.io elixir erlang-base erlang-crypto erlang-inets erlang-public-key erlang-ssl erlang-tools file git postgresql-client procps nginx openssl socat sudo unzip');
    expect(cloudInit).toContain('install -d -o root -g root -m 0750 /etc/sudoers.d');
    expect(cloudInit).toContain("printf 'matrix ALL=(ALL) NOPASSWD:ALL\\n' >/etc/sudoers.d/matrix");
    expect(cloudInit).toContain('chmod 0440 /etc/sudoers.d/matrix');
    expect(cloudInit).toContain('visudo -cf /etc/sudoers.d/matrix');
    expect(cloudInit).toContain('loginctl enable-linger matrix');
    expect(cloudInit).toContain('systemctl start "user@$(id -u matrix).service"');
    expect(cloudInit).toContain('ensure_owner_link .config 0755');
  });

  it('installs Homebrew and GitHub CLI on customer Linux hosts', () => {
    const root = process.cwd();
    const installer = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-install-linux-tools'), 'utf8');
    const bundleScript = readFileSync(join(root, 'scripts/build-host-bundle.sh'), 'utf8');

    expect(installer).toContain('https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh');
    expect(installer).toContain('retry 2 30 env NONINTERACTIVE=1 timeout 600 /bin/bash "$tmp_installer"');
    expect(installer).toContain('cd "${HOME:-/home/matrix/home}"');
    expect(installer).toContain('retry 3 30 timeout 600 "$BREW_BIN" install gh');
    expect(installer).not.toContain('withgraphite/tap/graphite');
    expect(installer).not.toContain('cosineai/tap');
    expect(installer).not.toContain('brew install cos');
    expect(installer).toContain('/etc/profile.d/homebrew.sh');
    expect(installer).toContain('if [ -n "\\${PWD:-}" ] && [ ! -r "\\${PWD}" ]; then');
    expect(installer).toContain('trap \'rm -f "${tmp:-}"\' RETURN');
    expect(installer).toContain('write_homebrew_shell_config');
    expect(installer).toContain('export MANPATH="$BREW_PREFIX/share/man:${MANPATH:-}:"');
    expect(installer).toContain('export MANPATH="$BREW_PREFIX/share/man:\\${MANPATH:-}:"');
    expect(installer).not.toContain('brew shellenv');
    expect(installer).toContain('sudo ln -sf "$BREW_BIN" /usr/local/bin/brew');
    expect(installer).toContain('sudo ln -sf "$BREW_PREFIX/bin/gh" /usr/local/bin/gh');
    expect(installer).not.toContain('sudo ln -sf "$BREW_PREFIX/bin/gt" /usr/local/bin/gt');
    expect(bundleScript).toContain('matrix-install-linux-tools');
  });

  it('installs a customer host code-server service behind restore completion', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');
    const code = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-code'), 'utf8');
    const codeUnitBlock = cloudInit.slice(
      cloudInit.indexOf('path: /etc/systemd/system/matrix-code.service'),
      cloudInit.indexOf('path: /etc/systemd/system/matrix-code-server.service'),
    );
    const codeServerBlock = cloudInit.slice(
      cloudInit.indexOf('path: /etc/systemd/system/matrix-code-server.service'),
      cloudInit.indexOf('path: /etc/systemd/system/matrix-sync-agent.service'),
    );

    expect(codeUnitBlock).toContain('Description=Matrix OS customer code editor');
    expect(codeUnitBlock).toContain('After=matrix-restore.service');
    expect(codeUnitBlock).not.toContain('After=matrix-restore.service matrix-code-server.service');
    expect(codeUnitBlock).not.toContain('Wants=matrix-code-server.service');
    expect(codeUnitBlock).toContain('ExecStart=/opt/matrix/bin/matrix-code');
    expect(codeUnitBlock).toContain('TimeoutStartSec=1800');
    expect(codeUnitBlock).toContain('ConditionPathExists=/opt/matrix/bin/matrix-code');
    expect(codeUnitBlock).not.toContain('ConditionPathExists=/opt/matrix/runtime/code-server/bin/code-server');
    expect(codeServerBlock).toContain('Description=Install Matrix OS code-server runtime');
    expect(codeServerBlock).toContain('ExecStart=/opt/matrix/bin/matrix-install-tool-pack code-server');
    expect(codeServerBlock).toContain('ConditionPathExists=!/opt/matrix/runtime/code-server/bin/code-server');
    expect(codeServerBlock).not.toContain('ExecStartPost=-/bin/systemctl start matrix-code.service');
    expect(code).toContain('MATRIX_CODE_PROXY_TOKEN');
    expect(code).toContain('matrix-code: code-server is missing; attempting install');
    expect(code).toContain('sudo -n /opt/matrix/bin/matrix-install-tool-pack code-server');
    expect(code).toContain('matrix-code: code-server install already running; waiting');
    expect(code).toContain('for _ in $(seq 1 180); do');
    expect(code).toContain('code-server');
    expect(code).toContain('crypto.timingSafeEqual');
  });

  it('redacts bootstrap secrets before logging rendered cloud-init', () => {
    const rendered = renderCloudInitTemplate(
      'token={{registrationToken}}\npassword={{postgresPassword}}\nplatform={{platformVerificationToken}}\nr2={{r2SecretAccessKey}}\n',
      input,
    );

    const redacted = redactCloudInitSecrets(rendered, input);

    expect(redacted).not.toContain('registration-secret');
    expect(redacted).not.toContain('postgres-secret');
    expect(redacted).not.toContain('platform-verification-secret');
    expect(redacted).not.toContain('r2-secret-key');
    expect(redacted).toContain('[redacted]');
  });

  it('orders gateway and shell behind restore completion on customer hosts', () => {
    const root = process.cwd();
    const gateway = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-gateway.service'), 'utf8');
    const shell = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-shell.service'), 'utf8');
    const restore = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-restore.service'), 'utf8');

    expect(gateway).toContain('Requires=matrix-restore.service');
    expect(gateway).toContain('ConditionPathExists=/opt/matrix/restore-complete');
    expect(gateway).toContain('ConditionPathExists=/opt/matrix/bin/matrix-gateway');
    expect(shell).toContain('After=matrix-gateway.service');
    expect(shell).toContain('ConditionPathExists=/opt/matrix/bin/matrix-shell');
    expect(readFileSync(join(root, 'distro/customer-vps/systemd/matrix-sync-agent.service'), 'utf8')).toContain(
      'ConditionPathExists=/opt/matrix/bin/matrix-sync-agent',
    );
    expect(restore).toContain('Type=oneshot');
  });

  it('uploads DB snapshots before updating latest without calling deferred pruning', () => {
    const root = process.cwd();
    const backup = readFileSync(join(root, 'distro/customer-vps/matrix-db-backup.sh'), 'utf8');

    expect(backup.indexOf('/opt/matrix/bin/matrixctl r2 put "$snapshot_path" "$snapshot_key"')).toBeLessThan(
      backup.indexOf('/opt/matrix/bin/matrixctl r2 put-latest "$snapshot_key"'),
    );
    expect(backup).not.toContain('matrixctl r2 prune system/db/snapshots/');
    expect(backup).toContain('--format=custom');
    expect(backup).toContain('.dump');
    expect(backup).toContain('timeout');
    expect(backup).toContain('system/runtime-slots/${runtime_slot}/db/snapshots/${snapshot_name}');
  });

  it('keeps restore as a boot gate and refuses failed restores', () => {
    const root = process.cwd();
    const restore = readFileSync(join(root, 'distro/customer-vps/matrix-restore.sh'), 'utf8');
    const gateway = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-gateway.service'), 'utf8');

    expect(restore).toContain('restore-complete');
    expect(restore).toContain('pg_isready');
    expect(restore.indexOf('pg_isready')).toBeLessThan(restore.indexOf('pg_restore'));
    expect(restore).toContain('docker run -d');
    expect(restore).not.toContain('docker compose');
    expect(restore).toContain('pg_restore');
    expect(restore).toContain('exit 1');
    expect(restore).toContain('system/runtime-slots/${runtime_slot}/db/latest');
    expect(gateway).toContain('ConditionPathExists=/opt/matrix/restore-complete');
  });

  it('only skips restore on confirmed missing R2 backup markers', () => {
    const root = process.cwd();
    const restore = readFileSync(join(root, 'distro/customer-vps/matrix-restore.sh'), 'utf8');
    // bundled copy replaces the former cloud-init write_files entry
    const bundled = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-restore.sh'), 'utf8');

    for (const script of [restore, bundled]) {
      expect(script).toContain('check_r2_exists_or_skip_restore()');
      expect(script).toContain('local status');
      expect(script).toMatch(/else\n\s+status="\$[?]"/);
      expect(script).toContain('if [ "$status" -eq 1 ]; then');
      expect(script).toContain('touch "$restore_flag"');
      expect(script).toContain('matrix-restore: failed to check');
      expect(script).not.toContain('if ! /opt/matrix/bin/matrixctl r2 exists system/vps-meta.json; then');
      expect(script).not.toContain('if ! /opt/matrix/bin/matrixctl r2 exists "$latest_pointer_key"; then');
    }
  });

  it('executes restore skip only for not-found R2 exists status', () => {
    const notFound = runRestoreWithFakeMatrixctl(1);
    expect(notFound.result.status, notFound.result.stderr).toBe(0);
    expect(notFound.restoreFlagExists).toBe(true);

    const timeout = runRestoreWithFakeMatrixctl(124);
    expect(timeout.result.status).toBe(1);
    expect(timeout.restoreFlagExists).toBe(false);
    expect(timeout.result.stderr).toContain('matrix-restore: failed to check VPS metadata');

    const operationalError = runRestoreWithFakeMatrixctl(2);
    expect(operationalError.result.status).toBe(1);
    expect(operationalError.restoreFlagExists).toBe(false);
    expect(operationalError.result.stderr).toContain('matrix-restore: failed to check VPS metadata');
  });

  it('runs DB backup on an hourly systemd timer', () => {
    const root = process.cwd();
    const service = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-db-backup.service'), 'utf8');
    const timer = readFileSync(join(root, 'distro/customer-vps/systemd/matrix-db-backup.timer'), 'utf8');

    expect(service).toContain('ExecStart=/opt/matrix/bin/matrix-db-backup.sh');
    expect(timer).toContain('OnCalendar=hourly');
    expect(timer).toContain('Persistent=true');
  });

  it('installs backup artifacts with restrictive modes', () => {
    const root = process.cwd();
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/cloud-init.yaml'), 'utf8');

    // matrixctl/restore/backup ship in the host bundle (32KiB user_data
    // limit); cloud-init validates and chmods them after bundle extraction.
    for (const bin of ['matrixctl', 'matrix-db-backup.sh', 'matrix-restore.sh']) {
      expect(existsSync(join(root, 'distro/customer-vps/host-bin', bin))).toBe(true);
    }
    expect(cloudInit).toMatch(/for required_bin in matrixctl matrix-db-backup\.sh matrix-restore\.sh /);
    expect(cloudInit).toContain('path: /etc/systemd/system/matrix-db-backup.timer');
    expect(cloudInit).toContain('docker.io elixir erlang-base erlang-crypto erlang-inets erlang-public-key erlang-ssl erlang-tools file git postgresql-client procps nginx openssl socat sudo unzip');
    expect(cloudInit).toContain('https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip');
    expect(cloudInit).toContain('/tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli');
    expect(cloudInit).toContain('docker run -d');
    expect(cloudInit).toContain('systemctl enable matrix-restore.service matrix-gateway.service matrix-shell.service matrix-code-server.service matrix-code.service matrix-sync-agent.service matrix-symphony.service matrix-hermes.service matrix-hermes-dashboard.service matrix-linux-tools.service matrix-developer-tools.service matrix-db-backup.timer');
  });

  it('includes a bounded matrixctl recovery wrapper', () => {
    const root = process.cwd();
    const matrixctl = readFileSync(join(root, 'distro/customer-vps/matrixctl'), 'utf8');
    // matrixctl ships in the host bundle (host-bin/), not cloud-init:
    // Hetzner rejects user_data over 32KiB.
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/host-bin/matrixctl'), 'utf8');

    expect(matrixctl).toContain('matrixctl recover <clerk-user-id> [--slot <runtime-slot>] [--allow-empty]');
    expect(matrixctl).toContain('local runtime_slot="${MATRIX_RUNTIME_SLOT:-primary}"');
    expect(matrixctl).toContain('""|[!a-z0-9]*|*[^a-z0-9-]*|*-) fail "invalid runtime slot"');
    expect(matrixctl).toContain('system/runtime-slots/${runtime_slot}/db/latest');
    expect(matrixctl).toContain('payload="$(printf \'{"clerkUserId":"%s","runtimeSlot":"%s","allowEmpty":%s}\'');
    expect(matrixctl).toContain('${MATRIX_PLATFORM_URL%/}/vps/recover');
    expect(matrixctl).toContain('curl --fail --silent --show-error --max-time 10');
    expect(matrixctl).toContain('set +u');
    expect(matrixctl).toContain('export AWS_ACCESS_KEY_ID=');
    expect(matrixctl).toContain('rm -f "${tmp:-}"');
    expect(cloudInit).toContain('matrixctl recover <clerk-user-id> [--slot <runtime-slot>] [--allow-empty]');
    expect(cloudInit).toContain('runtime_slot="${MATRIX_RUNTIME_SLOT:-primary}"');
    expect(cloudInit).toContain('""|[!a-z0-9]*|*[^a-z0-9-]*|*-) fail "invalid runtime slot"');
    expect(cloudInit).toContain('{"clerkUserId":"%s","runtimeSlot":"%s","allowEmpty":%s}');
  });

  it('bounds matrixctl R2 aws operations in host scripts and cloud-init', () => {
    const root = process.cwd();
    const matrixctl = readFileSync(join(root, 'distro/customer-vps/matrixctl'), 'utf8');
    // bundled copy replaces the former cloud-init write_files entry
    const cloudInit = readFileSync(join(root, 'distro/customer-vps/host-bin/matrixctl'), 'utf8');

    for (const script of [matrixctl, cloudInit]) {
      expect(script).toContain('MATRIX_R2_OPERATION_TIMEOUT_SECONDS="${MATRIX_R2_OPERATION_TIMEOUT_SECONDS:-300}"');
      expect(script).toContain('MATRIX_R2_CONNECT_TIMEOUT_SECONDS="${MATRIX_R2_CONNECT_TIMEOUT_SECONDS:-10}"');
      expect(script).toContain('MATRIX_R2_READ_TIMEOUT_SECONDS="${MATRIX_R2_READ_TIMEOUT_SECONDS:-60}"');
      expect(script).toContain('timeout --preserve-status "$MATRIX_R2_OPERATION_TIMEOUT_SECONDS"');
      expect(script).toContain('--cli-connect-timeout "$MATRIX_R2_CONNECT_TIMEOUT_SECONDS"');
      expect(script).toContain('--cli-read-timeout "$MATRIX_R2_READ_TIMEOUT_SECONDS"');
      expect(script).toContain('aws_s3 s3 cp "$src" "s3://${R2_BUCKET}/${key}"');
      expect(script).toContain('aws_s3 s3 cp "s3://${R2_BUCKET}/${key}" "$dest"');
      expect(script).toContain('aws_s3 s3api head-object --bucket "$R2_BUCKET" --key "$key"');
    }
  });

  it('keeps matrixctl R2 exists timeouts distinct from not-found', () => {
    const timeoutResult = runMatrixctlExistsWithFakeAws(124, 'timed out');
    expect(timeoutResult.status).toBe(124);
    expect(timeoutResult.stderr).toContain('matrixctl: r2 exists timed out');

    const terminatedResult = runMatrixctlExistsWithFakeAws(143, 'terminated');
    expect(terminatedResult.status).toBe(143);
    expect(terminatedResult.stderr).toContain('matrixctl: r2 exists timed out');

    const notFoundResult = runMatrixctlExistsWithFakeAws(
      255,
      'An error occurred (404) when calling the HeadObject operation: Not Found',
    );
    expect(notFoundResult.status).toBe(1);
  });
});
