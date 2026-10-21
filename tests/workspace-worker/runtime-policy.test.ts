import { describe, expect, it } from 'vitest';
import { runtimePolicyFromEnvironment } from '../../packages/workspace-worker/src/runtime/contracts.js';

describe('native runtime lease configuration', () => {
  it('keeps a two minute cold-start lease independent of short heartbeat intervals', () => {
    expect(runtimePolicyFromEnvironment({RUNTIME_HEARTBEAT_MS:'5000'})).toMatchObject({heartbeatMs:5000,leaseMs:120000});
  });
  it('allows an explicit lease duration for measured runtime startup', () => {
    expect(runtimePolicyFromEnvironment({RUNTIME_HEARTBEAT_MS:'5000',RUNTIME_LEASE_MS:'180000'}).leaseMs).toBe(180000);
  });
});
