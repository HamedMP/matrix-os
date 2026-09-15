import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('snapshot restore account reconciliation', () => {
  it('adds Docker access explicitly for existing snapshot users before starting restore', () => {
    const source = readFileSync('distro/customer-vps/cloud-init.yaml', 'utf8');
    const reconcile = source.indexOf('usermod -aG docker matrix');
    expect(reconcile).toBeGreaterThan(-1);
    expect(reconcile).toBeLessThan(source.indexOf('systemctl start matrix-restore.service'));
    // Append, never replace the owner account’s other supplementary groups.
    expect(source).not.toMatch(/usermod -G docker matrix/);
  });
});
