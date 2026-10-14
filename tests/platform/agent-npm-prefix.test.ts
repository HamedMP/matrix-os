import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readlink, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-npm-prefix-'));
  directories.push(root);
  const home = join(root, 'owner');
  const hermes = join(home, '.hermes');
  const prefix = join(root, 'managed-node');
  await Promise.all([mkdir(join(home, '.local/bin'), { recursive: true }), mkdir(join(hermes, 'node/etc'), { recursive: true }), mkdir(join(prefix, 'etc'), { recursive: true }), mkdir(join(prefix, 'bin'), { recursive: true })]);
  const command = join(prefix, 'bin/codex');
  await writeFile(command, '#!/bin/sh\nprintf "codex-cli 0.162.1\\n"\n');
  await chmod(command, 0o755);
  const local = join(home, '.local/bin/codex');
  const run = () => spawnSync(process.execPath, [resolve('scripts/reconcile-agent-npm-prefix.mjs')], {
    encoding: 'utf8', env: { ...process.env, MATRIX_RUNTIME_HOME: home, HERMES_HOME: hermes, MATRIX_NODE_PREFIX: prefix }, timeout: 5_000,
  });
  return { root, home, hermes, prefix, command, local, run };
}

describe('managed agent npm ownership', () => {
  it('repairs Hermes npm prefix while preserving runtime config, tools and unrelated options', async () => {
    const f = await fixture();
    await writeFile(join(f.hermes, 'node/etc/npmrc'), `# upstream\nprefix=${f.home}/.local\nfund=false\n`);
    await writeFile(join(f.prefix, 'etc/npmrc'), 'audit=false\nprefix=/old\n');
    for (const cli of ['node', 'npm', 'npx']) await symlink(join(f.hermes, 'node/bin', cli), join(f.home, '.local/bin', cli));
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(f.hermes, 'node/etc/npmrc'), 'utf8')).toBe(`# upstream\nfund=false\nprefix=${f.prefix}\n`);
    expect(await readFile(join(f.prefix, 'etc/npmrc'), 'utf8')).toBe('audit=false\nprefix=/old\n');
    for (const cli of ['node', 'npm', 'npx']) expect(await readlink(join(f.home, '.local/bin', cli))).toBe(join(f.hermes, 'node/bin', cli));
    expect(f.run().status).toBe(0);
    expect(await readFile(join(f.prefix, 'etc/npmrc'), 'utf8')).toBe('audit=false\nprefix=/old\n');
  });

  it.each(['relative', 'absolute'])('redirects the recognized %s npm Codex shim, including stale shell hashes', async kind => {
    const f = await fixture();
    const target = kind === 'relative' ? '../lib/node_modules/@openai/codex/bin/codex.js' : join(f.home, '.local/lib/node_modules/@openai/codex/bin/codex.js');
    await symlink(target, f.local);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(await readlink(f.local)).toBe(f.command);
    expect(spawnSync(f.local, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('codex-cli 0.162.1');
  });

  it('preserves a custom command and owner-level npm overrides', async () => {
    const f = await fixture();
    await writeFile(f.local, '# custom codex\n');
    await writeFile(join(f.home, '.npmrc'), 'prefix=/owner-choice\n');
    expect(f.run().status).toBe(0);
    expect(await readFile(f.local, 'utf8')).toBe('# custom codex\n');
    expect(await readFile(join(f.home, '.npmrc'), 'utf8')).toBe('prefix=/owner-choice\n');
  });

  it('preserves unrelated command symlinks', async () => {
    const f = await fixture();
    await symlink('/owner/tools/custom-codex', f.local);
    expect(f.run().status).toBe(0);
    expect(await readlink(f.local)).toBe('/owner/tools/custom-codex');
  });

  it('does not create an absent Hermes install', async () => {
    const f = await fixture();
    await rm(f.hermes, { recursive: true });
    expect(f.run().status).toBe(0);
    await expect(readFile(join(f.hermes, 'node/etc/npmrc'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('repairs legacy Hermes without writing a read-only runtime prefix', async () => {
    const f = await fixture();
    await rm(join(f.prefix, 'etc'), { recursive: true });
    await chmod(f.prefix, 0o555);
    try {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(join(f.hermes, 'node/etc/npmrc'), 'utf8')).toBe(`prefix=${f.prefix}\n`);
      await expect(readFile(join(f.prefix, 'etc/npmrc'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await chmod(f.prefix, 0o755); }
  });

  it('preserves an old shim when the managed executable is missing', async () => {
    const f = await fixture();
    await rm(f.command);
    const target = '../lib/node_modules/@openai/codex/bin/codex.js';
    await symlink(target, f.local);
    expect(f.run().status).toBe(0);
    expect(await readlink(f.local)).toBe(target);
  });

  it('rejects config symlinks without modifying their target', async () => {
    const f = await fixture();
    const target = join(f.root, 'owner-config');
    await writeFile(target, 'prefix=/personal\n');
    await symlink(target, join(f.hermes, 'node/etc/npmrc'));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(await readFile(target, 'utf8')).toBe('prefix=/personal\n');
  });
});
