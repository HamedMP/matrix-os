// The cache and its protections share the same hard cap. Active references are
// never evicted; a new selection fails safely when all places are in use.
export const MAX_MATRIX_CACHE_FILES = 64;
const STAGING_HANDOFF_MS = 30_000;
const retained = new Map<string, { references: number; handoffUntil: number }>();

function sweep() {
  for (const [uri, entry] of retained) {
    if (entry.references === 0 && entry.handoffUntil <= Date.now()) retained.delete(uri);
  }
}

function entryFor(uri: string) {
  const existing = retained.get(uri);
  if (existing) return existing;
  if (retained.size >= MAX_MATRIX_CACHE_FILES) throw new Error("MatrixAttachmentCacheFull");
  const entry = { references: 0, handoffUntil: 0 };
  retained.set(uri, entry);
  return entry;
}

/** Bridges the asynchronous picker result until its composer commits ownership. */
export function protectStagedMatrixAttachment(uri: string) {
  sweep();
  entryFor(uri).handoffUntil = Date.now() + STAGING_HANDOFF_MS;
}

export function forgetStagedMatrixAttachment(uri: string) {
  const entry = retained.get(uri);
  if (entry && entry.references === 0) retained.delete(uri);
}

export function isMatrixAttachmentRetained(uri: string): boolean {
  const entry = retained.get(uri);
  return Boolean(entry && (entry.references > 0 || entry.handoffUntil > Date.now()));
}

/** Each mounted composer/send releases exactly the references it acquired. */
export function retainMatrixAttachmentUris(uris: readonly string[]): () => void {
  sweep();
  const unique = uris.filter((uri, index) => uris.indexOf(uri) === index);
  if (retained.size + unique.filter((uri) => !retained.has(uri)).length > MAX_MATRIX_CACHE_FILES) {
    throw new Error("MatrixAttachmentCacheFull");
  }
  for (const uri of unique) {
    const entry = entryFor(uri);
    entry.references += 1;
    entry.handoffUntil = 0;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const uri of unique) {
      const entry = retained.get(uri);
      if (entry && --entry.references === 0) retained.delete(uri);
    }
  };
}

export function isMatrixAttachmentCacheUri(uri: string): boolean {
  return /\/chat-matrix-attachments\/att_[a-f0-9]{32}$/.test(uri);
}
