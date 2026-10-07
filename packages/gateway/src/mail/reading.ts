import { sql, type Kysely } from "kysely";
import { MailArchiveError, type MailConsumerScope, type MailReadingState } from "./types.js";

export type MailDb = Kysely<unknown>;
export function mailTransaction<T>(db: MailDb, action: (trx: MailDb) => Promise<T>): Promise<T> {
  return db.isTransaction ? action(db) : db.transaction().execute(action);
}
export interface MessageRow {
  id: string; owner_id: string; account_id: string; message_id: string;
  metadata: unknown; object: unknown; size_bytes: string | number;
  received_at: Date | string; deleted_at: Date | string | null; revision: number;
  correction: "newsletter" | "not_newsletter" | null;
}
export function json<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
export function iso(value: Date | string): string { return new Date(value).toISOString(); }
export function bounded(value: string, max = 256): void {
  if (!value || value.length > max || /\p{Cc}/u.test(value)) throw new MailArchiveError("invalid");
}
export function validateScope(input: MailConsumerScope): void { bounded(input.ownerId); bounded(input.accountId); bounded(input.appId); }
export async function grantedMessage(db: MailDb, input: MailConsumerScope & { id: string }, lock: boolean | "update" = false): Promise<MessageRow | null> {
  validateScope(input); bounded(input.id);
  const grant = await sql<{ range_from: Date | string | null; range_until: Date | string | null }>`
    SELECT range_from, range_until FROM mail_consumer_grants
    WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND app_id=${input.appId} AND NOT revoked
    ${lock ? sql`FOR SHARE` : sql``}
  `.execute(db);
  if (!grant.rows[0]) throw new MailArchiveError("denied");
  const row = (await sql<MessageRow>`SELECT * FROM mail_messages
    WHERE id=${input.id} AND owner_id=${input.ownerId} AND account_id=${input.accountId} AND deleted_at IS NULL
    ${lock === "update" ? sql`FOR UPDATE` : lock ? sql`FOR SHARE` : sql``}`.execute(db)).rows[0];
  const range = grant.rows[0];
  if (!row || (range.range_from && new Date(row.received_at) < new Date(range.range_from)) ||
    (range.range_until && new Date(row.received_at) > new Date(range.range_until))) return null;
  return row;
}
interface ReadingRow { saved: boolean; is_read: boolean; progress: number; revision: number }
function state(row: ReadingRow): MailReadingState { return { saved: row.saved, read: row.is_read, progress: row.progress, revision: row.revision }; }
export async function getReadingState(db: MailDb, input: MailConsumerScope & { id: string }): Promise<MailReadingState | null> {
  return mailTransaction(db, async (trx) => {
    const message = await grantedMessage(trx, input, true);
    if (!message) return null;
    const row = (await sql<ReadingRow>`SELECT * FROM mail_reading WHERE owner_id=${input.ownerId}
      AND account_id=${input.accountId} AND app_id=${input.appId} AND message_id=${message.message_id}`.execute(trx)).rows[0];
    return row ? state(row) : { saved: false, read: false, progress: 0, revision: 0 };
  });
}
export async function saveReadingState(db: MailDb, input: MailConsumerScope & { id: string; baseRevision: number; saved: boolean; read: boolean; progress: number }): Promise<MailReadingState | null> {
  if (!Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1 || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new MailArchiveError("invalid");
  return mailTransaction(db, async (trx) => {
    const message = await grantedMessage(trx, input, true);
    if (!message) throw new MailArchiveError("missing");
    if (input.baseRevision === 0) {
      const row = (await sql<ReadingRow>`INSERT INTO mail_reading(owner_id,account_id,app_id,message_id,saved,is_read,progress,revision)
        VALUES(${input.ownerId},${input.accountId},${input.appId},${message.message_id},${input.saved},${input.read},${input.progress},1)
        ON CONFLICT DO NOTHING RETURNING *`.execute(trx)).rows[0];
      return row ? state(row) : null;
    }
    const row = (await sql<ReadingRow>`UPDATE mail_reading SET saved=${input.saved},is_read=${input.read},progress=${input.progress},revision=revision+1
      WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND app_id=${input.appId} AND message_id=${message.message_id}
      AND revision=${input.baseRevision} RETURNING *`.execute(trx)).rows[0];
    return row ? state(row) : null;
  });
}
