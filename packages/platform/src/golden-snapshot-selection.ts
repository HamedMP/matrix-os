import type { GoldenSnapshotState } from './golden-snapshot-schema.js';

export interface GoldenSnapshotSelectionTarget {
  targetBundleSha256: string;
  compatibilityKey: string;
  serverDiskGb: number;
  activationAbi: string;
}

export interface GoldenSnapshotSelectionCandidate {
  snapshotId: string;
  bundleVersion: string;
  bundleSha256: string;
  compatibilityKey: string;
  state: GoldenSnapshotState;
  minimumDiskGb: number;
  imageDiskGb: number | null;
  activationAbi: string;
  readyAt: string;
  revoked?: boolean;
}

function isCompatible(
  target: GoldenSnapshotSelectionTarget,
  candidate: GoldenSnapshotSelectionCandidate,
): boolean {
  const requiredDiskGb = Math.max(candidate.minimumDiskGb, candidate.imageDiskGb ?? 0);
  return candidate.state === 'ready'
    && candidate.revoked !== true
    && candidate.compatibilityKey === target.compatibilityKey
    && candidate.activationAbi === target.activationAbi
    && requiredDiskGb <= target.serverDiskGb;
}

export function chooseGoldenSnapshot(
  target: GoldenSnapshotSelectionTarget,
  candidates: readonly GoldenSnapshotSelectionCandidate[],
): GoldenSnapshotSelectionCandidate | undefined {
  const eligible = candidates.filter((candidate) => isCompatible(target, candidate));
  const exact = eligible
    .filter((candidate) => candidate.bundleSha256 === target.targetBundleSha256)
    .toSorted((left, right) => right.readyAt.localeCompare(left.readyAt));
  return exact[0];
}
