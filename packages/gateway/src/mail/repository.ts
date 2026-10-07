import { randomUUID } from "node:crypto";
import { Kysely, sql, type Dialect } from "kysely";
import { JevEmailTriageResultSchema } from "@matrix-os/contracts";
import { bootstrapMailArchive } from "./schema.js";
import { MAIL_MAX_OBJECT_BYTES, mailObjectNamespace } from "./objects.js";
import { mailTransaction, bounded, grantedMessage, iso, json, getReadingState, saveReadingState, type MessageRow } from "./reading.js";
import {changeMailRetention,type MailRetentionRequest} from "./retention.js";
import { MailStateRepository } from "./state.js";
import {recordMailSyncFailure,type MailSyncFailureInput} from "./sync-error.js";
import {recordMailUsage,getMailUsageSummary,type MailUsageInput} from "./usage.js";
import {listRecoverableCleanupOperations,type MailCleanupRecoveryRequest} from "./recovery.js";
import { MailArchiveError, type ArchivedMessage, type MailClassification, type MailConsumerScope, type MailMessageInput, type MailObject, type MailSource, type MailSourceInput, type MailSourceKey } from "./types.js";

interface SourceRow {
  owner_id: string; account_id: string; provider: "gmail"; connection_id: string; email: string; account_label: string;
  source_group: "work" | "personal"; namespace: string; quota_bytes: string | number; used_bytes: string | number;
  cursor: string | null; revision: number; paused:boolean;
}
function source(row: SourceRow): MailSource {
  return { ownerId: row.owner_id, accountId: row.account_id, provider: row.provider, connectionId: row.connection_id,
    email: row.email, accountLabel: row.account_label, group: row.source_group, namespace: row.namespace,
    quotaBytes: Number(row.quota_bytes), usedBytes: Number(row.used_bytes), cursor: row.cursor, revision: row.revision, paused:row.paused };
}
function archived(row: MessageRow): ArchivedMessage {
  return { ...json<MailMessageInput>(row.metadata), ownerId: row.owner_id, accountId: row.account_id,
    messageId: row.message_id, id: row.id, object: row.object ? json<MailObject>(row.object) : null,
    receivedAt: iso(row.received_at), revision: row.revision, correction: row.correction, classification: null };
}
function sourceKey(key: MailSourceKey): void { bounded(key.ownerId); bounded(key.accountId); }
function validDate(value: string): void { if (!Number.isFinite(Date.parse(value))) throw new MailArchiveError("invalid"); }

export class MailArchiveRepository extends MailStateRepository {
  private readonly ownsConnection: boolean;
  private readonly defaultQuota: number;
  constructor(dialectOrKysely: Dialect | Kysely<unknown>, options: { now?: () => Date; accountQuotaBytes?: number } = {}) {
    const owns = !(dialectOrKysely instanceof Kysely);
    super(owns ? new Kysely<unknown>({ dialect: dialectOrKysely as Dialect }) : dialectOrKysely as Kysely<unknown>, options.now ?? (() => new Date()));
    this.ownsConnection = owns; this.defaultQuota = options.accountQuotaBytes ?? 1024 ** 3;
  }
  withTransaction<T>(action: (repository: MailArchiveRepository) => Promise<T>): Promise<T> {
    return mailTransaction(this.kysely, async (trx) => action(new MailArchiveRepository(trx, { now: this.now, accountQuotaBytes: this.defaultQuota })));
  }
  listRecoverableCleanupOperations(input:MailCleanupRecoveryRequest){return listRecoverableCleanupOperations(this.kysely,input);}
  recordSyncFailure(input:MailSyncFailureInput){return recordMailSyncFailure(this.kysely,input,this.now());}
  recordUsage(input:MailUsageInput){return recordMailUsage(this.kysely,input);}
  getUsageSummary(input:MailConsumerScope){return getMailUsageSummary(this.kysely,input);}
  changeRetention(input:MailRetentionRequest){return changeMailRetention(this.kysely,input,this.now());}
  async bootstrap(): Promise<void> { await bootstrapMailArchive(this.kysely); }
  async destroy(): Promise<void> { if (this.ownsConnection) await this.kysely.destroy(); }
  async registerSource(input: MailSourceInput): Promise<MailSource> {
    sourceKey(input); bounded(input.connectionId); bounded(input.email, 320);
    if (input.provider !== "gmail" || !["work", "personal"].includes(input.group)) throw new MailArchiveError("invalid");
    const quota = input.quotaBytes ?? this.defaultQuota;
    if (!Number.isSafeInteger(quota) || quota < 1 || quota > 10 * 1024 ** 3) throw new MailArchiveError("invalid");
    const accountLabel = input.accountLabel ?? input.email; bounded(accountLabel, 320);
    return mailTransaction(this.kysely, async (trx) => {
      await sql`INSERT INTO mail_sources(owner_id,account_id,provider,connection_id,email,account_label,source_group,namespace,quota_bytes)
        VALUES(${input.ownerId},${input.accountId},${input.provider},${input.connectionId},${input.email},${accountLabel},${input.group},${mailObjectNamespace(input.ownerId,input.provider,input.connectionId)},${quota})
        ON CONFLICT(owner_id,account_id) DO NOTHING`.execute(trx);
      const row = (await sql<SourceRow>`SELECT * FROM mail_sources WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} FOR UPDATE`.execute(trx)).rows[0];
      if (!row || row.connection_id !== input.connectionId || row.provider !== input.provider || row.email !== input.email) throw new MailArchiveError("conflict");
      if (Number(row.used_bytes) > quota) throw new MailArchiveError("quota", "Email archive quota exceeded");
      const updated = (await sql<SourceRow>`UPDATE mail_sources SET quota_bytes=${quota},source_group=${input.group},account_label=${accountLabel},paused=false
        WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} RETURNING *`.execute(trx)).rows[0]!;
      return source(updated);
    });
  }
  async getSource(input: MailSourceKey): Promise<MailSource | null> {
    sourceKey(input);
    const row = (await sql<SourceRow>`SELECT * FROM mail_sources WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(this.kysely)).rows[0];
    return row ? source(row) : null;
  }
  async listSources(ownerId: string): Promise<MailSource[]> {
    bounded(ownerId);
    return (await sql<SourceRow>`SELECT * FROM mail_sources WHERE owner_id=${ownerId} ORDER BY account_id LIMIT 100`.execute(this.kysely)).rows.map(source);
  }
  async listGrantedSources(input: { ownerId: string; appId: string }): Promise<MailSource[]> {
    bounded(input.ownerId); bounded(input.appId);
    return (await sql<SourceRow>`SELECT s.* FROM mail_sources s JOIN mail_consumer_grants g ON g.owner_id=s.owner_id AND g.account_id=s.account_id
      WHERE s.owner_id=${input.ownerId} AND g.app_id=${input.appId} AND NOT g.revoked ORDER BY s.account_id LIMIT 100`.execute(this.kysely)).rows.map(source);
  }
  async getGrantedMessageById(input: { ownerId: string; appId: string; id: string }): Promise<ArchivedMessage | null> {
    bounded(input.ownerId); bounded(input.appId); bounded(input.id);
    const found = (await sql<{ account_id: string }>`SELECT m.account_id FROM mail_messages m JOIN mail_consumer_grants g ON g.owner_id=m.owner_id AND g.account_id=m.account_id
      WHERE m.owner_id=${input.ownerId} AND m.id=${input.id} AND m.deleted_at IS NULL AND g.app_id=${input.appId} AND NOT g.revoked LIMIT 1`.execute(this.kysely)).rows[0];
    return found ? this.readMessage({ ...input, accountId: found.account_id }) : null;
  }
  async grantConsumer(input: MailConsumerScope & { from?: string; until?: string; purpose?: string }): Promise<void> {
    sourceKey(input); bounded(input.appId); if (input.from) validDate(input.from); if (input.until) validDate(input.until);
    const purpose = input.purpose ?? "newsletter"; bounded(purpose, 64);
    await sql`INSERT INTO mail_consumer_grants(owner_id,account_id,app_id,range_from,range_until,purpose)
      VALUES(${input.ownerId},${input.accountId},${input.appId},${input.from ?? null},${input.until ?? null},${purpose})
      ON CONFLICT(owner_id,account_id,app_id) DO UPDATE SET range_from=EXCLUDED.range_from,range_until=EXCLUDED.range_until,purpose=EXCLUDED.purpose,revoked=false`.execute(this.kysely);
  }
  async revokeConsumer(input: MailConsumerScope): Promise<void> {
    sourceKey(input); bounded(input.appId);
    await sql`UPDATE mail_consumer_grants SET revoked=true WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND app_id=${input.appId}`.execute(this.kysely);
  }
  async saveMessage(input: MailMessageInput): Promise<{ kind: "saved"; message: ArchivedMessage } | { kind: "suppressed" }> {
    sourceKey(input); bounded(input.messageId, 512); bounded(input.threadId, 512);
    if (input.subject.length > 2000 || input.sender.length > 1000 || (input.textSnippet?.length ?? 0) > 4000 || input.labels.length > 100 || input.labels.some((label) => !label || label.length > 256)) throw new MailArchiveError("invalid");
    validDate(input.receivedAt);
    if (input.object && (!/^[a-f0-9]{64}$/.test(input.object.digest) || !Number.isSafeInteger(input.object.sizeBytes) || input.object.sizeBytes < 0 || input.object.sizeBytes > MAIL_MAX_OBJECT_BYTES)) throw new MailArchiveError("invalid");
    return mailTransaction(this.kysely, async (trx) => {
      const account = (await sql<SourceRow>`SELECT * FROM mail_sources WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} FOR UPDATE`.execute(trx)).rows[0];
      if (!account||account.paused) throw new MailArchiveError("denied");
      if (input.object && input.object.namespace !== account.namespace) throw new MailArchiveError("invalid");
      if (input.object) await this.lockObject(trx, input.object.namespace, input.object.digest);
      const prior = (await sql<MessageRow>`SELECT * FROM mail_messages WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId} FOR UPDATE`.execute(trx)).rows[0];
      if (prior?.deleted_at) return { kind: "suppressed" };
      const size = input.object?.sizeBytes ?? 0;
      const used = Number(account.used_bytes) - Number(prior?.size_bytes ?? 0) + size;
      if (used > Number(account.quota_bytes)) throw new MailArchiveError("quota", "Email archive quota exceeded");
      const metadata = JSON.stringify({ ...input, object: undefined });
      // Idempotent replays keep revision and manual corrections. A label-only
      // update follows its dedicated path and never changes content identity.
      const id = prior?.id ?? randomUUID();
      const same = prior && (await sql<{ same: boolean }>`SELECT (metadata=${metadata}::jsonb AND object IS NOT DISTINCT FROM ${input.object ? JSON.stringify(input.object) : null}::jsonb) AS same
        FROM mail_messages WHERE id=${id}`.execute(trx)).rows[0]?.same;
      const revision = prior ? prior.revision + (same ? 0 : 1) : 1;
      const row = (await sql<MessageRow>`INSERT INTO mail_messages(id,owner_id,account_id,message_id,metadata,object,size_bytes,received_at,revision)
        VALUES(${id},${input.ownerId},${input.accountId},${input.messageId},${metadata}::jsonb,${input.object ? JSON.stringify(input.object) : null}::jsonb,${size},${input.receivedAt},${revision})
        ON CONFLICT(owner_id,account_id,message_id) DO UPDATE SET metadata=EXCLUDED.metadata,object=EXCLUDED.object,size_bytes=EXCLUDED.size_bytes,received_at=EXCLUDED.received_at,revision=EXCLUDED.revision
        RETURNING *`.execute(trx)).rows[0]!;
      await sql`UPDATE mail_sources SET used_bytes=${used} WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx);
      return { kind: "saved", message: archived(row) };
    });
  }
  async getStoredMessage(input: MailSourceKey & { messageId: string }): Promise<ArchivedMessage | null> {
    sourceKey(input); bounded(input.messageId, 512);
    const row = (await sql<MessageRow>`SELECT * FROM mail_messages WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId} AND deleted_at IS NULL`.execute(this.kysely)).rows[0];
    return row ? this.withClassification(archived(row)) : null;
  }
  async readMessage(input: MailConsumerScope & { id: string }): Promise<ArchivedMessage | null> {
    return mailTransaction(this.kysely, async (trx) => {
      const row = await grantedMessage(trx, input, true);
      return row ? this.withClassification(archived(row), trx) : null;
    });
  }
  async listMessages(input: MailConsumerScope & { limit?: number; before?: string; beforeId?: string; search?: string }): Promise<ArchivedMessage[]> {
    sourceKey(input); bounded(input.appId); if (input.before) validDate(input.before);
    if (input.beforeId) { bounded(input.beforeId); if (!input.before) throw new MailArchiveError("invalid"); }
    if ((input.search?.length ?? 0) > 200) throw new MailArchiveError("invalid");
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));
    return mailTransaction(this.kysely, async (trx) => {
      const grant = (await sql<{ range_from: Date | string | null; range_until: Date | string | null }>`SELECT * FROM mail_consumer_grants WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND app_id=${input.appId} AND NOT revoked FOR SHARE`.execute(trx)).rows[0];
      if (!grant) throw new MailArchiveError("denied");
      const rows = (await sql<MessageRow>`SELECT * FROM mail_messages WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND deleted_at IS NULL
        ${grant.range_from ? sql`AND received_at >= ${grant.range_from}` : sql``}
        ${grant.range_until ? sql`AND received_at <= ${grant.range_until}` : sql``}
        ${input.before ? input.beforeId ? sql`AND (received_at < ${input.before} OR (received_at = ${input.before} AND id < ${input.beforeId}))` : sql`AND received_at < ${input.before}` : sql``}
        ${input.search ? sql`AND (metadata->>'subject' ILIKE ${`%${input.search.replace(/[%_\\]/g, "\\$&")}%`} OR metadata->>'sender' ILIKE ${`%${input.search.replace(/[%_\\]/g, "\\$&")}%`})` : sql``}
        ORDER BY received_at DESC,id DESC LIMIT ${limit}`.execute(trx)).rows;
      return Promise.all(rows.map((row) => this.withClassification(archived(row), trx)));
    });
  }
  async updateLabels(input: MailSourceKey & { messageId: string; labels: string[] }): Promise<boolean> {
    sourceKey(input); bounded(input.messageId, 512);
    if (input.labels.length > 100 || input.labels.some((label) => !label || label.length > 256)) throw new MailArchiveError("invalid");
    const result = await sql`UPDATE mail_messages SET metadata=jsonb_set(metadata,'{labels}',${JSON.stringify(input.labels)}::jsonb),revision=revision+1
      WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId} AND deleted_at IS NULL RETURNING id`.execute(this.kysely);
    return result.rows.length === 1;
  }
  async isSuppressed(input: MailSourceKey & { messageId: string }): Promise<boolean> {
    sourceKey(input); bounded(input.messageId, 512);
    return (await sql`SELECT 1 FROM mail_messages WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId} AND deleted_at IS NOT NULL`.execute(this.kysely)).rows.length === 1;
  }
  async suppressMessage(input: MailSourceKey & { messageId: string; baseRevision?: number }): Promise<boolean> {
    sourceKey(input); bounded(input.messageId, 512);
    if (input.baseRevision !== undefined && (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1)) throw new MailArchiveError("invalid");
    return mailTransaction(this.kysely, async (trx) => {
      const account = (await sql<SourceRow>`SELECT * FROM mail_sources WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} FOR UPDATE`.execute(trx)).rows[0];
      if (!account) throw new MailArchiveError("denied");
      const row = (await sql<MessageRow>`UPDATE mail_messages SET deleted_at=${this.now()},object=NULL,size_bytes=0,metadata='{}'::jsonb,correction=NULL,revision=revision+1
        WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId} AND deleted_at IS NULL
        ${input.baseRevision !== undefined ? sql`AND revision=${input.baseRevision}` : sql``} RETURNING *`.execute(trx)).rows[0];
      if (!row) return false;
      // RETURNING size would now be zero; compute quota from remaining rows,
      // while holding the same account lock used by all imports/deletions.
      await sql`UPDATE mail_sources SET used_bytes=(SELECT COALESCE(SUM(size_bytes),0) FROM mail_messages WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND deleted_at IS NULL) WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx);
      await sql`DELETE FROM mail_classifications WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId}`.execute(trx);
      await sql`DELETE FROM mail_classification_deferrals WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId}`.execute(trx);
      await sql`DELETE FROM mail_reading WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId}`.execute(trx);
      return true;
    });
  }
  async advanceCursor(input: MailSourceKey & { baseRevision: number; cursor: string }): Promise<boolean> {
    sourceKey(input); bounded(input.cursor, 256);
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new MailArchiveError("invalid");
    return (await sql`UPDATE mail_sources SET cursor=${input.cursor},revision=revision+1 WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND revision=${input.baseRevision} RETURNING account_id`.execute(this.kysely)).rows.length === 1;
  }
  async saveClassification(input: MailSourceKey & { messageId: string; classification: MailClassification }): Promise<void> {
    const c = input.classification; const result = JevEmailTriageResultSchema.parse(c.result);
    if (!/^[a-f0-9]{64}$/.test(c.fingerprint) || !["snippet", "verified"].includes(c.contextKind) || c.recipe !== "email-triage-v1") throw new MailArchiveError("invalid");
    bounded(c.modelPolicyVersion, 100); sourceKey(input); bounded(input.messageId, 512);
    await mailTransaction(this.kysely, async (trx) => {
      const row = (await sql<MessageRow>`SELECT * FROM mail_messages WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId} AND deleted_at IS NULL FOR UPDATE`.execute(trx)).rows[0];
      if (!row) throw new MailArchiveError("missing");
      await sql`INSERT INTO mail_classifications(owner_id,account_id,message_id,fingerprint,context_kind,recipe,model_policy_version,result)
        VALUES(${input.ownerId},${input.accountId},${input.messageId},${c.fingerprint},${c.contextKind},${c.recipe},${c.modelPolicyVersion},${JSON.stringify(result)}::jsonb)
        ON CONFLICT DO NOTHING`.execute(trx);
    });
  }
  async getClassification(input: MailSourceKey & { messageId: string; fingerprint: string; contextKind: string; modelPolicyVersion: string }): Promise<MailClassification | null> {
    sourceKey(input); bounded(input.messageId, 512);
    const row = (await sql<{ result: unknown }>`SELECT c.result FROM mail_classifications c JOIN mail_messages m ON m.owner_id=c.owner_id AND m.account_id=c.account_id AND m.message_id=c.message_id
      WHERE c.owner_id=${input.ownerId} AND c.account_id=${input.accountId} AND c.message_id=${input.messageId} AND c.fingerprint=${input.fingerprint}
      AND c.context_kind=${input.contextKind} AND c.recipe='email-triage-v1' AND c.model_policy_version=${input.modelPolicyVersion} AND m.deleted_at IS NULL`.execute(this.kysely)).rows[0];
    return row ? { fingerprint: input.fingerprint, contextKind: input.contextKind as MailClassification["contextKind"], recipe: "email-triage-v1", modelPolicyVersion: input.modelPolicyVersion, result: JevEmailTriageResultSchema.parse(json(row.result)) } : null;
  }
  async recordDeferredClassification(input: MailSourceKey & { messageId: string; fingerprint: string; contextKind: "verified" | "snippet"; modelPolicyVersion: string; outcome: "unknown" | "result_expired" }): Promise<void> {
    sourceKey(input); bounded(input.messageId,512); bounded(input.modelPolicyVersion,100);
    if (!/^[a-f0-9]{64}$/.test(input.fingerprint) || !["verified","snippet"].includes(input.contextKind) || !["unknown","result_expired"].includes(input.outcome)) throw new MailArchiveError("invalid");
    await mailTransaction(this.kysely, async (trx) => {
      // Retain only the exact attempted immutable content. Row locking fences
      // deletion/replacement while recording the provider's terminal outcome.
      const row = (await sql<MessageRow>`SELECT * FROM mail_messages WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND message_id=${input.messageId} AND deleted_at IS NULL FOR UPDATE`.execute(trx)).rows[0];
      if (!row?.object || json<MailObject>(row.object).digest !== input.fingerprint) throw new MailArchiveError("conflict");
      await sql`INSERT INTO mail_classification_deferrals(owner_id,account_id,message_id,fingerprint,context_kind,recipe,model_policy_version,outcome)
        VALUES(${input.ownerId},${input.accountId},${input.messageId},${input.fingerprint},${input.contextKind},'email-triage-v1',${input.modelPolicyVersion},${input.outcome})
        ON CONFLICT DO NOTHING`.execute(trx);
    });
  }
  private async withClassification(message: ArchivedMessage, db: Kysely<unknown> = this.kysely): Promise<ArchivedMessage> {
    const row = (await sql<{ fingerprint: string; context_kind: "snippet" | "verified"; model_policy_version: string; result: unknown }>`SELECT * FROM mail_classifications WHERE owner_id=${message.ownerId} AND account_id=${message.accountId} AND message_id=${message.messageId}
      ${message.object ? sql`AND fingerprint=${message.object.digest}` : sql``} ORDER BY model_policy_version DESC LIMIT 1`.execute(db)).rows[0];
    return { ...message, classification: row ? { fingerprint: row.fingerprint, contextKind: row.context_kind, recipe: "email-triage-v1", modelPolicyVersion: row.model_policy_version, result: JevEmailTriageResultSchema.parse(json(row.result)) } : null };
  }
  async setCorrection(input: MailConsumerScope & { id: string; correction: "newsletter" | "not_newsletter" | null; baseRevision: number }): Promise<boolean> {
    if (input.correction !== null && !["newsletter", "not_newsletter"].includes(input.correction)) throw new MailArchiveError("invalid");
    return mailTransaction(this.kysely, async (trx) => {
      const row = await grantedMessage(trx, input, "update"); if (!row) throw new MailArchiveError("missing");
      return (await sql`UPDATE mail_messages SET correction=${input.correction},revision=revision+1 WHERE id=${input.id} AND owner_id=${input.ownerId} AND revision=${input.baseRevision} AND deleted_at IS NULL RETURNING id`.execute(trx)).rows.length === 1;
    });
  }
  async listClassificationCandidates(input: MailConsumerScope & { modelPolicyVersion: string; limit?: number }): Promise<ArchivedMessage[]> {
    sourceKey(input); bounded(input.appId); bounded(input.modelPolicyVersion,100);
    const limit = Math.min(20,Math.max(1,input.limit??20));
    return mailTransaction(this.kysely, async (trx) => {
      const grant = (await sql<{ range_from: Date | string | null; range_until: Date | string | null }>`SELECT * FROM mail_consumer_grants WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND app_id=${input.appId} AND NOT revoked FOR SHARE`.execute(trx)).rows[0];
      if (!grant) throw new MailArchiveError("denied");
      const rows = (await sql<MessageRow>`SELECT m.* FROM mail_messages m WHERE m.owner_id=${input.ownerId} AND m.account_id=${input.accountId} AND m.deleted_at IS NULL AND m.object IS NOT NULL
        ${grant.range_from ? sql`AND m.received_at >= ${grant.range_from}` : sql``}
        ${grant.range_until ? sql`AND m.received_at <= ${grant.range_until}` : sql``}
        AND NOT EXISTS(SELECT 1 FROM mail_classifications c WHERE c.owner_id=m.owner_id AND c.account_id=m.account_id AND c.message_id=m.message_id AND c.fingerprint=m.object->>'digest' AND c.recipe='email-triage-v1' AND c.model_policy_version=${input.modelPolicyVersion})
        AND NOT EXISTS(SELECT 1 FROM mail_classification_deferrals d WHERE d.owner_id=m.owner_id AND d.account_id=m.account_id AND d.message_id=m.message_id AND d.fingerprint=m.object->>'digest' AND d.context_kind IN ('snippet','verified') AND d.recipe='email-triage-v1' AND d.model_policy_version=${input.modelPolicyVersion})
        ORDER BY m.received_at,m.id LIMIT ${limit}`.execute(trx)).rows;
      return rows.map(archived);
    });
  }
  async suppressGrantedMessage(input: MailConsumerScope & { id: string; baseRevision: number }): Promise<boolean> {
    return mailTransaction(this.kysely, async (trx) => {
      // The account lock precedes the message lock everywhere that changes
      // retention/quota. Keep revocation locked through the final CAS write.
      await sql`SELECT account_id FROM mail_sources WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} FOR UPDATE`.execute(trx);
      const message = await grantedMessage(trx,input,"update");
      if (!message) throw new MailArchiveError("missing");
      return new MailArchiveRepository(trx,{ now:this.now,accountQuotaBytes:this.defaultQuota }).suppressMessage({ ownerId:input.ownerId,accountId:input.accountId,messageId:message.message_id,baseRevision:input.baseRevision });
    });
  }
  getReadingState(input: Parameters<typeof getReadingState>[1]) { return getReadingState(this.kysely, input); }
  saveReadingState(input: Parameters<typeof saveReadingState>[1]) { return saveReadingState(this.kysely, input); }
  protected async lockObject(db: Kysely<unknown>, namespace: string, digest: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${namespace}),hashtext(${digest}))`.execute(db);
  }
  async leaseObject(input: MailConsumerScope & { id: string; leaseMs?: number }): Promise<{ token: string; object: MailObject } | null> {
    return mailTransaction(this.kysely, async (trx) => {
      const observed = await grantedMessage(trx, input); if (!observed?.object) return null;
      const object = json<MailObject>(observed.object); await this.lockObject(trx, object.namespace, object.digest);
      const row = await grantedMessage(trx, input, true);
      if (!row?.object || json<MailObject>(row.object).digest !== object.digest) throw new MailArchiveError("conflict");
      const token = randomUUID(); const expiresAt = new Date(this.now().getTime() + Math.min(30_000, Math.max(1000, input.leaseMs ?? 30_000)));
      await sql`INSERT INTO mail_object_leases(namespace,digest,token,expires_at) VALUES(${object.namespace},${object.digest},${token},${expiresAt})`.execute(trx);
      return { token, object };
    });
  }
  async leaseImport(input: MailSourceKey & { digest: string; leaseMs?: number }): Promise<{ token: string; namespace: string }> {
    sourceKey(input); if (!/^[a-f0-9]{64}$/.test(input.digest)) throw new MailArchiveError("invalid");
    return mailTransaction(this.kysely, async (trx) => {
      const source = (await sql<SourceRow>`SELECT * FROM mail_sources WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx)).rows[0];
      if (!source) throw new MailArchiveError("denied");
      await this.lockObject(trx, source.namespace, input.digest);
      const token = randomUUID();
      await sql`INSERT INTO mail_object_leases(namespace,digest,token,expires_at) VALUES(${source.namespace},${input.digest},${token},${new Date(this.now().getTime()+Math.min(30_000,Math.max(1000,input.leaseMs??30_000)))})`.execute(trx);
      return { token,namespace: source.namespace };
    });
  }
  async releaseObjectLease(input: MailObject & { token: string }): Promise<void> {
    await sql`DELETE FROM mail_object_leases WHERE namespace=${input.namespace} AND digest=${input.digest} AND token=${input.token}`.execute(this.kysely);
  }
  async pruneExpiredObjectLeases(input: { limit?: number } = {}): Promise<number> {
    const limit=Math.min(500,Math.max(1,input.limit??100));
    if (!Number.isSafeInteger(limit)) throw new MailArchiveError("invalid");
    const removed=await sql`WITH due AS (
      SELECT namespace,digest,token FROM mail_object_leases WHERE expires_at<=${this.now()}
      ORDER BY expires_at,namespace,digest,token LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ) DELETE FROM mail_object_leases l USING due d WHERE l.namespace=d.namespace AND l.digest=d.digest AND l.token=d.token RETURNING l.token`.execute(this.kysely);
    return removed.rows.length;
  }
  async collectObject(namespace: string, digest: string, remove: () => Promise<void>): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(namespace) || !/^[a-f0-9]{64}$/.test(digest)) throw new MailArchiveError("invalid");
    return mailTransaction(this.kysely, async (trx) => {
      await this.lockObject(trx, namespace, digest);
      await sql`DELETE FROM mail_object_leases WHERE namespace=${namespace} AND digest=${digest} AND expires_at<=${this.now()}`.execute(trx);
      const references = (await sql`SELECT 1 FROM mail_messages WHERE object->>'namespace'=${namespace} AND object->>'digest'=${digest} AND deleted_at IS NULL LIMIT 1`.execute(trx)).rows;
      const leases = (await sql`SELECT 1 FROM mail_object_leases WHERE namespace=${namespace} AND digest=${digest} LIMIT 1`.execute(trx)).rows;
      if (references.length || leases.length) return false;
      await remove(); return true;
    });
  }
}
