import { describe, expect, it } from 'vitest';
import {
  DEVSTACK_SOURCE_DELTA_MAX_BYTES,
  parseDevstackSourceDelta,
} from '../../packages/platform/src/devstack-source-delta.js';

const base = 'a'.repeat(40);
const file = (path: string, content = 'YQ==') => ({ path, kind: 'file', mode: 420, content });
const remove = (path: string) => ({ path, kind: 'delete' });

describe('DevStack source delta validation', () => {
  it('accepts bounded additions, edits, executable files, deletions and empty reverts', () => {
    const delta = { base, entries: [
      file('shell/src/hello world.ts'),
      { ...file('scripts/工具.sh'), mode: 493 },
      file('.gitignore', ''),
      remove('packages/gateway/src/retired.ts'),
    ] };
    expect(parseDevstackSourceDelta(delta)).toEqual(delta);
    expect(parseDevstackSourceDelta({ base, entries: [] })).toEqual({ base, entries: [] });
  });

  it.each([
    { base: 'f'.repeat(39), entries: [] },
    { base: 'A'.repeat(40), entries: [] },
    { base: base + '\n', entries: [] },
    { base, entries: [], generation: '123' },
    { base, entries: [{ ...file('x'), mode: 0o777 }] },
    { base, entries: [{ ...file('x'), mode: '420' }] },
    { base, entries: [{ ...remove('x'), content: '' }] },
    { base, entries: [{ ...file('x'), kind: 'symlink' }] },
    { base, entries: [null] },
    null,
  ])('rejects malformed schemas', input => {
    expect(parseDevstackSourceDelta(input)).toBeNull();
  });

  it.each(['YR==', 'YQ', 'YQ=', 'YQ===', 'YQ==\n', 'Y Q=', '_Q==', '¥YQ=', 'YQ==AA=='])(
    'rejects noncanonical base64 %j',
    content => {
      expect(parseDevstackSourceDelta({ base, entries: [file('src/a', content)] })).toBeNull();
    },
  );

  it.each([
    '', '.', '..', '/src/a', 'src//a', 'src/./a', 'src/../a', 'src/a/', 'src\\a', 'C:/src/a',
    'a\0b', 'a\nb', 'a\u202eb', 'a\ud800b', 'a\u2028b', 'a:b', 'a?b', 'a.', 'a ',
    'x/'.repeat(64) + 'y', 'a'.repeat(4097),
  ])('rejects unsafe source path %j', path => {
    expect(parseDevstackSourceDelta({ base, entries: [file(path)] })).toBeNull();
    expect(parseDevstackSourceDelta({ base, entries: [remove(path)] })).toBeNull();
  });

  it.each([
    '.git/config', 'src/.ſsh/config', 'src/.ENV', 'src/.env.production', '.npmrc', '.docker/config.json',
    'src/.envrc', 'src/id_ed25519', 'src/client.PEM', 'src/credentials.json',
    'packages/platform/data/main.json', 'packages/platform/data', '.config/gcloud/token',
    'shell/.next/cache', 'shell/next-env.d.ts', 'output/artifact.ts', 'src/.build-stamp',
    'src/bundle.tsbuildinfo', 'src/node_modules/dependency.ts', 'src/.turbo/a', '.worktrees/project',
    'src/dist/final.js', 'src/coverage/data.json', 'src/test-results/trace.zip', 'src/playwright-report/index.html',
  ])('excludes sensitive and generated source path %j', path => {
    expect(parseDevstackSourceDelta({ base, entries: [file(path)] })).toBeNull();
    expect(parseDevstackSourceDelta({ base, entries: [remove(path)] })).toBeNull();
  });

  it.each([
    ['src/x', 'src/x'],
    ['src/x', 'src/X'],
    ['Src/x', 'src/y'],
    ['x', 'x/y'],
    ['x/y', 'x'],
    ['x/y/z', 'X'],
    ['x/café.ts', 'x/cafe\u0301.ts'],
  ])('rejects aliases or file/directory conflicts between %j and %j', (first, second) => {
    expect(parseDevstackSourceDelta({ base, entries: [file(first), remove(second)] })).toBeNull();
    expect(parseDevstackSourceDelta({ base, entries: [remove(first), file(second)] })).toBeNull();
  });

  it('enforces the array and total UTF-8 JSON size limits', () => {
    const entries = Array.from({ length: 1001 }, (_, index) => file(`src/${index}.ts`, ''));
    expect(parseDevstackSourceDelta({ base, entries: entries.slice(1) })).not.toBeNull();
    expect(parseDevstackSourceDelta({ base, entries })).toBeNull();

    const content = 'YQAA'.repeat((DEVSTACK_SOURCE_DELTA_MAX_BYTES - 1024) / 4);
    expect(parseDevstackSourceDelta({ base, entries: [file('src/a', content)] })).not.toBeNull();
    expect(parseDevstackSourceDelta({ base, entries: [file('src/' + 'é'.repeat(500), content)] })).toBeNull();
    expect(parseDevstackSourceDelta({ base, entries: [file('src/a', content), file('src/b', 'YQAA'.repeat(256))] })).toBeNull();
  });
});
