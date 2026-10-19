import { describe, expect, it } from 'vitest';
import { resolveGeneralizerEdits } from '../../../packages/gateway/src/app-store/generalizer-edits.js';

describe('bounded source generalization replacements', () => {
  it('changes one short span while preserving an existing large source file', () => {
    const text = `${'// neutral source\n'.repeat(2500)}const title = "My garden";\n`;
    const source = new Map([['src/main.ts', Buffer.from(text)]]);
    const edits = resolveGeneralizerEdits(source, [{ path: 'src/main.ts', replacements: [{ before: '"My garden"', after: '"Garden"' }] }]);
    expect(edits).toEqual([{ path: 'src/main.ts', contents: text.replace('"My garden"', '"Garden"') }]);
    expect(source.get('src/main.ts')!.toString()).toBe(text);
    expect(JSON.stringify([{ path: 'src/main.ts', replacements: [{ before: '"My garden"', after: '"Garden"' }] }]).length).toBeLessThan(200);
  });
  it.each(['absent', 'repeated'])('rejects an %s match without changing source', (kind) => {
    const text = kind === 'absent' ? 'other content' : 'same same';
    const source = new Map([['src/main.ts', Buffer.from(text)]]);
    expect(() => resolveGeneralizerEdits(source, [{ path: 'src/main.ts', replacements: [{ before: 'same', after: 'new' }] }])).toThrow();
    expect(source.get('src/main.ts')!.toString()).toBe(text);
  });
  it('requires an existing UTF-8 source file for replacements', () => {
    const edit = { path: 'src/main.ts', replacements: [{ before: 'old', after: 'new' }] };
    expect(() => resolveGeneralizerEdits(new Map(), [edit])).toThrow();
    expect(() => resolveGeneralizerEdits(new Map([['src/main.ts', Buffer.from([0, 255])]]), [edit])).toThrow();
  });
  it('keeps complete-file creation and deletion behavior', () => {
    expect(resolveGeneralizerEdits(new Map(), [{ path: 'src/new.ts', contents: 'export const value = 1;' }, { path: 'src/old.ts', contents: null }])).toEqual([
      { path: 'src/new.ts', contents: 'export const value = 1;' }, { path: 'src/old.ts', contents: null },
    ]);
  });
  it('rejects duplicate paths and oversized replacement spans', () => {
    const source = new Map([['src/main.ts', Buffer.from('old')]]);
    expect(() => resolveGeneralizerEdits(source, [{ path: 'src/main.ts', contents: 'new' }, { path: 'src/main.ts', contents: 'other' }])).toThrow();
    expect(() => resolveGeneralizerEdits(source, [{ path: 'src/main.ts', replacements: [{ before: 'old', after: 'x'.repeat(8193) }] }])).toThrow();
  });
});
