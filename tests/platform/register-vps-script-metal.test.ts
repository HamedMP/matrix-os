import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The guest registration client on a metal VM (spec 2691, ENG-520). Metal
 * guests have no Hetzner metadata service, so the client must send the metal
 * variant from host.env instead of failing on the metadata calls. Faults
 * detected: a metal guest that never registers, a payload the platform schema
 * rejects, and an env value that can inject JSON.
 */

const MACHINE_ID = '6a0c4f8e-3b1d-4f2a-9c7e-1d2b3c4d5e6f';

function runClient(env: Record<string, string>) {
  const root = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'matrix-register-vps-metal-'));
  const fakeBin = join(tempDir, 'bin');
  const callLog = join(tempDir, 'calls.log');
  const payloadLog = join(tempDir, 'payload.json');
  try {
    mkdirSync(fakeBin);
    const curlPath = join(fakeBin, 'curl');
    writeFileSync(curlPath, `#!/usr/bin/env bash
set -euo pipefail
output_path=''
data=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output' ]; then output_path="$argument"; fi
  if [ "$previous" = '--data' ]; then data="$argument"; fi
  previous="$argument"
done
case "$*" in
  *gateway-health*) exit 0 ;;
  *api/terminal/health*) exit 0 ;;
  *metadata/instance-id*) printf 'metadata\\n' >> "$FAKE_CALL_LOG"; printf '163944713' ;;
  *metadata/public-ipv4*) printf 'metadata\\n' >> "$FAKE_CALL_LOG"; printf '203.0.113.10' ;;
  *vps/register*)
    printf 'register\\n' >> "$FAKE_CALL_LOG"
    printf '%s' "$data" > "$FAKE_PAYLOAD_LOG"
    if [ -n "$output_path" ]; then printf '{}' > "$output_path"; fi
    printf '200'
    ;;
  *) exit 1 ;;
esac
`);
    chmodSync(curlPath, 0o755);
    const sleepPath = join(fakeBin, 'sleep');
    writeFileSync(sleepPath, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(sleepPath, 0o755);

    const result = spawnSync('bash', [join(root, 'distro/customer-vps/host-bin/matrix-register-vps')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_CALL_LOG: callLog,
        FAKE_PAYLOAD_LOG: payloadLog,
        MATRIX_MACHINE_ID: MACHINE_ID,
        MATRIX_IMAGE_VERSION: 'matrix-os-host-2026.11.20-1',
        MATRIX_AUTH_TOKEN: 'test-auth-token',
        MATRIX_DEVELOPER_TOOLS: '',
        MATRIX_GATEWAY_HEALTH_URL: 'https://gateway-health.test/health',
        MATRIX_PLATFORM_REGISTER_URL: 'https://platform.example.test/vps/register',
        MATRIX_REGISTRATION_TOKEN: 'test-token',
        MATRIX_REGISTRATION_TOKEN_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
        MATRIX_REGISTER_FLAG: join(tempDir, 'register-complete'),
        MATRIX_REGISTER_LOCK: join(tempDir, 'register.lock'),
        MATRIX_REGISTRATION_MAX_ATTEMPTS: '1',
        ...env,
      },
    });
    const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : [];
    const payload = existsSync(payloadLog) ? JSON.parse(readFileSync(payloadLog, 'utf8')) as unknown : undefined;
    return { result, calls, payload };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('matrix-register-vps on metal', () => {
  it('register script sends the metal variant when MATRIX_SERVER_PROVIDER=metal', () => {
    const run = runClient({ MATRIX_SERVER_PROVIDER: 'metal', MATRIX_SERVER_REF: MACHINE_ID });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.calls).toEqual(['register']);
    expect(run.payload).toEqual({
      provider: 'metal',
      machineId: MACHINE_ID,
      serverRef: MACHINE_ID,
      imageVersion: 'matrix-os-host-2026.11.20-1',
    });
  });

  it('includes the bundle digest and health on metal when a target bundle is pinned', () => {
    const run = runClient({
      MATRIX_SERVER_PROVIDER: 'metal',
      MATRIX_SERVER_REF: MACHINE_ID,
      MATRIX_TARGET_BUNDLE_SHA256: 'a'.repeat(64),
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.payload).toEqual({
      provider: 'metal',
      machineId: MACHINE_ID,
      serverRef: MACHINE_ID,
      imageVersion: 'matrix-os-host-2026.11.20-1',
      bundleSha256: 'a'.repeat(64),
      healthy: true,
    });
  });

  it.each([
    ['missing', ''],
    ['able to inject JSON', 'x","provider":"hetzner'],
  ])('refuses to register when the server ref is %s', (_name, serverRef) => {
    const run = runClient({ MATRIX_SERVER_PROVIDER: 'metal', MATRIX_SERVER_REF: serverRef });

    expect(run.result.status).toBe(64);
    expect(run.calls).toEqual([]);
  });

  it('refuses an unknown provider', () => {
    const run = runClient({ MATRIX_SERVER_PROVIDER: 'aws', MATRIX_SERVER_REF: MACHINE_ID });

    expect(run.result.status).toBe(64);
    expect(run.calls).toEqual([]);
  });

  it('keeps the Hetzner payload when no provider is set', () => {
    const run = runClient({});

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.calls).toEqual(['metadata', 'metadata', 'register']);
    expect(run.payload).toEqual({
      machineId: MACHINE_ID,
      hetznerServerId: 163944713,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.11.20-1',
    });
  });
});
