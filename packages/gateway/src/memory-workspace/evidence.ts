import { sql, type Kysely, type Transaction } from "kysely";
import type { MemorySearchResult } from "@matrix-os/contracts";
import type { MemoryDatabase } from "./database.js";
export type MemoryDb = Kysely<MemoryDatabase> | Transaction<MemoryDatabase>;
export async function lockMemoryOwner(db: MemoryDb, owner: string) {
  await sql`INSERT INTO memory_workspace_owners(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`.execute(
    db,
  );
  await sql`SELECT owner_id FROM memory_workspace_owners WHERE owner_id=${owner} FOR UPDATE`.execute(
    db,
  );
}
/** Caller holds the owner lock also used by correction, reimport and deletion. */
export async function validateMemoryEvidence(
  db: MemoryDb,
  owner: string,
  results: MemorySearchResult[],
) {
  const ids = [
    ...new Set(
      results.flatMap((result) => result.hits.map((hit) => hit.sourceId)),
    ),
  ];
  const rows = ids.length
    ? (
        await sql<{
          id: string;
          revision: number;
        }>`SELECT id,revision FROM memory_workspace_sources WHERE owner_id=${owner} AND deleted_at IS NULL AND id IN (${sql.join(ids)})`.execute(
          db,
        )
      ).rows
    : [];
  let invalidated = false;
  const current = results.map((result) => ({
    ...result,
    hits: result.hits.filter((hit) => {
      const valid =
        rows.some(
          (row) =>
            row.id === hit.sourceId && row.revision === hit.citation.revision,
        ) && hit.citation.sourceId === hit.sourceId;
      if (!valid) invalidated = true;
      return valid;
    }),
  }));
  return { current, invalidated };
}
