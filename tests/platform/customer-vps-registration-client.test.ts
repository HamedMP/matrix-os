import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runRegistrationClient(
  registerStatus: number,
  failureCode = '',
  expiresAt = '2099-01-01T00:00:00.000Z',
  runtimeReady = true,
  operatorVerifies = false,
  options: { developerTools?: string | null; toolState?: 'missing' | 'installing' | 'failed' | 'installed'; gatewayReady?: boolean; authToken?: string } = {},
) {
  const root = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'matrix-register-vps-'));
  const fakeBin = join(tempDir, 'bin');
  const curlLog = join(tempDir, 'curl.log');
  const registerFlag = join(tempDir, 'register-complete');
  const curlPath = join(fakeBin, 'curl');
  const datePath = join(fakeBin, 'date');
  const sleepPath = join(fakeBin, 'sleep');

  try {
    mkdirSync(fakeBin);
    writeFileSync(
      curlPath,
      `#!/usr/bin/env bash
set -euo pipefail
output_path=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output' ]; then output_path="$argument"; fi
  previous="$argument"
done
case "$*" in
  *gateway-health*) [ "$FAKE_GATEWAY_READY" = true ] ;;
  *api/terminal/health*) [ "$FAKE_RUNTIME_READY" = true ] ;;
  *metadata/instance-id*) printf '163944713' ;;
  *metadata/public-ipv4*) printf '203.0.113.10' ;;
  *vps/register*)
    printf 'register\n' >> "$FAKE_CURL_LOG"
    if [ -n "$output_path" ]; then
      printf '{"failure_code":"%s"}' "$FAKE_FAILURE_CODE" > "$output_path"
    fi
    printf '%s' "$FAKE_REGISTER_STATUS"
    ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(curlPath, 0o755);
    writeFileSync(
      datePath,
      `#!/usr/bin/env bash
if [ "\${1:-}" = '--date' ]; then
  case "\${2:-}" in
    2020-*) printf '1577836800\n' ;;
    *) printf '4102444800\n' ;;
  esac
else
  /bin/date "$@"
fi
`,
      { mode: 0o755 },
    );
    chmodSync(datePath, 0o755);
    writeFileSync(
      sleepPath,
      '#!/usr/bin/env bash\n[ "${FAKE_OPERATOR_VERIFIES:-false}" != true ] || touch "$MATRIX_REGISTER_FLAG"\n',
      { mode: 0o755 },
    );
    chmodSync(sleepPath, 0o755);

    const toolsRoot = join(tempDir, 'developer-tools');
    mkdirSync(toolsRoot);
    if (options.toolState === 'installing') writeFileSync(join(toolsRoot, 'in-progress'), 'pi\n');
    if (options.toolState === 'failed') writeFileSync(join(toolsRoot, 'failed-tools'), 'pi\n');
    if (options.toolState === 'installed') {
      writeFileSync(join(toolsRoot, 'installed-tools'), 'pi\n');
      writeFileSync(join(toolsRoot, 'pi'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    }
    const script = join(tempDir, 'matrix-register-vps');
    writeFileSync(script, readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-register-vps'), 'utf8')
      .replaceAll('/var/lib/matrix-developer-tools', toolsRoot)
      .replaceAll('/opt/matrix/runtime/node/bin', toolsRoot));
    const result = spawnSync(
      'bash',
      [script],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'MATRIX_DEVELOPER_TOOLS')),
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          FAKE_CURL_LOG: curlLog,
          FAKE_REGISTER_STATUS: String(registerStatus),
          FAKE_FAILURE_CODE: failureCode,
          FAKE_RUNTIME_READY: String(runtimeReady),
          FAKE_GATEWAY_READY: String(options.gatewayReady ?? true),
          FAKE_OPERATOR_VERIFIES: String(operatorVerifies),
          MATRIX_MACHINE_ID: '1d4848b6-b0f8-449c-8bf2-267ee9ae3ed1',
          MATRIX_IMAGE_VERSION: 'test-version',
          MATRIX_AUTH_TOKEN: options.authToken ?? 'test-auth-token',
          ...(options.developerTools === null ? {} : { MATRIX_DEVELOPER_TOOLS: options.developerTools ?? '' }),
          MATRIX_GATEWAY_HEALTH_URL: 'https://gateway-health.test/health',
          MATRIX_PLATFORM_REGISTER_URL: 'https://platform.example.test/vps/register',
          MATRIX_REGISTRATION_TOKEN: 'test-token',
          MATRIX_REGISTRATION_TOKEN_EXPIRES_AT: expiresAt,
          MATRIX_REGISTER_FLAG: registerFlag,
          MATRIX_REGISTER_LOCK: join(tempDir, 'register.lock'),
          MATRIX_REGISTRATION_MAX_ATTEMPTS: '2',
        },
      },
    );

    return {
      result,
      registrationAttempts: existsSync(curlLog) ? readFileSync(curlLog, 'utf8').trim().split('\n').length : 0,
      registerFlagExists: existsSync(registerFlag),
      installerStillRunning: existsSync(join(toolsRoot, 'in-progress')),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('customer VPS registration client', () => {
  it('marks a successful registration complete', () => {
    const registration = runRegistrationClient(200);

    expect(registration.result.status, registration.result.stderr).toBe(0);
    expect(registration.registrationAttempts).toBe(1);
    expect(registration.registerFlagExists).toBe(true);
  });

  it('treats an already-registered HTTP 409 as complete and stops retrying', () => {
    const registration = runRegistrationClient(409, 'already_registered');

    expect(registration.result.status, registration.result.stderr).toBe(0);
    expect(registration.registrationAttempts).toBe(1);
    expect(registration.registerFlagExists).toBe(true);
  });

  it('does not mark a generic invalid-state HTTP 409 registration complete', () => {
    const registration = runRegistrationClient(409, 'invalid_state');

    expect(registration.result.status).toBe(64);
    expect(registration.registrationAttempts).toBe(1);
    expect(registration.registerFlagExists).toBe(false);
  });

  it('does not mark a rejected HTTP 409 registration complete', () => {
    const registration = runRegistrationClient(409, 'registration_rejected');

    expect(registration.result.status).toBe(64);
    expect(registration.registrationAttempts).toBe(1);
    expect(registration.registerFlagExists).toBe(false);
  });

  it('does not retry a non-retryable client error', () => {
    const registration = runRegistrationClient(400);

    expect(registration.result.status).toBe(64);
    expect(registration.registrationAttempts).toBe(1);
    expect(registration.registerFlagExists).toBe(false);
  });

  it('does not follow or retry a redirect response', () => {
    const registration = runRegistrationClient(302);

    expect(registration.result.status).toBe(64);
    expect(registration.registrationAttempts).toBe(1);
    expect(registration.registerFlagExists).toBe(false);
  });

  it('bounds retries for a transient server error', () => {
    const registration = runRegistrationClient(503);

    expect(registration.result.status).toBe(75);
    expect(registration.registrationAttempts).toBe(2);
    expect(registration.registerFlagExists).toBe(false);
  });

  it('defers registration until the terminal runtime is ready', () => {
    const registration = runRegistrationClient(200, '', '2099-01-01T00:00:00.000Z', false);

    expect(registration.result.status).toBe(75);
    expect(registration.registrationAttempts).toBe(0);
    expect(registration.registerFlagExists).toBe(false);
  });

  it('stops retrying after an operator verifies the running machine', () => {
    const registration = runRegistrationClient(
      503,
      '',
      '2099-01-01T00:00:00.000Z',
      true,
      true,
    );

    expect(registration.result.status, registration.result.stderr).toBe(0);
    expect(registration.registrationAttempts).toBe(1);
    expect(registration.registerFlagExists).toBe(true);
  });

  it('stops service retries after the registration deadline', () => {
    const registration = runRegistrationClient(503, '', '2020-01-01T00:00:00.000Z');

    expect(registration.result.status).toBe(64);
    expect(registration.registrationAttempts).toBe(0);
    expect(registration.registerFlagExists).toBe(false);
  });
});


describe('optional developer tools never gate core registration', () => {
  it.each([
    { name: 'default four selected tools without receipts', developerTools: null, toolState: 'missing' },
    { name: 'selected tool not yet installed', developerTools: 'pi', toolState: 'missing' },
    { name: 'selected tool installer in progress', developerTools: 'pi', toolState: 'installing' },
    { name: 'selected tool installer failed', developerTools: 'pi', toolState: 'failed' },
    { name: 'selected tool installed', developerTools: 'pi', toolState: 'installed' },
  ] as const)('registers a healthy core with $name', options => {
    const registration = runRegistrationClient(200, '', '2099-01-01T00:00:00.000Z', true, false, options);
    expect(registration.result.status, registration.result.stderr).toBe(0);
    expect(registration.registrationAttempts).toBe(1);
    expect(registration.registerFlagExists).toBe(true);
    expect(registration.installerStillRunning).toBe(options.toolState === 'installing');
  });

  it.each([
    { name: 'unhealthy gateway', gatewayReady: false, runtimeReady: true, authToken: 'test-auth-token' },
    { name: 'unhealthy terminal', gatewayReady: true, runtimeReady: false, authToken: 'test-auth-token' },
    { name: 'missing terminal authentication', gatewayReady: true, runtimeReady: true, authToken: '' },
  ])('still defers for $name regardless of optional tool progress', options => {
    const registration = runRegistrationClient(200, '', '2099-01-01T00:00:00.000Z', options.runtimeReady, false,
      { ...options, developerTools: 'pi', toolState: 'installing' });
    expect(registration.result.status).toBe(75);
    expect(registration.registrationAttempts).toBe(0);
    expect(registration.registerFlagExists).toBe(false);
    expect(registration.installerStillRunning).toBe(true);
  });
});
