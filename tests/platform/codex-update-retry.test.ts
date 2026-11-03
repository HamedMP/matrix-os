import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CODEX_VERIFIED_VERSION } from '../../packages/contracts/src/index.js';

describe('managed Codex update recovery', () => {
  it.each([[CODEX_VERIFIED_VERSION, true, false], ['0.163.0', true, false], ['0.163.0', false, false], ['0.163.0', true, true]] as const)('recovers %s without reinstall: recorded=%s custom global=%s', async (installedVersion, recorded, customGlobal) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-update-retry-'));
    try {
      const opt = join(root, 'opt/matrix');
      const state = join(root, 'state');
      const home = join(root, 'owner');
      const prefix = join(opt, 'runtime/node');
      const app = join(opt, 'app');
      const hermesConfig = join(home, '.hermes/node/etc/npmrc');
      const local = join(home, '.local/bin/codex');
      const previous = '../lib/node_modules/@openai/codex/bin/codex.js';
      await Promise.all(['bin', 'runtime/node/bin', 'runtime/node/lib/node_modules', 'app/scripts'].map(p => mkdir(join(opt, p), { recursive: true })));
      await Promise.all([mkdir(join(home, '.hermes/node/etc'), { recursive: true }), mkdir(join(home, '.local/bin'), { recursive: true }), mkdir(join(root, 'usr/local/bin'), { recursive: true }), mkdir(state), mkdir(join(root, 'test-bin'))]);
      await writeFile(join(root, 'test-bin/zsh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await symlink(process.execPath, join(prefix, 'bin/node'));
      await writeFile(join(app, 'scripts/reconcile-agent-npm-prefix.mjs'), await readFile('scripts/reconcile-agent-npm-prefix.mjs'));
      const untouched = join(root, 'owner-choice');
      await writeFile(untouched, 'owner setting\n');
      await symlink(untouched, hermesConfig); // Required repair fails safely after npm has installed.
      await symlink(previous, local);
      const codex = join(prefix, 'bin/codex');
      const attempts = join(root, 'npm-attempts');
      const finalizers = join(root, 'finalizers');
      await writeFile(finalizers, '');
      await mkdir(join(app, 'skills/matrix'), { recursive: true });
      await writeFile(join(app, 'scripts/sync-matrix-agent-skills.sh'), '#!/bin/sh\nprintf "skills\\n" >> "$TEST_CODEX_FINALIZERS"\n', { mode: 0o755 });
      await writeFile(codex, '#!/bin/sh\nprintf "codex-cli 0.156.1\\n"\n', { mode: 0o755 });
      await writeFile(join(state, 'installed-tools'), recorded ? 'codex\n' : '');
      if (customGlobal) await writeFile(join(root, 'usr/local/bin/codex'), 'owner command\n', { mode: 0o755 });
      await writeFile(attempts, '');
      await writeFile(join(prefix, 'bin/npm'), `#!/bin/sh
printf 'install\\n' >> "$TEST_CODEX_ATTEMPTS"
printf '#!/bin/sh\\nprintf "codex-cli ${installedVersion}\\\\n"\\n' > "$MATRIX_NODE_PREFIX/bin/codex"
chmod +x "$MATRIX_NODE_PREFIX/bin/codex"
`, { mode: 0o755 });
      for (const name of ['matrix-install-developer-tools', 'matrix-install-tool-pack']) {
        const source = (await readFile(`distro/customer-vps/host-bin/${name}`, 'utf8'))
          .replaceAll('/opt/matrix', opt).replaceAll('/usr/local/bin', join(root, 'usr/local/bin'))
          .replaceAll('/tmp/matrix-tool-pack-', join(root, 'lock-'));
        await writeFile(join(opt, 'bin', name), source, { mode: 0o755 });
      }
      const run = () => spawnSync('bash', [join(opt, 'bin/matrix-install-developer-tools'), '--tools-only'], {
        encoding: 'utf8', timeout: 10_000, env: {
          PATH: `${join(root, 'test-bin')}:/usr/bin:/bin`, HOME: home,
          MATRIX_DEVELOPER_TOOLS: 'codex', MATRIX_DEVELOPER_TOOLS_STATE_DIR: state,
          MATRIX_NODE_PREFIX: prefix, MATRIX_RUNTIME_HOME: home, MATRIX_APP_DIR: app,
          MATRIX_RUNTIME_USER: userInfo().username, TEST_CODEX_ATTEMPTS: attempts, TEST_CODEX_FINALIZERS: finalizers,
        },
      });
      const initial = run();
      expect(initial.status, initial.stderr).toBe(1);
      expect(await readFile(join(state, 'failed-tools'), 'utf8')).toBe('codex\n');
      expect(await readFile(untouched, 'utf8')).toBe('owner setting\n');
      const failedRepair = run();
      expect(failedRepair.status, failedRepair.stderr).toBe(1);
      expect(await readFile(attempts, 'utf8')).toBe('install\n');
      expect(await readlink(local)).toBe(previous);
      expect(await readFile(finalizers, 'utf8')).toBe('');
      await rm(hermesConfig); // Remove fixture failure; the next real startup must repair.
      const retry = run();
      expect(retry.status, retry.stderr).toBe(0);
      expect(await readlink(local)).toBe(codex);
      if (customGlobal) expect(await readFile(join(root, 'usr/local/bin/codex'), 'utf8')).toBe('owner command\n');
      else expect(await readlink(join(root, 'usr/local/bin/codex'))).toBe(codex);
      expect((await stat(codex)).mode & 0o020).toBe(0o020);
      expect(await readFile(finalizers, 'utf8')).toBe('skills\n');
      expect(await readFile(hermesConfig, 'utf8')).toBe(`prefix=${prefix}\n`);
      expect(await readFile(attempts, 'utf8')).toBe('install\n');
      expect(spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`codex-cli ${installedVersion}`);
      expect(await readFile(join(state, 'failed-tools'), 'utf8')).toBe('');
      expect(await readFile(join(state, 'installed-tools'), 'utf8')).toBe('codex\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
