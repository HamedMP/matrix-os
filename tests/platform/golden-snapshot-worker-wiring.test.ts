import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseGoldenSnapshotReconciliationInterval } from '../../packages/platform/src/platform-startup.js';

describe('golden snapshot worker wiring', () => {
  it('bounds the reconciliation timer to a safe interval', () => {
    expect(parseGoldenSnapshotReconciliationInterval(undefined)).toBe(15_000);
    expect(parseGoldenSnapshotReconciliationInterval('1000')).toBe(1_000);
    expect(parseGoldenSnapshotReconciliationInterval('3600000')).toBe(3_600_000);
    expect(parseGoldenSnapshotReconciliationInterval('999')).toBeUndefined();
    expect(parseGoldenSnapshotReconciliationInterval('2147483648')).toBeUndefined();
    expect(parseGoldenSnapshotReconciliationInterval('not-a-number')).toBeUndefined();
  });

  it('contains worker query failures inside the scheduled tick', async () => {
    const source = await readFile('packages/platform/src/platform-startup.ts', 'utf8');
    const worker = source.slice(
      source.indexOf('const runGoldenSnapshotWorker = async () => {'),
      source.indexOf('const reconciliationIntervalMs = Number'),
    );
    expect(worker).toContain("logPlatformRouteError('golden snapshot reconciliation', err)");
    expect(worker.indexOf('try {')).toBeLessThan(worker.indexOf('claimGoldenSnapshotBuildBatch'));
    expect(worker.indexOf('const retention = await enforceGoldenSnapshotRetention'))
      .toBeLessThan(worker.indexOf("logPlatformRouteError('golden snapshot reconciliation', err)"));
  });

  it('pauses build claims while keeping cleanup enabled when builds are disabled', async () => {
    const source = await readFile('packages/platform/src/platform-startup.ts', 'utf8');
    const worker = source.slice(
      source.indexOf('const runGoldenSnapshotWorker = async () => {'),
      source.indexOf('const reconciliationIntervalMs = Number'),
    );
    expect(worker).toMatch(
      /if \(goldenSnapshotConfig\.buildsEnabled\) \{[\s\S]*claimGoldenSnapshotBuildBatch[\s\S]*listRunnableGoldenSnapshotBuildIds[\s\S]*\}\n\s*const cleanup/,
    );
    expect(worker).toContain('goldenSnapshotConfig.maxConcurrentBuilds');
    expect(worker).not.toContain('listClaimableGoldenSnapshotBuildIds');
    expect(source).not.toContain(
      'if (goldenSnapshotConfig.buildsEnabled || goldenSnapshotConfig.enabled) {',
    );
    expect(worker.indexOf('listUnresolvedGoldenSnapshotBuildIds'))
      .toBeGreaterThan(worker.indexOf('if (goldenSnapshotConfig.buildsEnabled)'));
    expect(worker.indexOf('listCallbackWaitGoldenSnapshotBuildIds'))
      .toBeGreaterThan(worker.indexOf('listRunnableGoldenSnapshotBuildIds'));
    expect(worker.indexOf('listCallbackWaitGoldenSnapshotBuildIds'))
      .toBeLessThan(worker.indexOf('listUnresolvedGoldenSnapshotBuildIds'));
    expect(worker).toContain("err.code === 'snapshot_quota_exceeded'");
    expect(worker).toContain('quotaPressure = true');
    expect(worker).toContain('quotaPressure,');
  });

  it('claims builds through the transactionally enforced concurrent-infrastructure cap', async () => {
    const source = await readFile('packages/platform/src/platform-startup.ts', 'utf8');
    const worker = source.slice(
      source.indexOf('const runGoldenSnapshotWorker = async () => {'),
      source.indexOf('const reconciliationIntervalMs = Number'),
    );
    expect(worker).toContain('claimGoldenSnapshotBuildBatch(');
    expect(worker).toContain('goldenSnapshotConfig.maxConcurrentBuilds');
    expect(worker).not.toContain('listClaimableGoldenSnapshotBuildIds(');
  });

  it('reconciles durable base-generation revocations in bounded pages even when builds are disabled', async () => {
    const source = await readFile('packages/platform/src/platform-startup.ts', 'utf8');
    const worker = source.slice(
      source.indexOf('const runGoldenSnapshotWorker = async () => {'),
      source.indexOf('const reconciliationIntervalMs = Number'),
    );
    expect(worker).toContain('listRevokedGoldenSnapshotBaseGenerations');
    expect(worker).toContain('reconcileRevokedGoldenSnapshotBaseGeneration');
    expect(worker.indexOf('listRevokedGoldenSnapshotBaseGenerations'))
      .toBeLessThan(worker.indexOf('if (goldenSnapshotConfig.buildsEnabled)'));
    expect(worker.indexOf('listRevokedGoldenSnapshotBaseGenerations'))
      .toBeLessThan(worker.indexOf('reconcileMissingGoldenSnapshotBuilds'));
    expect(worker.indexOf('listRevokedGoldenSnapshotBaseGenerations'))
      .toBeLessThan(worker.indexOf('claimGoldenSnapshotBuildBatch'));
    expect(worker.indexOf('listRevokedGoldenSnapshotBaseGenerations'))
      .toBeLessThan(worker.indexOf('listUnresolvedGoldenSnapshotBuildIds'));
    expect(worker).toContain('goldenSnapshotConfig.reconciliationBatchSize');
  });

  it('mounts snapshot status routes before the generic bundle catch-all', async () => {
    const source = await readFile('packages/platform/src/main.ts', 'utf8');
    expect(source.indexOf('createGoldenSnapshotRoutes({'))
      .toBeLessThan(source.indexOf('createHostBundleRoutes({'));
  });
});
