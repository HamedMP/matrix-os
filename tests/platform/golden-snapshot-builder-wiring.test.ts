import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('golden snapshot builder orchestration wiring', () => {
  it('keeps finalizer failure stages aligned with callback validation', async () => {
    const [cloudInit, service] = await Promise.all([
      readFile('distro/customer-vps/golden-snapshot-builder-cloud-init.yaml', 'utf8'),
      readFile('packages/platform/src/golden-snapshot-service.ts', 'utf8'),
    ]);

    for (const stage of ['cloud_final_wait', 'service_shutdown', 'finalizer_timeout']) {
      expect(cloudInit).toContain(
        stage === 'finalizer_timeout' ? 'failureStage=finalizer_timeout' : `failureStage='${stage}'`,
      );
      expect(service).toContain(`'${stage}'`);
    }
  });

  it('keeps validation activation timeout and stage evidence aligned', async () => {
    const [activation, service] = await Promise.all([
      readFile('distro/customer-vps/host-bin/matrix-golden-snapshot-activate', 'utf8'),
      readFile('packages/platform/src/golden-snapshot-service.ts', 'utf8'),
    ]);

    expect(activation).toContain('timeout --signal=KILL 300 docker pull postgres:16');
    expect(service).toContain(
      'timeout --kill-after=30 1200 /opt/matrix/bin/matrix-golden-snapshot-activate validation',
    );
    expect(service).toContain('/run/matrix-golden-activation-stage');
  });
});
