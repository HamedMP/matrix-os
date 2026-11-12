import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import {
  SiteIdSchema, SiteInvitationAuditCursorSchema, SiteInvitationAuditDetailsSchema,
  SiteInvitationAuditEventSchema, SiteInvitationAuditEventTypeSchema, SiteInvitationAuditPageSchema,
  type SiteInvitationAuditDetails,
} from '@matrix-os/contracts';
import type { PlatformDB } from '../db.js';
import { SiteError } from './types.js';

const InputSchema = z.object({
  siteId: SiteIdSchema,
  invitationId: SiteIdSchema.nullable().optional(),
  type: SiteInvitationAuditEventTypeSchema,
  actorKind: z.enum(['owner', 'viewer', 'system']),
  actorReference: z.string().min(1).max(255).regex(/^user_[A-Za-z0-9_-]+$/).nullable(),
  details: SiteInvitationAuditDetailsSchema,
}).strict();
const QuerySchema = z.object({
  limit: z.number().int().min(1).max(100), cursor: SiteInvitationAuditCursorSchema.optional(),
}).strict();
const CursorSchema = z.object({ at: z.iso.datetime(), id: SiteIdSchema }).strict();

function decodeCursor(value: string): z.infer<typeof CursorSchema> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const cursor = CursorSchema.safeParse(parsed);
    if (cursor.success) return cursor.data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new SiteError('invalid_request');
}
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url');
}

/** Call inside the same transaction that changes invitation or grant authority. */
export async function appendSiteInvitationAuditEvent(db: PlatformDB, input: unknown): Promise<string> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) throw new SiteError('invalid_request');
  const event = parsed.data;
  const id = randomUUID();
  await db.executor.insertInto('public_site_access_audit_events').values({
    id, site_id: event.siteId, invitation_id: event.invitationId ?? null,
    event_type: event.type, actor_kind: event.actorKind, actor_reference: event.actorReference,
    details: event.details as SiteInvitationAuditDetails, occurred_at: new Date(),
  }).execute();
  return id;
}

/** Owner predicate lives in the SQL read; a cursor never carries authority. */
export async function listSiteInvitationAuditEvents(
  db: PlatformDB, ownerId: string, siteId: string, input: unknown,
): Promise<z.infer<typeof SiteInvitationAuditPageSchema>> {
  const parsed = QuerySchema.safeParse(input);
  if (!parsed.success || !SiteIdSchema.safeParse(siteId).success) throw new SiteError('invalid_request');
  const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
  let query = db.executor.selectFrom('public_site_access_audit_events as e')
    .innerJoin('public_sites as s', 's.id', 'e.site_id')
    .select(['e.id', 'e.invitation_id', 'e.event_type', 'e.actor_kind', 'e.details', 'e.occurred_at'])
    .where('s.owner_id', '=', ownerId).where('s.id', '=', siteId);
  if (cursor) query = query.where(eb => eb.or([
    eb('e.occurred_at', '<', new Date(cursor.at)),
    eb.and([eb('e.occurred_at', '=', new Date(cursor.at)), eb('e.id', '<', cursor.id)]),
  ]));
  const rows = await query.orderBy('e.occurred_at', 'desc').orderBy('e.id', 'desc').limit(parsed.data.limit + 1).execute();
  const page = rows.slice(0, parsed.data.limit);
  const events = page.map(row => SiteInvitationAuditEventSchema.parse({
    id: row.id, invitationId: row.invitation_id, type: row.event_type,
    actorKind: row.actor_kind, details: row.details, occurredAt: row.occurred_at.toISOString(),
  }));
  return SiteInvitationAuditPageSchema.parse({ events,
    nextCursor: rows.length > parsed.data.limit && page.length
      ? encodeCursor(page[page.length - 1]!.occurred_at, page[page.length - 1]!.id) : null,
  });
}
