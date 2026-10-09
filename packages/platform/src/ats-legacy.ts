import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import { ATS_STAGES, ATS_DISPOSITIONS } from './ats-types.js';
import { AtsAttachmentSchema } from './ats-attachments.js';
import { AtsMailSchema } from './ats-mail-input.js';
import { applicationColumns, mapApplication } from './ats-mappers.js';
import type { AtsDB } from './ats-db.js';

export const LegacyCandidateSchema = z.object({
  legacyKey: z.string().min(1).max(200), name: z.string().trim().min(1).max(200), email: z.email().max(320).transform((v) => v.toLowerCase()),
  roleSlug: z.string().regex(/^[a-z0-9-]{1,100}$/), stage: z.enum(ATS_STAGES), disposition: z.enum(ATS_DISPOSITIONS),
  summary: z.string().max(10_000), createdAt: z.iso.datetime(),
  notes: z.array(z.object({ body: z.string().min(1).max(10_000), createdAt: z.iso.datetime() })).max(100),
  emails: z.array(AtsMailSchema.omit({ attachments: true })).max(100),
  attachments: z.array(AtsAttachmentSchema).max(5).refine((files) => files.reduce((sum, f) => sum + Buffer.from(f.base64, 'base64').length, 0) <= 5 * 1024 * 1024),
});
export async function importLegacyCandidate(db: AtsDB, value: z.input<typeof LegacyCandidateSchema>, actorId: string, at: string) {
  const input = LegacyCandidateSchema.parse(value);
  await db.ready;
  return db.transaction(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${input.email}))`.execute(trx.executor);
    const mapping = await trx.executor.selectFrom('ats_legacy_imports').selectAll().where('legacy_key', '=', input.legacyKey).executeTakeFirst();
    if (mapping) {
      const row = await trx.executor.selectFrom('ats_applications').select(applicationColumns).where('id', '=', mapping.application_id).where('deleted_at', 'is', null).executeTakeFirst();
      if (!row) throw new Error('Previously imported candidate is unavailable');
      return mapApplication(row);
    }
    const matches = await trx.executor.selectFrom('ats_applications').select(applicationColumns).where('candidate_email', '=', input.email)
      .where('role_slug', '=', input.roleSlug).where('deleted_at', 'is', null).where('disposition', '=', 'active').limit(2).execute();
    if (matches.length > 1) throw new Error('Ambiguous historical application match; explicit reconciliation required');
    let row = matches[0];
    if (!row) row = await trx.executor.insertInto('ats_applications').values({
      id: randomUUID(), submission_key: createHash('sha256').update(`legacy:${input.legacyKey}`).digest('hex'),
      role_slug: input.roleSlug, candidate_name: input.name, candidate_email: input.email,
      phone: null, location: 'Not provided', availability: 'Not provided', links: '{}', answers: '[]', source: 'legacy',
      stage: input.stage, disposition: input.disposition, revision: 1, owner_id: null, tags: '[]', next_action_at: null, disposition_reason: null,
      consent_at: null, retention_until: new Date(Date.parse(at) + 365 * 86400_000).toISOString(),
      resume_filename: '', resume_content_type: '', resume_bytes: new Uint8Array(), created_at: input.createdAt, updated_at: at, deleted_at: null,
    }).returning(applicationColumns).executeTakeFirstOrThrow();
    await trx.executor.insertInto('ats_legacy_imports').values({ legacy_key: input.legacyKey, application_id: row.id }).onConflict((oc) => oc.column('legacy_key').doNothing()).execute();
    await trx.executor.insertInto('ats_application_events').values({ id: randomUUID(), application_id: row.id, event_type: 'history_imported', actor_id: actorId,
      from_stage: null, to_stage: null, detail: JSON.stringify({ source: 'recruiting_tracker', originalStage: input.stage, originalDisposition: input.disposition }), created_at: at }).execute();
    const notes = [...(input.summary ? [{ body: `Imported recruiting summary:\n${input.summary}`, createdAt: input.createdAt }] : []), ...input.notes.map((note) => ({ ...note, body: `Imported note (original author not recorded):\n${note.body}` }))];
    for (const note of notes) await trx.executor.insertInto('ats_notes').values({ id: randomUUID(), application_id: row.id, author_id: actorId, body: note.body, created_at: note.createdAt, updated_at: note.createdAt }).execute();
    let attachmentMailId: string | undefined;
    for (const mail of input.emails) {
      const email = await trx.executor.insertInto('ats_inbox_messages').values({ id: randomUUID(), message_id: `legacy-${mail.messageId}`, thread_id: mail.threadId,
        sender_name: mail.senderName, sender_email: mail.senderEmail, subject: mail.subject, body: mail.body, received_at: mail.receivedAt,
        source_url: mail.sourceUrl, application_id: row.id, category: 'candidate' }).onConflict((oc) => oc.column('message_id').doNothing()).returning('id').executeTakeFirst();
      attachmentMailId ??= email?.id;
    }
    if (input.attachments.length && !attachmentMailId) {
      const id = randomUUID();
      await trx.executor.insertInto('ats_inbox_messages').values({ id, message_id: `legacy-${createHash('sha256').update(input.legacyKey).digest('hex')}`, thread_id: '',
        sender_name: input.name, sender_email: input.email, subject: 'CVs from recruiting history', body: 'Imported from the previous recruiting tracker.', received_at: input.createdAt,
        source_url: 'https://groups.google.com/a/finna.ai/g/careers', application_id: row.id, category: 'candidate' }).execute();
      attachmentMailId = id;
    }
    for (const file of input.attachments) await trx.executor.insertInto('ats_mail_attachments').values({ id: randomUUID(), message_id: attachmentMailId!,
      filename: file.filename, content_type: file.contentType, bytes: Buffer.from(file.base64, 'base64') }).execute();
    return mapApplication(row);
  });
}
