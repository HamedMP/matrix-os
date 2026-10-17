import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readlink, rm, chmod, stat, realpath } from 'node:fs/promises';
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
  await writeFile(command, '#!/bin/sh\nprintf "codex-cli 0.163.0\\n"\n');
  await chmod(command, 0o755);
  const local = join(home, '.local/bin/codex');
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve('scripts/reconcile-agent-npm-prefix.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, MATRIX_RUNTIME_HOME: home, HERMES_HOME: hermes, MATRIX_NODE_PREFIX: prefix }, timeout: 5_000,
  });
  return { root, home, hermes, prefix, command, local, run };
}

async function pmFixture() {
  const f = await fixture();
  await rm(join(f.hermes, 'node'), { recursive: true });
  const tools = join(f.hermes, 'tools');
  const node = join(tools, 'node-26.7.0-linux-x64');
  const npm = join(tools, 'npm-12.0.2-linux-x64');
  await Promise.all([mkdir(join(node, 'bin'), { recursive: true }), mkdir(join(npm, 'bin'), { recursive: true })]);
  await writeFile(join(node, 'bin/node'), `#!/bin/sh\nprintf '%s\\n' \"\${TEST_NPM_GLOBALCONFIG:-${await realpath(node)}/etc/npmrc}\"\n`);
  await writeFile(join(npm, 'bin/npm'), '// private npm fixture\n');
  await chmod(join(node, 'bin/node'), 0o755);
  const facts = { schema: 1, packages: { node: { entry: 'node-26.7.0-linux-x64' }, npm: { entry: 'npm-12.0.2-linux-x64' } } };
  await writeFile(join(tools, 'facts.json'), JSON.stringify(facts));
  return { ...f, tools, node, npm, facts, config: join(f.hermes, 'matrix-npm/npmrc') };
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
    expect(spawnSync(f.local, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('codex-cli 0.163.0');
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

  it('writes a default outside the digest-bound PM packages without rewriting tool links', async () => {
    const f = await pmFixture();
    await mkdir(join(f.hermes, 'matrix-npm'));
    const config = f.config;
    await writeFile(config, `# PM Node\nprefix=${f.home}/.local\nfund=false\n`);
    await chmod(config, 0o660);
    await mkdir(join(f.npm, 'etc'));
    await writeFile(join(f.npm, 'etc/npmrc'), '# separate npm package; not its global config\n');
    for (const [cli, entry] of [['node', f.node], ['npm', f.npm], ['npx', f.npm]]) {
      await symlink(join(entry!, 'bin', cli!), join(f.home, '.local/bin', cli!));
    }
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(config, 'utf8')).toBe(`# PM Node\nfund=false\nprefix=${f.prefix}\n`);
    await expect(stat(join(f.node, 'etc'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.run('--globalconfig').stdout.trim()).toBe(f.config);
    expect((await stat(config)).mode & 0o777).toBe(0o660);
    expect(await readFile(join(f.npm, 'etc/npmrc'), 'utf8')).toBe('# separate npm package; not its global config\n');
    expect(await readlink(join(f.home, '.local/bin/npm'))).toBe(join(f.npm, 'bin/npm'));
    await expect(stat(join(f.hermes, 'node'))).rejects.toMatchObject({ code: 'ENOENT' });
    const before = (await stat(config)).mtimeMs;
    expect(f.run().status).toBe(0);
    expect((await stat(config)).mtimeMs).toBe(before);
  });

  it('repairs coexisting legacy and PM defaults but leaves PM entries alone', async () => {
    const f = await pmFixture();
    await mkdir(join(f.hermes, 'node/etc'), { recursive: true });
    const old = join(f.tools, 'node-26.6.0-linux-x64/etc');
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'npmrc'), 'prefix=/previous\n');
    expect(f.run().status).toBe(0);
    for (const path of [join(f.hermes, 'node/etc/npmrc'), f.config]) {
      expect(await readFile(path, 'utf8')).toBe(`prefix=${f.prefix}\n`);
    }
    expect(await readFile(join(old, 'npmrc'), 'utf8')).toBe('prefix=/previous\n');
  });

  it.each(['../outside', '/outside', 'node-x/../../outside', 'npm-12.0.2-linux-x64'])('rejects a PM Node entry outside its allowed component: %s', async entry => {
    const f = await pmFixture();
    f.facts.packages.node.entry = entry;
    await writeFile(join(f.tools, 'facts.json'), JSON.stringify(f.facts));
    expect(f.run().status).not.toBe(0);
    await expect(stat(join(f.node, 'etc'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['{', JSON.stringify({ schema: 2, packages: {} }), ' '.repeat(65537)])('rejects malformed, unknown or oversized PM facts (%#)', async contents => {
    const f = await pmFixture();
    await writeFile(join(f.tools, 'facts.json'), contents);
    expect(f.run().status).not.toBe(0);
  });

  it('does not create PM state before Node is installed', async () => {
    const f = await pmFixture();
    await writeFile(join(f.tools, 'facts.json'), JSON.stringify({ schema: 1, packages: {} }));
    expect(f.run().status).toBe(0);
    await expect(stat(join(f.node, 'etc'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['tools', 'entry', 'config-directory', 'facts', 'config'])('rejects a symlinked PM %s without touching its target', async kind => {
    const f = await pmFixture();
    const target = join(f.root, 'outside');
    await mkdir(target);
    await writeFile(join(target, 'npmrc'), 'prefix=/owner-choice\n');
    const link = kind === 'tools' ? f.tools : kind === 'entry' ? f.node : kind === 'config-directory' ? join(f.hermes, 'matrix-npm') : kind === 'facts' ? join(f.tools, 'facts.json') : f.config;
    await rm(link, { recursive: true, force: true });
    await mkdir(resolve(link, '..'), { recursive: true });
    await symlink(kind === 'config' || kind === 'facts' ? join(target, 'npmrc') : target, link);
    expect(f.run().status).not.toBe(0);
    expect(await readFile(join(target, 'npmrc'), 'utf8')).toBe('prefix=/owner-choice\n');
  });

  it('preserves a pre-existing PM Node global config and its recorded facts', async () => {
    const f = await pmFixture();
    await mkdir(join(f.node, 'etc'));
    await writeFile(join(f.node, 'etc/npmrc'), 'fund=false\n');
    const facts = await readFile(join(f.tools, 'facts.json'), 'utf8');
    expect(f.run().status).toBe(0);
    expect(await readFile(join(f.node, 'etc/npmrc'), 'utf8')).toBe('fund=false\n');
    expect(await readFile(join(f.tools, 'facts.json'), 'utf8')).toBe(facts);
    expect(f.run('--globalconfig').stdout).toBe('');
  });

  it('does not mask an operator runtime global config with the PM default', async () => {
    const f = await pmFixture();
    await writeFile(join(f.prefix, 'etc/npmrc'), 'audit=false\n');
    expect(f.run().status).toBe(0);
    expect(f.run('--globalconfig').stdout).toBe('');
    expect(await readFile(join(f.prefix, 'etc/npmrc'), 'utf8')).toBe('audit=false\n');
  });

  it.each([
    { extra: {}, expected: 'default' },
    { extra: { npm_config_globalconfig: '/owner/global' }, expected: 'lower=/owner/global\nupper=UNSET\n' },
    { extra: { NPM_CONFIG_GLOBALCONFIG: '/owner/global' }, expected: 'lower=UNSET\nupper=/owner/global\n' },
    { extra: { npm_config_globalconfig: '' }, expected: 'lower=\nupper=UNSET\n' },
    { extra: { NPM_CONFIG_GLOBALCONFIG: '' }, expected: 'lower=UNSET\nupper=\n' },
    { extra: { TEST_NPM_GLOBALCONFIG: '/owner/from-npmrc' }, expected: 'lower=UNSET\nupper=UNSET\n' },
  ])('exports a PM-only default through the owner environment, preserving overrides (%#)', async ({ extra, expected }) => {
    const f = await pmFixture();
    expect(f.run().status).toBe(0);
    await symlink(process.execPath, join(f.prefix, 'bin/node'));
    const result = spawnSync('bash', ['-c', 'source "$OWNER_ENV"; matrix_export_owner_env; printf "lower=%s\\nupper=%s\\n" "${npm_config_globalconfig-UNSET}" "${NPM_CONFIG_GLOBALCONFIG-UNSET}"'], {
      encoding: 'utf8', timeout: 10_000,
      env: { PATH: '/usr/bin:/bin', MATRIX_HOME: f.home, HERMES_HOME: f.hermes, MATRIX_NODE_PREFIX: f.prefix, MATRIX_APP_DIR: process.cwd(), OWNER_ENV: resolve('distro/customer-vps/host-bin/matrix-owner-env'), ...extra },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expected === 'default' ? `lower=${f.config}\nupper=UNSET\n` : expected);
  });

  it('does not probe owner-writable runtimes in the root startup path', async () => {
    const f = await pmFixture();
    expect(f.run().status).toBe(0);
    await symlink(process.execPath, join(f.prefix, 'bin/node'));
    const marker = join(f.root, 'executed');
    await writeFile(join(f.node, 'bin/node'), `#!/bin/sh\ntouch '${marker}'\n`);
    // Substitute only Bash's read-only UID observation: no sudo/root execution.
    const ownerEnv = join(f.root, 'owner-env');
    await writeFile(ownerEnv, (await readFile('distro/customer-vps/host-bin/matrix-owner-env', 'utf8')).replaceAll('${EUID:-0}', '0'));
    const result = spawnSync('bash', ['-c', 'source "$OWNER_ENV"; matrix_export_owner_env'], {
      encoding: 'utf8', timeout: 10_000,
      env: { PATH: '/usr/bin:/bin', MATRIX_HOME: f.home, HERMES_HOME: f.hermes, MATRIX_NODE_PREFIX: f.prefix, MATRIX_APP_DIR: process.cwd(), OWNER_ENV: ownerEnv },
    });
    expect(result.status, result.stderr).toBe(0);
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const direct = spawnSync(process.execPath, ['--import', 'data:text/javascript,process.geteuid=()=>0', resolve('scripts/reconcile-agent-npm-prefix.mjs'), '--globalconfig'], {
      encoding: 'utf8', timeout: 5_000,
      env: { PATH: '/usr/bin:/bin', MATRIX_RUNTIME_HOME: f.home, HERMES_HOME: f.hermes, MATRIX_NODE_PREFIX: f.prefix },
    });
    expect(direct.status, direct.stderr).toBe(0);
    expect(direct.stdout).toBe('');
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects symlinked legacy config parents', async () => {
    const f = await fixture();
    const target = join(f.root, 'outside');
    await mkdir(target);
    await rm(join(f.hermes, 'node/etc'), { recursive: true });
    await symlink(target, join(f.hermes, 'node/etc'));
    expect(f.run().status).not.toBe(0);
    await expect(stat(join(target, 'npmrc'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
