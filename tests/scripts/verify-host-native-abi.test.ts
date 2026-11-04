import { describe, expect, it } from 'vitest';
import { exceedsCustomerGlibc, requiredGlibcVersions } from '../../scripts/verify-host-native-abi.mjs';

describe('customer host native ABI gate', () => {
  it('rejects the glibc 2.42 symbol requirement found in nima’s failed node-pty bundle', () => {
    const versionInfo = 'Name: GLIBC_2.34\nName: GLIBC_2.42\nName: GLIBC_2.2.5';
    expect(requiredGlibcVersions(versionInfo)).toEqual([[2, 34], [2, 42], [2, 2]]);
    expect(exceedsCustomerGlibc(versionInfo)).toBe(true);
  });

  it('accepts Ubuntu 24.04 compatible symbols and native modules without glibc symbols', () => {
    expect(exceedsCustomerGlibc('Name: GLIBC_2.39\nName: GLIBC_2.2.5')).toBe(false);
    expect(exceedsCustomerGlibc('No version information found in this file.')).toBe(false);
  });
});
