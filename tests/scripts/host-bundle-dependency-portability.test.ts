import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('runs a copied Host dependency without access to the builder virtual store', () => {
  const repo = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), 'host-portable-dependency-'));
  try {
    const source = join(fixture, 'source');
    const payload = join(fixture, 'payload');
    mkdirSync(join(source, 'dep'), { recursive: true });
    mkdirSync(payload);
    mkdirSync(join(fixture, 'home'));
    writeFileSync(join(fixture, 'empty.npmrc'), '');
    writeFileSync(join(source, 'package.json'), JSON.stringify({ private: true, dependencies: { 'host-portability-fixture': 'file:./dep.tgz' } }));
    writeFileSync(join(source, 'dep/package.json'), JSON.stringify({ name: 'host-portability-fixture', version: '1.0.0', main: 'index.cjs' }));
    writeFileSync(join(source, 'dep/index.cjs'), 'module.exports = "contained-runtime-package";\n');
    writeFileSync(join(source, 'pnpm-workspace.yaml'), 'enableGlobalVirtualStore: true\nstoreDir: .pnpm-store\n');
    const env = {
      PATH: join(repo, 'node_modules/.bin') + delimiter + process.env.PATH,
      HOME: join(fixture, 'home'), NPM_CONFIG_USERCONFIG: join(fixture, 'empty.npmrc'),
    };
    const run = (command: string, args: string[], cwd = source) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 25_000 });
    const tar = run('tar', ['-czf', 'dep.tgz', '-C', 'dep', '.']);
    expect(tar.status, tar.stderr).toBe(0);
    const version = run('pnpm', ['--version']);
    const pinned = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).packageManager.split('@')[1].split('+')[0];
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(pinned);
    const lock = run('pnpm', ['install', '--lockfile-only', '--offline', '--ignore-scripts']);
    expect(lock.status, lock.stderr || lock.stdout).toBe(0);
    // Execute the actual production install command, not a replica of its flags.
    const install = readFileSync(join(repo, 'scripts/build-host-bundle.sh'), 'utf8').split('\n').find(line => line.startsWith('pnpm install '));
    expect(install).toBeDefined();
    const result = run('bash', ['-c', install!]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    cpSync(join(source, 'node_modules'), join(payload, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    // Keep the builder intact for diagnosis, but make its original path absent.
    renameSync(source, join(fixture, 'builder-preserved'));
    const loaded = run(process.execPath, ['-e', 'process.stdout.write(require("host-portability-fixture"))'], payload);
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toBe('contained-runtime-package');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}, 60_000);
