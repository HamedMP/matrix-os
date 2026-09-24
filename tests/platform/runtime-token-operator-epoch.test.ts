import { describe, expect, it } from 'vitest';
import { targetRuntimeTokenEpoch } from '../../scripts/ops/runtime-token-epoch.mjs';

describe('runtime-token operator target epoch', () => {
  it('prepares the next epoch before activation', () => {
    expect(targetRuntimeTokenEpoch(1, 'prepare')).toBe(2);
  });
  it('recovers the current database epoch when host installation lags', () => {
    expect(targetRuntimeTokenEpoch(2, 'prepare-recovery', 1)).toBe(2);
    expect(() => targetRuntimeTokenEpoch(2, 'prepare-recovery', 2)).toThrow();
    expect(() => targetRuntimeTokenEpoch(3, 'prepare-recovery', 1)).toThrow();
  });
});
