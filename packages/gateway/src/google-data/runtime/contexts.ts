import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { boundedProvenanceTransaction } from "../provenance/transaction.js";
import { accountId, contextDeny, contextLimits, contextMarkSchema, contextOpaque,
  type GoogleContext, type GoogleContextMark, type GoogleContextOptions, type GoogleContextSource } from "./contexts-contracts.js";
import { lockGoogleContexts, migrateGoogleContexts } from "./contexts-schema.js";

export type { GoogleContext, GoogleContextMark, GoogleContextOptions, GoogleContextSource, GoogleContextDeletionAuthority, GoogleContextOwnerDeletionAuthority, GoogleContextLimits } from "./contexts-contracts.js";
export { GoogleContextUnavailable } from "./contexts-contracts.js";
interface ContextRow {
  id: string; owner_id: string; chat_id: string; revision: number; retention_deadline: Date;
  state: "active" | "purging" | "deleted"; sources: GoogleContextSource[];
}
const sourceProjection = sql`jsonb_build_object('originId',s.origin_id,'googleAccountId',s.google_account_id,
  'consentId',s.consent_id,'profileId',s.profile_id,'profileRevision',s.profile_revision,
  'purposeId',s.purpose_id,'expiresAt',s.expires_at,'state',s.state)`;

/** Trusted metadata composition only: marking is classification, never P1 approval.
 * Revalidate current P1 after waits and before collection/context assembly/egress.
 * Unknown references require host handling; null means never classified, not proof of non-Google content. */
export function createGoogleContextStore<DB>(db: Kysely<DB>, options: GoogleContextOptions = {}) {
  const cap = contextLimits(options.limits);
  const now = options.now ?? (() => new Date());
  const privateOriginId = (owner: string, account: string, consent: string) => createHash("sha256").update(JSON.stringify([owner, account, consent])).digest("hex");
  const validDeadline = (value: string) => Number.isFinite(new Date(value).getTime()) && new Date(value) > now();
  function project(row: ContextRow): GoogleContext {
    const sources = row.sources.map(source => ({ ...source, expiresAt: new Date(source.expiresAt).toISOString() }));
    const availability = row.state === "deleted" ? "deleted" : row.state === "purging" || sources.some(s => s.state === "purging") ? "purging"
      : row.retention_deadline <= now() || !sources.length || sources.some(s => !validDeadline(s.expiresAt)) ? "expired" : "available";
    return { ownerId: row.owner_id, chatId: row.chat_id, revision: row.revision,
      retentionDeadline: row.retention_deadline.toISOString(), availability, sources };
  }
  async function read(tx: Transaction<DB>, ownerId: string, chatId: string): Promise<ContextRow | null> {
    return (await sql<ContextRow>`SELECT m.*,COALESCE(jsonb_agg(${sourceProjection} ORDER BY s.origin_id)
      FILTER(WHERE s.origin_id IS NOT NULL),'[]'::jsonb) AS sources FROM google_context_markers m
      LEFT JOIN google_context_origins o ON o.context_id=m.id
      LEFT JOIN google_context_sources s ON s.origin_id=o.origin_id AND s.owner_id=m.owner_id
      WHERE m.owner_id=${ownerId} AND m.chat_id=${chatId} GROUP BY m.id`.execute(tx)).rows[0] ?? null;
  }
  async function write(tx: Transaction<DB>, ownerId: string, chatId: string, current: ContextRow | null,
    incoming: GoogleContextSource[], retention: string, expectedRevision?: number): Promise<GoogleContext> {
    if (current && (current.state !== "active" || project(current).availability !== "available" || current.revision !== expectedRevision)) contextDeny();
    if (!current && expectedRevision !== undefined) contextDeny();
    const sources = [...new Map([...(current?.sources ?? []), ...incoming].map(s => [s.originId, s])).values()];
    if (sources.length < 1 || sources.length > cap.maxSourcesPerContext || sources.some(s => s.state !== "active" || !validDeadline(s.expiresAt))) contextDeny();
    const deadline = new Date(Math.min(new Date(retention).getTime(), current?.retention_deadline.getTime() ?? Infinity));
    const expires = new Date(Math.min(...sources.map(s => new Date(s.expiresAt).getTime())));
    if (deadline <= now() || expires <= now()) contextDeny();
    let id: string;
    if (current) {
      const updated = await sql<{ id: string }>`UPDATE google_context_markers SET revision=revision+1,retention_deadline=${deadline}
        WHERE id=${current.id} AND owner_id=${ownerId} AND revision=${expectedRevision} AND state='active'
        AND retention_deadline > clock_timestamp() AND ${deadline}::timestamptz > clock_timestamp()
        AND ${expires}::timestamptz > clock_timestamp() RETURNING id`.execute(tx);
      if (!updated.rows[0]) contextDeny();
      id = updated.rows[0]!.id;
    } else {
      const count = (await sql<{ total: number; owned: number }>`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=${ownerId})::int AS owned FROM google_context_markers`.execute(tx)).rows[0]!;
      if (count.total >= cap.maxContexts || count.owned >= cap.maxContextsPerOwner) contextDeny();
      const inserted = await sql<{ id: string }>`INSERT INTO google_context_markers(id,owner_id,chat_id,revision,retention_deadline,state)
        SELECT ${randomUUID()},${ownerId},${chatId},1,${deadline},'active' WHERE ${deadline}::timestamptz > clock_timestamp()
        AND ${expires}::timestamptz > clock_timestamp() ON CONFLICT(owner_id,chat_id) DO NOTHING RETURNING id`.execute(tx);
      if (!inserted.rows[0]) contextDeny();
      id = inserted.rows[0]!.id;
    }
    for (const source of sources) await sql`INSERT INTO google_context_origins(context_id,origin_id) VALUES(${id},${source.originId}) ON CONFLICT DO NOTHING`.execute(tx);
    const result = project((await read(tx, ownerId, chatId))!);
    // A deadline can pass during the bounded link writes too; rollback rather than release a stale stamp.
    if (result.availability !== "available") contextDeny();
    return result;
  }
  return {
    migrate: () => migrateGoogleContexts(db),
    async inspect(ownerId: string, chatId: string): Promise<GoogleContext | null> {
      contextOpaque.parse(ownerId); contextOpaque.parse(chatId);
      return boundedProvenanceTransaction(db, async tx => { const row = await read(tx, ownerId, chatId); return row ? project(row) : null; });
    },
    async mark(value: GoogleContextMark): Promise<GoogleContext> {
      const input = contextMarkSchema.parse(value);
      if (!validDeadline(input.expiresAt) || !validDeadline(input.retentionDeadline)
        || new Date(input.retentionDeadline).getTime() > now().getTime() + 30 * 86_400_000) contextDeny();
      return boundedProvenanceTransaction(db, async tx => {
        await lockGoogleContexts(tx);
        if (!validDeadline(input.expiresAt) || !validDeadline(input.retentionDeadline)) contextDeny();
        const originId = privateOriginId(input.ownerId, input.googleAccountId, input.consentId);
        const existing = (await sql<{ profile_id: string; profile_revision: number; purpose_id: string; state: string }>`SELECT profile_id,profile_revision,purpose_id,state
          FROM google_context_sources WHERE origin_id=${originId} AND owner_id=${input.ownerId} FOR UPDATE`.execute(tx)).rows[0];
        if (existing && (existing.state !== "active" || existing.profile_id !== input.profileId || existing.profile_revision !== input.profileRevision || existing.purpose_id !== input.purposeId)) contextDeny();
        if (!existing) {
          const count = (await sql<{ total: number; owned: number }>`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=${input.ownerId})::int AS owned FROM google_context_sources`.execute(tx)).rows[0]!;
          if (count.total >= cap.maxSources || count.owned >= cap.maxSourcesPerOwner) contextDeny();
        }
        const persisted = (await sql<{ expires_at: Date }>`INSERT INTO google_context_sources(origin_id,owner_id,google_account_id,consent_id,profile_id,profile_revision,purpose_id,expires_at,state)
          SELECT ${originId},${input.ownerId},${input.googleAccountId},${input.consentId},${input.profileId},${input.profileRevision},${input.purposeId},${new Date(input.expiresAt)},'active'
          WHERE ${new Date(input.expiresAt)}::timestamptz > clock_timestamp() AND ${new Date(input.retentionDeadline)}::timestamptz > clock_timestamp()
          ON CONFLICT(origin_id) DO UPDATE SET expires_at=LEAST(google_context_sources.expires_at,excluded.expires_at)
          WHERE google_context_sources.owner_id=excluded.owner_id AND google_context_sources.google_account_id=excluded.google_account_id
          AND google_context_sources.consent_id=excluded.consent_id AND google_context_sources.profile_id=excluded.profile_id
          AND google_context_sources.profile_revision=excluded.profile_revision AND google_context_sources.purpose_id=excluded.purpose_id
          AND google_context_sources.state='active' RETURNING expires_at`.execute(tx)).rows[0];
        if (!persisted) contextDeny();
        const source: GoogleContextSource = { originId, googleAccountId: input.googleAccountId, consentId: input.consentId,
          profileId: input.profileId, profileRevision: input.profileRevision, purposeId: input.purposeId, expiresAt: persisted.expires_at.toISOString(), state: "active" };
        return write(tx, input.ownerId, input.chatId, await read(tx, input.ownerId, input.chatId), [source], input.retentionDeadline, input.expectedRevision);
      });
    },
    async inherit(ownerId: string, targetChatId: string, sourceChatIds: string[], expectedRevision?: number): Promise<GoogleContext> {
      contextOpaque.parse(ownerId); contextOpaque.parse(targetChatId);
      const ids = contextOpaque.array().min(1).max(32).parse(sourceChatIds);
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > 2_147_483_647)) contextDeny();
      return boundedProvenanceTransaction(db, async tx => {
        await lockGoogleContexts(tx);
        const sources: GoogleContextSource[] = [];
        let retention = Infinity;
        for (const chatId of [...new Set(ids)]) {
          const row = await read(tx, ownerId, chatId);
          if (!row || project(row).availability !== "available") contextDeny();
          sources.push(...row.sources);
          retention = Math.min(retention, row.retention_deadline.getTime());
        }
        return write(tx, ownerId, targetChatId, await read(tx, ownerId, targetChatId), sources, new Date(retention).toISOString(), expectedRevision);
      });
    },
    async sourcesForAccount(ownerId: string, googleAccountId: string): Promise<GoogleContextSource[]> {
      contextOpaque.parse(ownerId); const account = accountId.parse(googleAccountId);
      return boundedProvenanceTransaction(db, async tx => (await sql<{ source: GoogleContextSource }>`SELECT ${sourceProjection} AS source
        FROM google_context_sources s WHERE owner_id=${ownerId} AND google_account_id=${account} ORDER BY origin_id`.execute(tx)).rows
        .map(row => ({ ...row.source, expiresAt: new Date(row.source.expiresAt).toISOString() })));
    },
    /** Group every known consent generation of the stable actual account UUID. Host must revoke current P1
     * before calling and recheck it before admitting any fresh generation. This method does not approve a renewal. */
    async beginPurge(ownerId: string, googleAccountId: string) {
      contextOpaque.parse(ownerId); const account = accountId.parse(googleAccountId);
      return boundedProvenanceTransaction(db, async tx => {
        await lockGoogleContexts(tx);
        const origins = (await sql<{ origin_id: string }>`UPDATE google_context_sources SET state='purging'
          WHERE owner_id=${ownerId} AND google_account_id=${account} RETURNING origin_id`.execute(tx)).rows;
        const contexts = (await sql<{ chat_id: string; revision: number }>`UPDATE google_context_markers m SET
          state='purging',revision=CASE WHEN m.state='active' THEN m.revision+1 ELSE m.revision END
          WHERE m.owner_id=${ownerId} AND m.state<>'deleted' AND EXISTS(
            SELECT 1 FROM google_context_origins o JOIN google_context_sources s ON s.origin_id=o.origin_id
            WHERE o.context_id=m.id AND s.owner_id=${ownerId} AND s.google_account_id=${account})
          RETURNING chat_id,revision`.execute(tx)).rows;
        const revisions: Record<string, number> = Object.create(null);
        for (const context of contexts) revisions[context.chat_id] = context.revision;
        return { originIds: origins.map(row => row.origin_id), chatIds: contexts.map(row => row.chat_id), revisions,
          coverage: "registered-contexts-only" as const };
      });
    },
    /** Full owner-account lifecycle only, after host revocation/quiescence and actual content deletion.
     * This is the sole marker-erasure seam. The host must permanently prevent owner writes afterward;
     * ordinary retained-copy cleanup must use completeDeletion and preserve its closed marker instead. */
    async finalizeOwnerDeletion(ownerId: string) {
      contextOpaque.parse(ownerId);
      if (!options.ownerDeletionAuthority) contextDeny();
      let completed: { finalized: true; coverage: "registered-contexts-only" } | undefined;
      const admitted = await options.ownerDeletionAuthority!.withOwnerDeletionAdmission(ownerId, async () => {
        completed = await boundedProvenanceTransaction(db, async tx => {
          await lockGoogleContexts(tx);
          const markers = (await sql<{ state: string }>`SELECT state FROM google_context_markers WHERE owner_id=${ownerId} FOR UPDATE`.execute(tx)).rows;
          if (markers.some(marker => marker.state !== "deleted")) contextDeny();
          const links = await sql`SELECT 1 FROM google_context_origins o JOIN google_context_markers m ON m.id=o.context_id
            JOIN google_context_sources s ON s.origin_id=o.origin_id WHERE m.owner_id=${ownerId} OR s.owner_id=${ownerId} LIMIT 1`.execute(tx);
          if (links.rows.length) contextDeny();
          await sql`DELETE FROM google_context_markers WHERE owner_id=${ownerId} AND state='deleted'`.execute(tx);
          await sql`DELETE FROM google_context_sources WHERE owner_id=${ownerId}`.execute(tx);
          return { finalized: true as const, coverage: "registered-contexts-only" as const };
        });
        return completed;
      });
      if (!admitted || admitted !== completed) contextDeny();
      return completed!;
    },
    /** Trusted verified-content-deletion admission only. Keep a closed marker; deleting the marker would make
     * a previously Google-derived saved context look never classified. Source-generation tombstones remain. */
    async completeDeletion(ownerId: string, chatId: string, expectedRevision: number) {
      contextOpaque.parse(ownerId); contextOpaque.parse(chatId);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > 2_147_483_647 || !options.deletionAuthority) contextDeny();
      let completed: GoogleContext | undefined;
      const admitted = await options.deletionAuthority!.withVerifiedContextDeletion(ownerId, chatId, async () => {
        completed = await boundedProvenanceTransaction(db, async tx => {
          await lockGoogleContexts(tx);
          const row = await read(tx, ownerId, chatId);
          if (!row || row.state !== "purging" || row.revision !== expectedRevision) contextDeny();
          const updated = await sql`UPDATE google_context_markers SET state='deleted',revision=revision+1
            WHERE id=${row.id} AND owner_id=${ownerId} AND state='purging' AND revision=${expectedRevision} RETURNING id`.execute(tx);
          if (!updated.rows.length) contextDeny();
          await sql`DELETE FROM google_context_origins WHERE context_id=${row.id}`.execute(tx);
          return project((await read(tx, ownerId, chatId))!);
        });
        return completed;
      });
      if (!admitted || admitted !== completed) contextDeny();
      return completed!;
    },
  };
}
export type GoogleContextStore = ReturnType<typeof createGoogleContextStore>;
