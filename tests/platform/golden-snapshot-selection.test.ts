import { describe, expect, it } from 'vitest';
import {
  chooseGoldenSnapshot,
  type GoldenSnapshotSelectionCandidate,
} from '../../packages/platform/src/golden-snapshot-selection.js';

const compatibilityKey = 'a'.repeat(64);

function candidate(
  id: string,
  bundleSha256: string,
  sourceReleaseBuildTime: string,
  overrides: Partial<GoldenSnapshotSelectionCandidate> = {},
): GoldenSnapshotSelectionCandidate {
  return {
    snapshotId: id,
    bundleVersion: id,
    bundleSha256,
    compatibilityKey,
    sourceReleaseBuildTime,
    state: 'ready',
    minimumDiskGb: 40,
    imageDiskGb: 40,
    activationAbi: 'host-v1',
    readyAt: sourceReleaseBuildTime,
    ...overrides,
  };
}

describe('golden snapshot selection', () => {
  it('prefers exact immutable provenance over a compatible older image', () => {
    const selected = chooseGoldenSnapshot({
      targetBundleSha256: '2'.repeat(64),
      targetReleaseBuildTime: '2026-07-02T00:00:00.000Z',
      compatibilityKey,
      serverDiskGb: 80,
      activationAbi: 'host-v1',
    }, [
      candidate('older', '1'.repeat(64), '2026-07-01T00:00:00.000Z'),
      candidate('exact', '2'.repeat(64), '2026-06-20T00:00:00.000Z'),
    ]);
    expect(selected?.snapshotId).toBe('exact');
  });

  it('chooses the newest compatible older release and never a newer one', () => {
    const selected = chooseGoldenSnapshot({
      targetBundleSha256: '4'.repeat(64),
      targetReleaseBuildTime: '2026-07-03T00:00:00.000Z',
      compatibilityKey,
      serverDiskGb: 80,
      activationAbi: 'host-v1',
    }, [
      candidate('oldest', '1'.repeat(64), '2026-07-01T00:00:00.000Z'),
      candidate('older', '2'.repeat(64), '2026-07-02T00:00:00.000Z'),
      candidate('newer', '5'.repeat(64), '2026-07-04T00:00:00.000Z'),
    ]);
    expect(selected?.snapshotId).toBe('older');
  });

  it('rejects non-ready, incompatible, revoked, and too-large images', () => {
    const selected = chooseGoldenSnapshot({
      targetBundleSha256: '9'.repeat(64),
      targetReleaseBuildTime: '2026-07-10T00:00:00.000Z',
      compatibilityKey,
      serverDiskGb: 40,
      activationAbi: 'host-v1',
    }, [
      candidate('failed', '1'.repeat(64), '2026-07-01T00:00:00.000Z', { state: 'failed' }),
      candidate('wrong-key', '2'.repeat(64), '2026-07-02T00:00:00.000Z', { compatibilityKey: 'b'.repeat(64) }),
      candidate('wrong-abi', '3'.repeat(64), '2026-07-03T00:00:00.000Z', { activationAbi: 'host-v2' }),
      candidate('too-large', '4'.repeat(64), '2026-07-04T00:00:00.000Z', { imageDiskGb: 80 }),
      candidate('revoked', '5'.repeat(64), '2026-07-05T00:00:00.000Z', { revoked: true }),
    ]);
    expect(selected).toBeUndefined();
  });

  it('orders compatible snapshots by immutable build provenance, not registration time', () => {
    const selected = chooseGoldenSnapshot({
      targetBundleSha256: '1'.repeat(64),
      targetReleaseBuildTime: '2026-07-01T00:00:00.000Z',
      compatibilityKey,
      serverDiskGb: 80,
      activationAbi: 'host-v1',
    }, [candidate('newer-registered-first', '2'.repeat(64), '2026-07-02T00:00:00.000Z')]);
    expect(selected).toBeUndefined();
  });

  it('compares release build times as instants across timezone offsets', () => {
    const selected = chooseGoldenSnapshot({
      targetBundleSha256: '9'.repeat(64),
      targetReleaseBuildTime: '2026-07-03T00:00:00.000Z',
      compatibilityKey,
      serverDiskGb: 80,
      activationAbi: 'host-v1',
    }, [
      candidate('actually-newer', '1'.repeat(64), '2026-07-02T23:30:00.000-02:00'),
      candidate('actually-older', '2'.repeat(64), '2026-07-03T01:00:00.000+02:00'),
    ]);

    expect(selected?.snapshotId).toBe('actually-older');
  });
});
