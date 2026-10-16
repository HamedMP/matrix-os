import { chmod, link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseUniqueOperatorJson, readProtectedOperatorInput } from '../../scripts/ops/runtime-token-protected-input.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('initialization operator input custody', () => {
  it('reads only bounded private single-link files through protected ancestors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-init-input-')); roots.push(root);
    const path = join(root, 'input'); await writeFile(path, 'protected fixture', { mode: 0o600 });
    expect(await readProtectedOperatorInput(path)).toBe('protected fixture');
    await chmod(path, 0o640); await expect(readProtectedOperatorInput(path)).rejects.toThrow();
    await chmod(path, 0o600); await link(path, join(root, 'hardlink'));
    await expect(readProtectedOperatorInput(path)).rejects.toThrow(); await rm(join(root, 'hardlink'));
    await symlink(path, join(root, 'alias')); await expect(readProtectedOperatorInput(join(root, 'alias'))).rejects.toThrow();
    await writeFile(path, 'x'.repeat(65_537)); await expect(readProtectedOperatorInput(path)).rejects.toThrow();
  });
  it('rejects a symlink or writable parent before accepting operator inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-init-parent-')); roots.push(root);
    const parent = join(root, 'private'); await mkdir(parent, { mode: 0o700 });
    await writeFile(join(parent, 'input'), 'fixture', { mode: 0o600 });
    await symlink(parent, join(root, 'alias'));
    await expect(readProtectedOperatorInput(join(root, 'alias', 'input'))).rejects.toThrow();
    await chmod(parent, 0o770); await expect(readProtectedOperatorInput(join(parent, 'input'))).rejects.toThrow();
  });
});

describe('operator metadata JSON bindings', () => {
  it('retains nested metadata and rejects duplicate escaped keys without normalization', () => {
    expect(parseUniqueOperatorJson('{"owner":"user_test","items":[{"value":"a:b"}]}'))
      .toEqual({ owner: 'user_test', items: [{ value: 'a:b' }] });
    expect(() => parseUniqueOperatorJson('{"owner":"first","owner":"second"}')).toThrow();
    expect(() => parseUniqueOperatorJson('{"identity":{"owner":"first","o\\u0077ner":"second"}}')).toThrow();
  });
});
