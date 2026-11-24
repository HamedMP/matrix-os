import { describe, expect, it, vi } from 'vitest';
import { hasUnpaidVpsRecoveryCopy } from '../../packages/platform/src/unpaid-vps-retention-dependencies.js';

const owner = 'user_retention';
const prefixRoot = 'matrixos-sync';
const system = 'system/runtime-slots/extra/db';
const snapshot = `${system}/snapshots/2026-11-19T1200Z.dump`;

function storage(pointer = snapshot) {
  return {
    headObject: vi.fn().mockResolvedValueOnce({ exists: false }).mockResolvedValue({ exists: true }),
    getObject: vi.fn().mockResolvedValue({ body: new Response(pointer).body, contentLength: pointer.length }),
    hasObjectUnderPrefix: vi.fn().mockResolvedValue(true),
  };
}

describe('VPS retention recovery copy', () => {
  it('finds a generation manifest and verifies the exact slot snapshot object', async () => {
    const r2 = storage();
    await expect(hasUnpaidVpsRecoveryCopy({ r2, prefixRoot }, owner, 'extra')).resolves.toBe(true);
    expect(r2.hasObjectUnderPrefix).toHaveBeenCalledWith('matrixos-sync/v2/owners/user_retention/runtimes/extra/manifests/');
    expect(r2.getObject).toHaveBeenCalledWith(`${prefixRoot}/${owner}/${system}/latest`, expect.anything());
    expect(r2.headObject).toHaveBeenLastCalledWith(`${prefixRoot}/${owner}/${snapshot}`, expect.anything());
  });

  it('rejects a valid snapshot path from another runtime slot', async () => {
    const r2 = storage('system/db/snapshots/2026-11-19T1200Z.dump');
    await expect(hasUnpaidVpsRecoveryCopy({ r2, prefixRoot }, owner, 'extra')).resolves.toBe(false);
    expect(r2.headObject).toHaveBeenCalledOnce();
  });

  it('rejects a valid pointer when the actual snapshot is gone', async () => {
    const r2 = storage();
    r2.headObject.mockResolvedValue({ exists: false });
    await expect(hasUnpaidVpsRecoveryCopy({ r2, prefixRoot }, owner, 'extra')).resolves.toBe(false);
  });
});
