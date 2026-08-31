import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const source = readFileSync('distro/customer-vps/host-bin/matrix-sync-agent', 'utf8');
const check = source.slice(source.indexOf('check_for_update() {'), source.indexOf('# ── Apply update'));
function poll(policy: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail
log() { :; }
manifest_url() { echo https://platform.example/channel; }
curl() {
  if [[ "\${*: -1}" == */policy ]]; then
    echo policy-read >&2
    [ "\${POLICY_FAILURE:-0}" = 0 ] || return 22
    printf '%s' "$TEST_POLICY"
  else echo manifest; fi
}
export -f curl
json_field() { case "$2" in version) echo v2026.09.01-1;; severity) echo security;; esac; }
current_version() { echo v2026.08.01-1; }
compare_host_bundle_versions() { echo newer; }
write_prepared_update_marker() { echo prepared; }
run_apply_update() { echo applied; }
rm() { :; }
${check}
check_for_update`], { encoding: 'utf8', timeout: 5000, env: {
    ...process.env, BIN_DIR: resolve('distro/customer-vps/host-bin'), MATRIX_MACHINE_ID: 'machine_test',
    PLATFORM_INTERNAL_URL: 'https://platform.example', UPGRADE_TOKEN: 'test-token',
    TEST_POLICY: policy, AUTO_APPLY_FAILED_MARKER: '/dev/null', ...env,
  } });
}
describe('managed host passive updates', () => {
  it('keeps automatic security updates available before enrollment', () => {
    const result = poll('{"passiveUpdatesAllowed":true}');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('policy-read');
    expect(result.stdout).toContain('applied');
  });
  it('does not bypass enrolled canaries, paused rollouts or support holds', () => {
    const result = poll('{"passiveUpdatesAllowed":false}');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('prepared');
  });
  it.each(['{}', 'null', '[]', 'broken', '{"passiveUpdatesAllowed":"true"}', ' '.repeat(4097) + '{"passiveUpdatesAllowed":true}'])('defers on invalid or oversized policy', policy => {
    const result = poll(policy);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('prepared');
  });
  it.each([{ POLICY_FAILURE: '1' }, { UPGRADE_TOKEN: '' }, { MATRIX_MACHINE_ID: '../unsafe' }])('defers when policy cannot be fetched safely', env => {
    const result = poll('{"passiveUpdatesAllowed":true}', env);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('prepared');
  });
  it('allows loopback HTTP locally but rejects network HTTP before sending the machine bearer', () => {
    const local = poll('{"passiveUpdatesAllowed":true}', { PLATFORM_INTERNAL_URL: 'http://localhost:9000' });
    expect(local.stderr).toContain('policy-read');
    expect(local.stdout).toContain('applied');

    const network = poll('{"passiveUpdatesAllowed":true}', { PLATFORM_INTERNAL_URL: 'http://distro-platform-1:9000' });
    expect(network.stderr).not.toContain('policy-read');
    expect(network.stdout).not.toContain('applied');
  });
  it('preserves self-hosted channel polling without a machine policy request', () => {
    const result = poll('{}', { MATRIX_MACHINE_ID: '' });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('policy-read');
    expect(result.stdout).toContain('applied');
  });
});
