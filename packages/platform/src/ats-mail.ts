import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AtsDB } from './ats-db.js';
import { applicationColumns, mapApplication } from './ats-mappers.js';
import { enqueueAtsNotification } from './ats-notifications.js';
import { AtsApplicationNotFoundError, AtsMissingSenderError } from './ats-errors.js';
import { AtsMailSchema, LegacyInboxSchema, type AtsMailInput } from './ats-mail-input.js';
export { AtsMailSchema, type AtsMailInput } from './ats-mail-input.js';

export async function importAtsMail(db: AtsDB, input: AtsMailInput, at: string, options: { notify: boolean; allowMissingSender?: boolean } = { notify: true }) {
  const mail = (options.allowMissingSender && !options.notify ? LegacyInboxSchema : AtsMailSchema).parse(input);
  await db.ready;
  return db.transaction(async (trx) => {
    // Serialize email promotion and imports for the same sender.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${mail.senderEmail}))`.execute(trx.executor);
    const candidates = await trx.executor.selectFrom('ats_applications').select('id')
      .where('candidate_email', '=', mail.senderEmail).where('deleted_at', 'is', null).where('disposition', '=', 'active')
      .orderBy('created_at', 'desc').limit(2).execute();
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    const inserted = await trx.executor.insertInto('ats_inbox_messages').values({
      id: randomUUID(), message_id: mail.messageId, thread_id: mail.threadId, sender_name: mail.senderName,
      sender_email: mail.senderEmail, subject: mail.subject, body: mail.body, received_at: mail.receivedAt,
      source_url: mail.sourceUrl, application_id: candidate?.id ?? null,
      category: candidate ? 'candidate' : mail.category,
    }).onConflict((oc) => oc.column('message_id').doNothing()).returningAll().executeTakeFirst();
    if (!inserted) return trx.executor.selectFrom('ats_inbox_messages').selectAll().where('message_id', '=', mail.messageId).executeTakeFirstOrThrow();
    for (const file of mail.attachments) await trx.executor.insertInto('ats_mail_attachments').values({ id: randomUUID(), message_id: inserted.id,
      filename: file.filename, content_type: file.contentType, bytes: Buffer.from(file.base64, 'base64') }).execute();
    if (options.notify && !['moderation', 'vendor'].includes(inserted.category)) await enqueueAtsNotification(trx, `mail:${mail.messageId}`, {
      name: mail.senderName || mail.senderEmail, email: mail.senderEmail, role: mail.subject.slice(0, 100),
      path: candidate ? `/admin/ats/${candidate.id}` : '/admin/ats/inbox', source: 'group_email',
    }, at);
    return inserted;
  });
}

export async function listAtsInbox(db: AtsDB, applicationId?: string) {
  await db.ready;
  let query = db.executor.selectFrom('ats_inbox_messages').selectAll('ats_inbox_messages')
    .where((eb) => eb.or([
      eb('application_id', 'is', null),
      eb.exists(eb.selectFrom('ats_applications').select('id').whereRef('ats_applications.id', '=', 'ats_inbox_messages.application_id').where('deleted_at', 'is', null)),
    ]));
  if (applicationId) query = query.where('application_id', '=', applicationId);
  const messages = await query.orderBy('received_at', 'desc').limit(200).execute();
  if (!messages.length) return [];
  const files = await db.executor.selectFrom('ats_mail_attachments').select(['id', 'message_id', 'filename', 'content_type'])
    .where('message_id', 'in', messages.map((mail) => mail.id)).execute();
  return messages.map((mail) => ({ ...mail, attachments: files.filter((file) => file.message_id === mail.id) }));
}

export async function promoteAtsMail(db: AtsDB, inboxId: string, roleSlug: string, actorId: string, at: string) {
  await db.ready;
  return db.transaction(async (trx) => {
    const initial = await trx.executor.selectFrom('ats_inbox_messages').selectAll().where('id', '=', inboxId).executeTakeFirst();
    if (!initial) throw new AtsApplicationNotFoundError();
    await sql`SELECT pg_advisory_xact_lock(hashtext(${initial.sender_email}))`.execute(trx.executor);
    const mail = await trx.executor.selectFrom('ats_inbox_messages').selectAll().where('id', '=', inboxId).forUpdate().executeTakeFirstOrThrow();
    if (!mail.sender_email) throw new AtsMissingSenderError();
    let candidate = await trx.executor.selectFrom('ats_applications').select(applicationColumns)
      .where('deleted_at', 'is', null).where((eb) => mail.application_id ? eb('id', '=', mail.application_id) : eb.and([eb('candidate_email', '=', mail.sender_email), eb('role_slug', '=', roleSlug), eb('disposition', '=', 'active')]))
      .orderBy('created_at', 'desc').executeTakeFirst();
    if (mail.application_id && !candidate) throw new AtsApplicationNotFoundError();
    if (!candidate) {
      const id = randomUUID();
      const hash = createHash('sha256').update(`group_email:${mail.message_id}`).digest('hex');
      const retentionUntil = new Date(Date.parse(at) + 365 * 86400_000).toISOString();
      candidate = await trx.executor.insertInto('ats_applications').values({
        id, submission_key: hash, role_slug: roleSlug, candidate_name: mail.sender_name || mail.sender_email,
        candidate_email: mail.sender_email, phone: null, location: 'Not provided', availability: 'Not provided',
        links: JSON.stringify({ email: mail.source_url }), answers: '[]', source: 'group_email', stage: 'applied', disposition: 'active',
        revision: 1, owner_id: null, tags: '[]', next_action_at: null, disposition_reason: null, consent_at: null, retention_until: retentionUntil,
        resume_filename: '', resume_content_type: '', resume_bytes: new Uint8Array(), created_at: at, updated_at: at, deleted_at: null,
      }).returning(applicationColumns).executeTakeFirstOrThrow();
      await trx.executor.insertInto('ats_application_events').values({ id: randomUUID(), application_id: id, event_type: 'email_promoted', actor_id: actorId,
        from_stage: null, to_stage: 'applied', detail: JSON.stringify({ messageId: mail.message_id, source: 'group_email' }), created_at: at }).execute();
    }
    await trx.executor.updateTable('ats_inbox_messages').set({ application_id: candidate.id, category: 'candidate' })
      .where('id', '=', inboxId).where('application_id', 'is', null).where('category', 'not in', ['moderation', 'vendor']).execute();
    return mapApplication(candidate);
  });
}
