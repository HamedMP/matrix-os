import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const restricted: string[] = [];
afterEach(() => {
  for (const path of restricted.splice(0)) chmodSync(path, 0o755);
  // Failed archives may already have preserved an unreadable directory mode.
  function restoreDirectories(path: string) {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return;
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) restoreDirectories(join(path, entry));
  }
  for (const root of roots.splice(0)) {
    restoreDirectories(root);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'host-runtime-copy-'));
  roots.push(root);
  const source = join(root, 'source home');
  const stage = join(root, 'stage');
  mkdirSync(source);
  mkdirSync(join(stage, 'app'), { recursive: true });
  return { root, source, stage, output: join(stage, 'app/home') };
}
function copyHome(source: string, stage: string) {
  // Exercise the real build entrypoint's copy command, with only its input
  // directory supplied by this fixture; no local replica of the copy policy.
  const script = readFileSync(join(process.cwd(), 'scripts/build-host-bundle.sh'), 'utf8');
  const command = script.split('\n').find(line => line.endsWith('"$ROOT_DIR/home" "$STAGE_DIR/app/home"'));
  expect(command, 'bundle must stage home through the tested copy command').toBeDefined();
  const cleanup = script.split('\n').find(line => line.startsWith('find "$STAGE_DIR/app/home"'));
  expect(cleanup).toBeDefined();
  return spawnSync('bash', ['-c', 'set -euo pipefail\n' + command!.replace('"$ROOT_DIR/home"', '"$SOURCE_HOME"') + '\n' + cleanup], {
    env: { PATH: process.env.PATH, ROOT_DIR: process.cwd(), SOURCE_HOME: source, STAGE_DIR: stage },
    encoding: 'utf8', timeout: 10_000,
  });
}

describe('Host runtime home copy', () => {
  it('never traverses build-only dependency directories before staging runtime files', () => {
    const { source, stage, output } = fixture();
    mkdirSync(join(source, 'apps/chess/dist'), { recursive: true });
    writeFileSync(join(source, 'apps/chess/dist/index.html'), 'built chess');
    const dependencies = join(source, 'apps/chess/node_modules');
    mkdirSync(dependencies);
    writeFileSync(join(dependencies, 'build-only'), 'must never be copied');
    chmodSync(dependencies, 0);
    restricted.push(dependencies);

    const result = copyHome(source, stage);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(output, 'apps/chess/dist/index.html'), 'utf8')).toBe('built chess');
    expect(existsSync(join(output, 'apps/chess/node_modules'))).toBe(false);
    expect(lstatSync(dependencies).mode & 0o777).toBe(0);
  });

  it('preserves runtime content, dotfiles, empty directories, modes and verbatim links', () => {
    const { source, stage, output } = fixture();
    mkdirSync(join(source, 'app-templates/with space/empty'), { recursive: true });
    mkdirSync(join(source, 'app-templates/with space/node_modules/deep'), { recursive: true });
    writeFileSync(join(source, 'app-templates/with space/node_modules/deep/file'), 'build-only');
    writeFileSync(join(source, '.template-manifest.json'), '{"version":1}\n');
    writeFileSync(join(source, 'app-templates/with space/run.sh'), '#!/bin/sh\necho runtime\n', { mode: 0o750 });
    writeFileSync(join(source, 'line\nbreak'), 'newline filename');
    symlinkSync('app-templates/with space/run.sh', join(source, 'relative-link'));
    symlinkSync('missing-target', join(source, 'dangling-link'));
    symlinkSync('missing-dependency-dir', join(source, 'node_modules'));

    const result = copyHome(source, stage);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(output, '.template-manifest.json'), 'utf8')).toBe('{"version":1}\n');
    expect(readFileSync(join(output, 'line\nbreak'), 'utf8')).toBe('newline filename');
    expect(readFileSync(join(output, 'app-templates/with space/run.sh'), 'utf8')).toBe('#!/bin/sh\necho runtime\n');
    expect(lstatSync(join(output, 'app-templates/with space/run.sh')).mode & 0o777).toBe(0o750);
    expect(lstatSync(join(output, 'app-templates/with space/empty')).isDirectory()).toBe(true);
    expect(existsSync(join(output, 'app-templates/with space/node_modules'))).toBe(false);
    expect(readlinkSync(join(output, 'relative-link'))).toBe('app-templates/with space/run.sh');
    expect(readlinkSync(join(output, 'dangling-link'))).toBe('missing-target');
    expect(readlinkSync(join(output, 'node_modules'))).toBe('missing-dependency-dir');
  });

  it('fails when a required runtime file cannot be read', () => {
    const { source, stage } = fixture();
    const required = join(source, 'required-runtime');
    writeFileSync(required, 'must fail closed');
    chmodSync(required, 0);
    restricted.push(required);
    const result = copyHome(source, stage);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/denied|permitted|read/i);
  });

  it('fails when a required runtime directory cannot be enumerated', () => {
    const { source, stage } = fixture();
    const required = join(source, 'required-runtime-directory');
    mkdirSync(required);
    writeFileSync(join(required, 'required-runtime'), 'must not disappear');
    chmodSync(required, 0);
    restricted.push(required);
    const result = copyHome(source, stage);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/denied|permitted|read/i);
  });

  it('propagates an archive producer failure instead of accepting a partial home', () => {
    const { source, stage, root } = fixture();
    writeFileSync(join(source, 'runtime'), 'runtime');
    const tools = join(root, 'tools');
    mkdirSync(tools);
    writeFileSync(join(tools, 'tar'), '#!/bin/sh\ncase " $* " in\n  *" -cf "*) /usr/bin/tar "$@" || exit "$?"; exit 47;;\n  *) exec /usr/bin/tar "$@";;\nesac\n', { mode: 0o755 });
    const script = readFileSync(join(process.cwd(), 'scripts/build-host-bundle.sh'), 'utf8');
    const command = script.split('\n').find(line => line.endsWith('"$ROOT_DIR/home" "$STAGE_DIR/app/home"'))!;
    const result = spawnSync('bash', ['-c', 'set -euo pipefail\n' + command.replace('"$ROOT_DIR/home"', '"$SOURCE_HOME"')], {
      env: { PATH: tools + ':' + process.env.PATH, ROOT_DIR: process.cwd(), SOURCE_HOME: source, STAGE_DIR: stage },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(47);
  });
});
