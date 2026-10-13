import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Keep source contracts together to avoid a worker/module setup per small suite.
describe("golden-snapshot-dev-gate", () => {
  describe('golden snapshot developer gate', () => {
    it('runs only the explicit customer VPS contract suites needed by snapshot provisioning', async () => {
      const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      };
      const command = packageJson.scripts['test:golden-snapshots'];
      expect(command).not.toContain('tests/platform/customer-vps*.test.ts');
      expect(command).toContain('tests/platform/customer-vps.test.ts');
      expect(command).toContain('tests/platform/customer-vps-cloud-init.test.ts');
      expect(command).toContain('tests/platform/customer-vps-hetzner.test.ts');
      expect(command).toContain('tests/platform/customer-vps-host-bundle.test.ts');
      expect(command).toContain('tests/platform/golden-snapshot-*.test.ts');
      expect(command).toContain('tests/platform/r2-client.test.ts');
      expect(command).toContain('tests/platform/ci-workflows.test.ts');
      expect(command).toContain('--maxWorkers=1');
      expect(command).toContain('--no-file-parallelism');
    });

    it('leaves enough CI time for a completed unit shard to run post-job cleanup', async () => {
      const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
      const unitJob = workflow.slice(workflow.indexOf('\n  unit:'), workflow.indexOf('\n  docs-contract:'));
      const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(unitJob)?.[1]);
      // A floor, not an exact value. Main run 37587908679 reached the previous 30-minute
      // ceiling and cancelled shard 4 without a failing assertion, so keep enough bounded
      // headroom for normal runner variance and post-job cleanup.
      expect(timeout).toBeGreaterThanOrEqual(40);
    });
  });
});

describe("golden-snapshot-builder-wiring", () => {
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
      expect(service).toContain("'activation_terminal_runtime'");
    });

    it('reports prerequisite and user-state preflight failures separately', async () => {
      const [activation, service] = await Promise.all([
        readFile('distro/customer-vps/host-bin/matrix-golden-snapshot-activate', 'utf8'),
        readFile('packages/platform/src/golden-snapshot-service.ts', 'utf8'),
      ]);

      for (const stage of [
        'activation_preflight_host_prerequisites',
        'activation_preflight_user_state',
      ]) {
        expect(activation).toContain(`set_activation_stage ${stage}`);
        expect(service).toContain(`'${stage}'`);
        expect(service).toContain(`|${stage}`);
      }
    });
  });
});
