import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import { expect, it } from 'vitest';

it('cold provisioning prepares a private writable staging directory before updater startup', () => {
  const cloud = parseDocument(readFileSync(resolve('distro/customer-vps/cloud-init.yaml'), 'utf8')).toJSON();
  const script = (cloud.runcmd as unknown[]).find((entry): entry is string => typeof entry === 'string' && entry.includes('log_bootstrap_phase system_prerequisites_ready'))!;
  // Run the actual directory initialization block, never the network/service stages.
  const start = script.indexOf('    install -d -o root -g matrix -m 0770 /opt/matrix'.trimStart());
  const end = script.indexOf('    install -d -o matrix -g matrix -m 0755 /opt/matrix/messaging'.trimStart(), start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const rootPlaceholder = '__TEST_ROOT__';
  const privateDirectories = script.split('\n').filter(line => line.trim().startsWith('install -d -o matrix -g matrix -m 0750 ')).join('\n');
  const setup = (script.slice(start, end) + privateDirectories).replaceAll('/opt/matrix', rootPlaceholder).replaceAll('/home/matrix', rootPlaceholder + '/test-home').replaceAll('/var/lib/matrix', rootPlaceholder + '/test-var');
  const temp = mkdtempSync(join(tmpdir(), 'matrix-staging-bootstrap-'));
  const root = join(temp, 'matrix');
  try {
    // Map the VM's symbolic users to the current test user; filesystem effects
    // and modes still come from the real installer. No sudo or real /opt writes.
    const result = spawnSync('bash', ['-eu', '-c', `
install() {
  [ "$1" = -d ] && [ "$2" = -o ] && [ "$4" = -g ] && [ "$6" = -m ]
  owner="$3"; group="$5"; mode="$7"; shift 7
  for target in "$@"; do
    case "$target" in
      ${JSON.stringify(root)}|${JSON.stringify(root)}/*) ;;
      *) exit 91;;
    esac
    case "$target" in */staging) [ "$owner" = matrix ] && [ "$group" = matrix ];; esac
  done
  command /usr/bin/install -d -m "$mode" "$@"
}
${setup.replaceAll(rootPlaceholder, root)}
`], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(join(root, 'staging')).mode & 0o777).toBe(0o750);
    expect(statSync(root).mode & 0o777).toBe(0o770);
    expect(statSync(join(root, 'env')).mode & 0o777).toBe(0o750);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
