import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PreviewSnapshotUnavailableError,
  logCustomerVpsError,
} from '../../packages/platform/src/customer-vps-errors.js';

describe('customer VPS error logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps preview snapshot diagnostics server-only while logging the bounded reason', () => {
    const error = new PreviewSnapshotUnavailableError('persisted_bundle_digest_mismatch');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(error.publicMessage).toBe('Provisioning image unavailable');
    expect(error.message).toBe('Provisioning image unavailable');

    logCustomerVpsError('provisioning job failed machineId=test-machine', error);

    expect(consoleError).toHaveBeenCalledWith(
      '[customer-vps] provisioning job failed machineId=test-machine: '
      + 'Provisioning image unavailable internalReason=persisted_bundle_digest_mismatch',
    );
  });
});
