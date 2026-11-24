import { describe, expect, it, vi } from 'vitest';
import { hasUnpaidVpsRecoveryCopy } from '../../packages/platform/src/unpaid-vps-retention-dependencies.js';

const owner = 'user_retention';
const prefixRoot = 'matrixos-sync';
const system = 'system/runtime-slots/extra/db';
const snapshot = `${system}/snapshots/2026-11-19T1200Z.dump`;
const syncedAt = new Date('2026-11-19T12:01:00Z');
const freshness = {
  earliest: new Date('2026-11-19T00:00:00Z'),
  databaseEarliest: new Date('2026-11-19T11:00:00Z'),
  latest: new Date('2026-11-19T13:00:00Z'),
};

function storage(pointer = snapshot) {
  const stored = { exists: true, lastModified: syncedAt, contentLength: 128 };
  return {
    headObject: vi.fn().mockResolvedValueOnce({ exists: false }).mockResolvedValue(stored),
    getObject: vi.fn().mockResolvedValue({ body: new Response(pointer).body, contentLength: pointer.length }),
    hasRecentObjectUnderPrefix: vi.fn().mockResolvedValue(true),
  };
}

describe('VPS retention recovery copy', () => {
  it('finds a generation manifest and verifies the exact slot snapshot object', async () => {
    const r2 = storage();
    await expect(hasUnpaidVpsRecoveryCopy({ r2, prefixRoot }, owner, 'extra', freshness)).resolves.toBe(true);
    expect(r2.hasRecentObjectUnderPrefix).toHaveBeenCalledWith(
      'matrixos-sync/v2/owners/user_retention/runtimes/extra/manifests/',
      expect.objectContaining({ earliest: freshness.earliest, latest: freshness.latest }),
    );
    expect(r2.getObject).toHaveBeenCalledWith(`${prefixRoot}/${owner}/${system}/latest`, expect.anything());
    expect(r2.headObject).toHaveBeenLastCalledWith(`${prefixRoot}/${owner}/${snapshot}`, expect.anything());
  });

  it('rejects a valid snapshot path from another runtime slot', async () => {
    const r2 = storage('system/db/snapshots/2026-11-19T1200Z.dump');
    await expect(hasUnpaidVpsRecoveryCopy({ r2, prefixRoot }, owner, 'extra', freshness)).resolves.toBe(false);
    expect(r2.headObject).toHaveBeenCalledTimes(1);
  });

  it('rejects a newly uploaded object when its database snapshot is stale', async () => {
    const r2 = storage(`${system}/snapshots/2026-11-10T1200Z.dump`);
    await expect(hasUnpaidVpsRecoveryCopy({ r2, prefixRoot }, owner, 'extra', freshness)).resolves.toBe(false);
  });

  it('rejects an old home manifest with no recent generation', async () => {
    const r2 = storage();
    r2.headObject.mockReset().mockResolvedValue({ exists: true, lastModified: new Date('2026-11-01T12:00:00Z'), contentLength: 128 });
    r2.hasRecentObjectUnderPrefix.mockResolvedValue(false);
    await expect(hasUnpaidVpsRecoveryCopy({ r2, prefixRoot }, owner, 'extra', freshness)).resolves.toBe(false);
  });

  it('rejects a valid pointer when the actual snapshot is gone', async () => {
    const r2 = storage();
    r2.headObject.mockResolvedValue({ exists: false });
    await expect(hasUnpaidVpsRecoveryCopy({ r2, prefixRoot }, owner, 'extra', freshness)).resolves.toBe(false);
  });
});
