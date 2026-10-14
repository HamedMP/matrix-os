import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('managed Codex update recovery', () => {
  it('retries a failed post-install reconciliation even after the binary has upgraded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-update-retry-'));
    try {
      const opt = join(root, 'opt/matrix');
      const state = join(root, 'state');
      await Promise.all([mkdir(join(opt, 'bin'), { recursive: true }), mkdir(join(opt, 'runtime/node/bin'), { recursive: true }), mkdir(join(root, 'usr/local/bin'), { recursive: true }), mkdir(state), mkdir(join(root, 'test-bin'))]);
      // Keep the fixture from invoking real OS provisioning on minimal Linux.
      await writeFile(join(root, 'test-bin/zsh'), '#!/bin/sh\nexit 0\n');
      await chmod(join(root, 'test-bin/zsh'), 0o755);
      const version = join(root, 'version');
      const attempts = join(root, 'attempts');
      await writeFile(version, 'codex-cli 0.156.1\n');
      await writeFile(attempts, '0\n');
      await writeFile(join(state, 'installed-tools'), 'codex\n');
      const codex = join(opt, 'runtime/node/bin/codex');
      await writeFile(codex, '#!/bin/sh\ncat "$TEST_CODEX_VERSION"\n');
      await chmod(codex, 0o755);
      const pack = join(opt, 'bin/matrix-install-tool-pack');
      await writeFile(pack, `#!/bin/sh
count=$(cat "$TEST_CODEX_ATTEMPTS")
count=$((count + 1))
printf '%s\\n' "$count" > "$TEST_CODEX_ATTEMPTS"
printf 'codex-cli 0.162.1\\n' > "$TEST_CODEX_VERSION"
# Reproduce an installed binary followed by a failed npm-prefix migration.
[ "$count" -gt 1 ]
`);
      await chmod(pack, 0o755);
      const source = (await readFile('distro/customer-vps/host-bin/matrix-install-developer-tools', 'utf8')).replaceAll('/opt/matrix', opt).replaceAll('/usr/local/bin', join(root, 'usr/local/bin'));
      const script = join(root, 'install');
      await writeFile(script, source);
      const run = () => spawnSync('bash', [script, '--tools-only'], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, PATH: `${join(root, 'test-bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`, MATRIX_DEVELOPER_TOOLS: 'codex', MATRIX_DEVELOPER_TOOLS_STATE_DIR: state, TEST_CODEX_VERSION: version, TEST_CODEX_ATTEMPTS: attempts } });
      expect(run().status).toBe(1);
      expect(await readFile(join(state, 'failed-tools'), 'utf8')).toBe('codex\n');
      const retry = run();
      expect(retry.status, retry.stderr).toBe(0);
      expect(await readFile(attempts, 'utf8')).toBe('2\n');
      expect(await readFile(join(state, 'failed-tools'), 'utf8')).toBe('');
      expect(await readFile(join(state, 'installed-tools'), 'utf8')).toBe('codex\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
