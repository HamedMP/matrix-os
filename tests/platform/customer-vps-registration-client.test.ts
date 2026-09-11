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
  *gateway-health*) exit 0 ;;
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

    const result = spawnSync(
      'bash',
      [join(root, 'distro/customer-vps/host-bin/matrix-register-vps')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          FAKE_CURL_LOG: curlLog,
          FAKE_REGISTER_STATUS: String(registerStatus),
          FAKE_FAILURE_CODE: failureCode,
          FAKE_RUNTIME_READY: String(runtimeReady),
          FAKE_OPERATOR_VERIFIES: String(operatorVerifies),
          MATRIX_MACHINE_ID: '1d4848b6-b0f8-449c-8bf2-267ee9ae3ed1',
          MATRIX_IMAGE_VERSION: 'test-version',
          MATRIX_AUTH_TOKEN: 'test-auth-token',
          MATRIX_DEVELOPER_TOOLS: '',
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
