import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

describe('Symphony upgrade activation', () => {
  it('never starts or enables Symphony on fresh VPSes', async () => {
    const init = await readFile('distro/customer-vps/cloud-init.yaml', 'utf8');
    expect(init.split('\n').filter(line => /systemctl (start|enable)/.test(line)).join('\n')).not.toContain('matrix-symphony.service');
  });
  it('resumes only the service that was active before the update', async () => {
    const script = await readFile('distro/customer-vps/host-bin/matrix-sync-agent', 'utf8');
    const helper = script.match(/resume_symphony_after_update\(\) \{\n[\s\S]*?\n\}/)?.[0];
    expect(helper).toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), 'symphony-activation-'));
    try {
      for (const activity of ['active', 'inactive', '']) {
        await writeFile(join(dir, 'systemd.activity'), activity ? `matrix-symphony.service:${activity}\n` : '');
        const output = execFileSync('bash', ['-c', `${helper}\nlog() { :; }\nsudo() { echo "$*"; }\nresume_symphony_after_update`], {
          env: { ...process.env, UPDATE_TRANSACTION_DIR: dir }, encoding: 'utf8',
        });
        expect(output.includes('systemctl start --no-block matrix-symphony.service')).toBe(activity === 'active');
        expect(output).not.toContain('systemctl enable');
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('does not restart stopped Symphony during rollback', async () => {
    const recovery = await readFile('distro/customer-vps/host-bin/matrix-sync-agent-recovery', 'utf8');
    expect(recovery).not.toContain('sudo systemctl start --no-block matrix-symphony || true');
    expect(recovery).toContain('resume_symphony_after_update');
  });
  it('preserves the legacy project only when an owner credential is explicit', async () => {
    const script = await readFile('distro/customer-vps/host-bin/matrix-symphony', 'utf8');
    const guard = script.match(/legacy_linear_credential=[\s\S]*?unset legacy_linear_credential/)?.[0];
    expect(guard).toBeDefined();
    for (const credential of ['', ' ', 'owner-key']) {
      const output = execFileSync('bash', ['-c', `${guard}\nprintf '%s' "\${SYMPHONY_LINEAR_PROJECT_SLUG:-}"`], {
        env: { PATH: process.env.PATH, SYMPHONY_LINEAR_API_KEY: credential }, encoding: 'utf8',
      });
      expect(output).toBe(credential === 'owner-key' ? 'matrix-os' : '');
      expect(output).not.toContain('owner-key');
    }
  });

});
