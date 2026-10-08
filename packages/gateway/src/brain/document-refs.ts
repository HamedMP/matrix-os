/**
 * Company Brain document refs: what a synced document touches (a repository
 * path, a PR number, a spec id). applySyncBatch is the only writer and always
 * sends a document's complete set; every tombstone path and eraseScope remove
 * them, so only live documents have refs. Write functions expect a transaction
 * that already holds the per-scope advisory lock.
 */
import type { BrainExecutor } from "./documents.js";
import { BRAIN_DOCUMENT_REFS_MAX, type BrainDocumentRef, type BrainScopeKey } from "./types.js";

const refKey = (ref: BrainDocumentRef): string => JSON.stringify([ref.kind, ref.value]);

export function selectDocumentRefs(
  db: BrainExecutor,
  scope: BrainScopeKey,
  documentId: string,
): Promise<BrainDocumentRef[]> {
  return db.selectFrom("brain_document_refs").select(["kind", "value"])
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", documentId)
    .orderBy("kind", "asc")
    .orderBy("value", "asc")
    .limit(BRAIN_DOCUMENT_REFS_MAX)
    .execute();
}

export async function deleteDocumentRefs(db: BrainExecutor, scope: BrainScopeKey, documentId: string): Promise<void> {
  await db.deleteFrom("brain_document_refs")
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", documentId)
    .execute();
}

/**
 * Makes the stored set equal `refs`: an identical set writes nothing, any difference replaces it wholesale.
 * Returns whether the stored set changed.
 */
export async function syncDocumentRefs(
  db: BrainExecutor,
  scope: BrainScopeKey,
  documentId: string,
  refs: readonly BrainDocumentRef[],
): Promise<boolean> {
  const current = (await selectDocumentRefs(db, scope, documentId)).map(refKey).sort();
  const next = refs.map(refKey).sort();
  if (current.length === next.length && current.every((key, index) => key === next[index])) return false;
  await deleteDocumentRefs(db, scope, documentId);
  if (refs.length === 0) return true;
  await db.insertInto("brain_document_refs").values(refs.map((ref) => ({
    owner_id: scope.ownerId,
    scope_id: scope.scopeId,
    document_id: documentId,
    kind: ref.kind,
    value: ref.value,
  }))).execute();
  return true;
}

/** deleteSource: drops the refs of every document the source owns (its tombstones already have none). */
export async function deleteSourceDocumentRefs(db: BrainExecutor, scope: BrainScopeKey, sourceId: string): Promise<void> {
  await db.deleteFrom("brain_document_refs")
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where((eb) => eb("document_id", "in", eb.selectFrom("brain_documents").select("document_id")
      .where("owner_id", "=", scope.ownerId)
      .where("scope_id", "=", scope.scopeId)
      .where("source_id", "=", sourceId)))
    .execute();
}
