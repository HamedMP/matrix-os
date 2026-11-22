import { describe, expect, it } from 'vitest';
import {
  buildOwnedMachineVerificationToken,
  buildPlatformVerificationToken,
  buildRuntimeAuthToken,
} from '../../packages/platform/src/platform-token.js';

const identity = { handle: 'alice', machineId: 'm-1', runtimeSlot: 'owned-0a1b2c3d' };

describe('owned machine runtime token', () => {
  it('never hands an owned machine the handle-wide token another runtime of the owner uses', () => {
    const owned = buildRuntimeAuthToken({ ...identity, substrate: 'owned', runtimeTokenEpoch: 1 }, 'secret');
    expect(owned).not.toBe(buildPlatformVerificationToken('alice', 'secret'));
    expect(buildRuntimeAuthToken({ ...identity, substrate: 'vps' }, 'secret'))
      .toBe(buildPlatformVerificationToken('alice', 'secret'));
  });

  it('changes when the epoch is bumped, so revocation invalidates it', () => {
    expect(buildOwnedMachineVerificationToken(identity, 'secret', 1))
      .not.toBe(buildOwnedMachineVerificationToken(identity, 'secret', 2));
    expect(buildOwnedMachineVerificationToken(identity, 'secret', 1))
      .not.toBe(buildOwnedMachineVerificationToken({ ...identity, machineId: 'm-2' }, 'secret', 1));
  });

  it('rejects invalid epochs', () => {
    expect(() => buildOwnedMachineVerificationToken(identity, 'secret', 0)).toThrow();
  });
});
