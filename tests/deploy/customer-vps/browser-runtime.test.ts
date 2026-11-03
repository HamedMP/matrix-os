import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('customer Browser lifecycle', () => {
  it('executes filesystem safety, activation rollback, credential and loopback health regressions', () => {
    const result = spawnSync('python3', ['-I', '-B', 'tests/deploy/customer-vps/browser-runtime.test.py'], {
      encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* tests/);
    expect(result.stderr).toMatch(/\nOK\s*$/);
  });

  it('executes the generated first-upgrade migration and tamper regressions', () => {
    const result = spawnSync('python3', ['-I', '-B', 'tests/deploy/customer-vps/browser-bootstrap.test.py'], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toMatch(/\nOK\s*$/);
  });

  it('root-executes only the isolated protected helper and retries without blocking core readiness', () => {
    const unit = readFileSync('distro/customer-vps/systemd/matrix-browser-runtime.service', 'utf8');
    expect(unit).toContain('ExecStart=/usr/bin/python3 -I /usr/local/libexec/matrix-browser-runtime.py');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('EnvironmentFile=');
    const cloud = readFileSync('distro/customer-vps/cloud-init.yaml', 'utf8');
    expect(cloud).toContain('matrix-browser-runtime.py:0644');
    expect(cloud.indexOf('systemctl enable --now --no-block matrix-browser-runtime.service')).toBeGreaterThan(cloud.indexOf('systemctl start matrix-gateway.service matrix-shell.service matrix-sync-agent.service'));
    const agent = readFileSync('distro/customer-vps/host-bin/matrix-sync-agent', 'utf8');
    const apply = agent.slice(agent.indexOf('apply_update() {'), agent.indexOf('\nrun_apply_update() {'));
    const scheduling = apply.indexOf('sudo systemctl restart --no-block matrix-browser-runtime.service');
    expect(scheduling).toBeGreaterThan(apply.indexOf('if [ "$healthy" = true ]; then'));
    expect(scheduling).toBeGreaterThan(apply.indexOf('if commit_release_metadata; then'));
    expect(agent).toContain('sudo flock -w 1800 /run/matrix-browser-runtime.lock /usr/bin/systemctl stop matrix-browser-runtime.service || return 1');
    expect(agent).toContain('record_update_file /usr/local/libexec/matrix-browser-runtime.py browser-helper');
    expect(agent).toContain('restore_update_file /usr/local/libexec/matrix-browser-runtime.py browser-helper');
    const helper = readFileSync('distro/customer-vps/host-bin/matrix-browser-runtime.py', 'utf8');
    expect(helper).not.toContain("'pip'");
    expect(helper).not.toContain('matrix-install-browser-preview');
    expect(helper).not.toContain('/home/matrix/home/apps');
  });

  it('reconciles the restored native payload only after rollback core health succeeds', () => {
    const recovery = readFileSync('distro/customer-vps/host-bin/matrix-sync-agent-recovery', 'utf8');
    const rollback = recovery.slice(recovery.indexOf('do_rollback() {'), recovery.indexOf('\n# These finalizers'));
    const scheduling = rollback.indexOf('sudo systemctl restart --no-block matrix-browser-runtime.service');
    expect(scheduling).toBeGreaterThan(rollback.indexOf('if [ "$healthy" = true ]; then'));
    expect(rollback).toContain('[ -f /usr/local/libexec/matrix-browser-runtime.py ]');
  });

  it.each(['regular', 'missing', 'symlink'] as const)('installs only a %s protected Browser helper with independent support-helper mode', state => {
    const cloud = readFileSync('distro/customer-vps/cloud-init.yaml', 'utf8');
    const block = cloud.match(/    for helper in matrix-support-access:0755 matrix-browser-runtime\.py:0644; do[\s\S]*?\n    done/);
    expect(block).not.toBeNull();
    const root = mkdtempSync(join(tmpdir(), 'browser-protected-helper-'));
    try {
      mkdirSync(join(root, 'bin'));
      writeFileSync(join(root, 'bin', 'matrix-support-access'), 'support helper');
      const browser = join(root, 'bin', 'matrix-browser-runtime.py');
      if (state === 'regular') writeFileSync(browser, 'browser helper');
      if (state === 'symlink') symlinkSync(join(root, 'bin', 'matrix-support-access'), browser);
      const script = block![0].replaceAll('/opt/matrix/bin/', '$TEST_ROOT/bin/').replaceAll('/usr/local/libexec', '$TEST_ROOT/libexec');
      const result = spawnSync('bash', ['-eu', '-c', `
install() { printf 'install %s\\n' "$*"; }
chmod() { printf 'chmod %s\\n' "$*"; }
${script}`], { encoding: 'utf8', env: { ...process.env, TEST_ROOT: root } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`install -o root -g root -m 0755 ${root}/bin/matrix-support-access ${root}/libexec/matrix-support-access`);
      if (state === 'regular') {
        expect(result.stdout).toContain(`install -o root -g root -m 0644 ${browser} ${root}/libexec/matrix-browser-runtime.py`);
        expect(result.stdout).toContain(`chmod 0644 ${browser}`);
      } else {
        expect(result.stdout).not.toContain('matrix-browser-runtime.py');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
