import { describe, expect, it } from 'vitest';
import { ClientPolicySchema, compareClientVersions, evaluateClientPolicy } from '../../packages/contracts/src/client-policy';

const policy = { latestVersion: '2.10.0', minSupportedVersion: '2.2.0', downloadUrl: 'https://matrix-os.com/download', enforceAfter: '2026-09-01T00:00:00.000Z' };
describe('installed client compatibility', () => {
  it('compares numeric versions and prereleases without lexicographic mistakes', () => {
    expect(compareClientVersions('2.10.0', '2.9.0')).toBe(1);
    expect(compareClientVersions('2.2.0-beta.10', '2.2.0-beta.2')).toBe(1);
    expect(compareClientVersions('2.2.0-beta.1', '2.2.0')).toBe(-1);
    expect(compareClientVersions('2.2.0+build.1', '2.2.0+build.2')).toBe(0);
    expect(compareClientVersions('2.2.0-alpha', '2.2.0-alpha.1')).toBe(-1);
    expect(compareClientVersions('2.2.0-alpha.1', '2.2.0-alpha')).toBe(1);
    expect(compareClientVersions('2.2.0-2', '2.2.0-3')).toBe(-1);
    expect(compareClientVersions('2.2.0-2', '2.2.0-alpha')).toBe(-1);
    expect(compareClientVersions('2.2.0-beta', '2.2.0-alpha')).toBe(1);
    expect(compareClientVersions('2.2.0-alpha', '2.2.0-alpha')).toBe(0);
  });
  it('rejects malformed policies, unsafe URLs and minimums above latest', () => {
    for (const patch of [{ minSupportedVersion: '3.0.0' }, { downloadUrl: 'https://evil.example/download' }, { downloadUrl: 'https://[broken' }, { downloadUrl: 'javascript:alert(1)' }, { latestVersion: '01.2.3' }]) {
      expect(ClientPolicySchema.safeParse({ ...policy, ...patch }).success).toBe(false);
    }
  });
  it('allows bridge adoption before the deadline and requires upgrades afterward', () => {
    expect(evaluateClientPolicy(policy, '1.0.0', Date.parse('2026-08-28'))).toBe('recommended');
    expect(evaluateClientPolicy(policy, '1.0.0', Date.parse('2026-09-02'))).toBe('required');
    expect(evaluateClientPolicy(policy, '2.5.0', Date.parse('2026-09-02'))).toBe('recommended');
    expect(evaluateClientPolicy(policy, '2.10.0', Date.parse('2026-09-02'))).toBe('current');
    expect(evaluateClientPolicy(null, '1.0.0')).toBe('unknown');
    expect(evaluateClientPolicy(policy, 'broken')).toBe('unknown');
  });
});
