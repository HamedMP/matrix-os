import { z } from 'zod/v4';
import { APP_BUNDLE_LIMITS } from '@matrix-os/contracts/app-store-bundle';
import { sourceText } from './generalizer-batches.js';
import { StoreError } from './platform-client.js';

const path = z.string().min(1).max(240);
export const GeneralizerEditSchema = z.union([
  z.strictObject({ path, contents: z.string().max(64_000).nullable() }),
  z.strictObject({ path, replacements: z.array(z.strictObject({
    before: z.string().min(1).max(8192), after: z.string().max(8192),
  })).min(1).max(32) }),
]);
export type GeneralizerEdit = z.infer<typeof GeneralizerEditSchema>;

/** Expand short exact replacements without requiring a model to echo large source files. */
export function resolveGeneralizerEdits(files: ReadonlyMap<string, Buffer>, input: readonly GeneralizerEdit[]): { path: string; contents: string | null }[] {
  const edits = z.array(GeneralizerEditSchema).max(128).parse(input);
  const seen = new Set<string>();
  return edits.map(edit => {
    if (seen.has(edit.path)) throw new StoreError('invalid');
    seen.add(edit.path);
    if ('contents' in edit) return edit;
    const bytes = files.get(edit.path);
    let contents = bytes && sourceText(bytes);
    if (typeof contents !== 'string') throw new StoreError('invalid');
    for (const replacement of edit.replacements) {
      const index = contents.indexOf(replacement.before);
      if (index < 0 || contents.indexOf(replacement.before, index + 1) !== -1) throw new StoreError('invalid');
      contents = contents.slice(0, index) + replacement.after + contents.slice(index + replacement.before.length);
      if (Buffer.byteLength(contents) > APP_BUNDLE_LIMITS.maxFileBytes) throw new StoreError('invalid');
    }
    return { path: edit.path, contents };
  });
}
