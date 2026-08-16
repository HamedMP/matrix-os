export function resolveReleaseSnapshotEligibility(channel, explicitValue) {
  if (explicitValue !== undefined) {
    if (explicitValue !== 'true' && explicitValue !== 'false') {
      throw new Error('GOLDEN_SNAPSHOT_ELIGIBLE must be true or false');
    }
    return explicitValue === 'true';
  }
  return channel === 'stable';
}
