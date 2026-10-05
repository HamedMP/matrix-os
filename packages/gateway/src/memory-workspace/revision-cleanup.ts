import { sql } from "kysely";
import { MEMORY_ENGINES } from "@matrix-os/contracts";
import type { MemoryDb } from "./evidence.js";
/** Delete jobs address exact derivative revisions; they never address the live source subtree. */
export async function enqueueRevisionCleanup(
  db: MemoryDb,
  source: { id: string; owner_id: string; revision: number },
) {
  if (source.revision < 2) return;
  for (const engine of MEMORY_ENGINES) {
    await sql`INSERT INTO memory_workspace_jobs(id,owner_id,source_id,engine,revision,operation,status)
      SELECT gen_random_uuid(),${source.owner_id},${source.id}::uuid,${engine},obsolete.revision,'delete','pending'
      FROM (SELECT revision FROM memory_workspace_jobs WHERE source_id=${source.id} AND engine=${engine} AND operation='upsert' AND revision<${source.revision}
        UNION SELECT ${source.revision - 1}::integer) obsolete
      ON CONFLICT(source_id,engine,revision,operation) DO NOTHING`.execute(db);
  }
}
/** Aborted HTTP requests can keep running remotely. Keep a durable, bounded cleanup sweep. */
export async function reconcileRevisionCleanup(db: MemoryDb) {
  await sql`UPDATE memory_workspace_jobs SET status='pending',attempts=0,available_at=now(),updated_at=now()
    WHERE id IN (SELECT j.id FROM memory_workspace_jobs j JOIN memory_workspace_sources s ON s.id=j.source_id
      WHERE j.operation='delete' AND j.revision<s.revision AND j.status IN ('ready','failed','cancelled')
      AND j.updated_at<now()-interval '1 hour' ORDER BY j.updated_at LIMIT 100 FOR UPDATE OF j SKIP LOCKED)`.execute(
    db,
  );
  // Retain content-free cleanup journals so even a very late remote write is eventually erased.
  await sql`DELETE FROM memory_workspace_jobs j USING memory_workspace_sources s
    WHERE j.source_id=s.id AND j.operation='upsert' AND j.revision<s.revision
    AND j.status IN ('ready','cancelled','failed') AND j.updated_at<now()-interval '7 days'
    AND EXISTS(SELECT 1 FROM memory_workspace_jobs cleanup WHERE cleanup.source_id=j.source_id
      AND cleanup.engine=j.engine AND cleanup.revision=j.revision AND cleanup.operation='delete')`.execute(
    db,
  );
}
