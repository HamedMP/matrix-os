import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

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
    expect(unitJob).toContain('timeout-minutes: 15');
  });
});
