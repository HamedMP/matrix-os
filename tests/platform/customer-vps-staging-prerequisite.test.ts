import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

// Detect a missing provisioning prerequisite before the unprivileged updater
// reaches its mkdir. Execute shipped directory commands; intercept privileged
// install ownership operations and all paths outside the disposable fixture.
function directorySetup(): string {
  const config = parseDocument(readFileSync('distro/customer-vps/cloud-init.yaml', 'utf8')).toJS();
  const bootstrap = config.runcmd.find((entry: unknown) => typeof entry === 'string'
    && entry.includes('log_bootstrap_phase system_prerequisites_ready')) as string;
  if (!bootstrap) throw new Error('Cloud-init bootstrap is missing');
  const serviceStart = bootstrap.indexOf('systemctl start --no-block matrix-hermes.service');
  if (serviceStart < 0) throw new Error('Service activation is missing');
  return bootstrap.slice(0, serviceStart).split('\n').filter(line =>
    line.startsWith('install -d -o root -g matrix -m 0770 /opt/matrix')
    || line.startsWith('install -d -o matrix -g matrix -m 0750 ')).join('\n');
}

function fixture(failStaging = false) {
  const root = mkdtempSync(join(tmpdir(), 'matrix-staging-contract-'));
  mkdirSync(join(root, 'opt/matrix'), { recursive: true, mode: 0o755 });
  // No live install/chown/chmod: record authority arguments, then materialize
  // only the requested directories below the task-owned fixture with Python.
  const wrapper = `set -eu
install() {
  printf '%s\\n' "$*" >> "$MATRIX_TEST_ROOT/calls"
  for arg in "$@"; do
    if [ "${failStaging ? 'true' : 'false'}" = true ] && [ "$arg" = /opt/matrix/staging ]; then return 41; fi
  done
  python3 -I - "$MATRIX_TEST_ROOT" "$@" <<'PY'
import os,sys
root=sys.argv[1]
args=sys.argv[2:]
assert args[0] == '-d' and args[1] == '-o' and args[3:6] == ['-g', 'matrix', '-m']
for path in args[7:]:
    assert path.startswith(('/opt/matrix', '/home/matrix', '/var/lib/matrix'))
    os.makedirs(root + path, mode=int(args[6], 8), exist_ok=True)
PY
}
${directorySetup()}
printf ready > "$MATRIX_TEST_ROOT/services-ready"
`;
  writeFileSync(join(root, 'directory-phase.sh'), wrapper);
  return { root, run: () => spawnSync('bash', [join(root, 'directory-phase.sh')], {
    env: { ...process.env, MATRIX_TEST_ROOT: root }, encoding: 'utf8', timeout: 10_000,
  }) };
}

describe('customer VPS updater staging prerequisite', () => {
  it('provisions private staging before starting services', () => {
    const { root, run } = fixture();
    try {
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      const entry = statSync(join(root, 'opt/matrix/staging'));
      expect(entry.isDirectory()).toBe(true);
      expect(entry.mode & 0o777).toBe(0o750);
      expect(readFileSync(join(root, 'calls'), 'utf8').split('\n').some(line => line.startsWith('-d -o matrix -g matrix -m 0750 ') && line.split(' ').includes('/opt/matrix/staging'))).toBe(true);
      expect(statSync(join(root, 'opt/matrix')).mode & 0o777).toBe(0o755);
      writeFileSync(join(root, 'opt/matrix/staging/update-probe'), 'fixture update state');
      expect(readFileSync(join(root, 'opt/matrix/staging/update-probe'), 'utf8')).toBe('fixture update state');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('aborts the directory phase if staging preparation fails', () => {
    const { root, run } = fixture(true);
    try {
      const result = run();
      expect(result.status, result.stderr).toBe(41);
      expect(() => statSync(join(root, 'services-ready'))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
