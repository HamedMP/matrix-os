import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
describe('trusted native experience Python boundary', () => {
  it('verifies exact guards, shared data, atomic root-bound writes and cleanup in Python subprocesses', () => {
    const result = execFileSync('/usr/bin/python3', ['-I', '-B', new URL('./browser-vps-native-experience.py', import.meta.url).pathname], { timeout: 10_000, maxBuffer: 16_384, encoding: 'utf8' });
    expect(result.trim()).toBe('Native experience boundary: 7 checks passed');
  });
});
