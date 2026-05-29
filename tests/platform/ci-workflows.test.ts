import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('CI workflows', () => {
  it('exposes a stable aggregate CI result job for branch protection', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toContain('ci-results:');
    expect(workflow).toContain('name: CI Results');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('needs: [changes, typecheck, patterns, sync-client, unit, e2e]');
    expect(workflow).toContain('### CI Results');
    expect(workflow).toContain('needs.typecheck.result');
    expect(workflow).toContain('needs.patterns.result');
    expect(workflow).toContain('needs.sync-client.result');
    expect(workflow).toContain('needs.unit.result');
    expect(workflow).toContain('needs.e2e.result');
    expect(workflow).toContain('Branch protection should require this aggregate job');
  });

  it('documents workflow ownership and required checks', () => {
    const root = process.cwd();
    const readme = readFileSync(join(root, '.github/workflows/README.md'), 'utf8');

    expect(readme).toContain('# GitHub Actions Workflows');
    expect(readme).toContain('CI Results');
    expect(readme).toContain('branch protection');
    expect(readme).toContain('Host Bundle Release');
    expect(readme).toContain('host bundle release tests are blocking');
    expect(readme).toContain('Screenshots');
    expect(readme).toContain('explicitly optional');
  });
});
