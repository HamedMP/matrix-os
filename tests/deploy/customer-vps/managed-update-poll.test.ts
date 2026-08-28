import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('managed host passive updates', () => {
  it('does not bypass platform canaries or support holds through a public channel', () => {
    const source = readFileSync('distro/customer-vps/host-bin/matrix-sync-agent', 'utf8');
    const check = source.slice(source.indexOf('check_for_update() {'), source.indexOf('# ── Apply update'));
    const result = spawnSync('bash', ['-c', `set -e\nlog() { :; }\nmanifest_url() { echo ignored; }\ncurl() { echo bypassed; exit 90; }\n${check}\ncheck_for_update`], { encoding: 'utf8', env: { ...process.env, MATRIX_MACHINE_ID: 'machine_test' } });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('bypassed');
  });
});
