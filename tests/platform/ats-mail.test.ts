import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAtsDb, destroyTestAtsDb } from './ats-db-test-helper.js';
import type { AtsDB } from '../../packages/platform/src/ats-db.js';
import { importAtsMail, listAtsInbox, promoteAtsMail } from '../../packages/platform/src/ats-mail.js';
import { deliverAtsNotifications } from '../../packages/platform/src/ats-notifications.js';

const at = '2026-10-09T10:00:00.000Z';
const mail = { messageId: 'abc123', threadId: 'thread123', senderName: 'Ada', senderEmail: 'ada@example.com', subject: 'Engineer application', body: 'I would like to apply.', receivedAt: at, sourceUrl: 'https://mail.google.com/mail/u/0/#all/abc123' };

describe('ATS email intake and notifications', () => {
  let db: AtsDB;
  beforeEach(async () => { ({ db } = await createTestAtsDb()); });
  afterEach(async () => { await destroyTestAtsDb(db); });

  it('imports unknown mail once into the review inbox without inventing consent or a candidate', async () => {
    await importAtsMail(db, mail, at);
    await importAtsMail(db, mail, at);
    expect(await listAtsInbox(db)).toHaveLength(1);
    expect(await db.executor.selectFrom('ats_applications').selectAll().execute()).toHaveLength(0);
    expect(await db.executor.selectFrom('ats_notification_outbox').selectAll().execute()).toHaveLength(1);
  });

  it('promotes email into an application atomically and attaches later replies', async () => {
    const first = await importAtsMail(db, mail, at);
    const candidate = await promoteAtsMail(db, first.id, 'senior-full-stack-engineer', 'user_reviewer', at);
    const replay = await promoteAtsMail(db, first.id, 'senior-full-stack-engineer', 'user_reviewer', at);
    expect(replay.id).toBe(candidate.id);
    const reply = await importAtsMail(db, { ...mail, messageId: 'abc124' }, at);
    expect(reply.application_id).toBe(candidate.id);
    expect(candidate.consentAt).toBeNull();
    expect(candidate.resumeFilename).toBe('');
  });

  it('keeps ambiguous senders in the inbox for a human to select the role', async () => {
    const first = await importAtsMail(db, mail, at);
    const candidate = await promoteAtsMail(db, first.id, 'founding-engineer', 'user_reviewer', at);
    const row = await db.executor.selectFrom('ats_applications').selectAll().where('id', '=', candidate.id).executeTakeFirstOrThrow();
    await db.executor.insertInto('ats_applications').values({ ...row, id: 'second-app', submission_key: 'second-key', role_slug: 'senior-full-stack-engineer' }).execute();
    const reply = await importAtsMail(db, { ...mail, messageId: 'ambiguous-reply' }, at);
    expect(reply.application_id).toBeNull();
    const selected = await promoteAtsMail(db, reply.id, 'senior-full-stack-engineer', 'user_reviewer', at);
    expect(selected.id).toBe('second-app');
  });

  it('retries failed Slack delivery without losing the email and does not send already delivered work', async () => {
    await importAtsMail(db, mail, at);
    const send = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ ts: '123.456' });
    await deliverAtsNotifications(db, send, at);
    const [pending] = await db.executor.selectFrom('ats_notification_outbox').selectAll().execute();
    expect(pending.sent_at).toBeNull();
    await deliverAtsNotifications(db, send, '2026-10-09T10:10:00.000Z');
    await deliverAtsNotifications(db, send, '2026-10-09T10:20:00.000Z');
    expect(send).toHaveBeenCalledTimes(2);
    expect((await db.executor.selectFrom('ats_notification_outbox').selectAll().execute())[0].slack_ts).toBe('123.456');
  });

  it('promotes only the selected message when a sender applies for different roles', async () => {
    const first = await importAtsMail(db, mail, at);
    const second = await importAtsMail(db, { ...mail, messageId: 'other-role', threadId: 'other-thread' }, at);
    const engineer = await promoteAtsMail(db, first.id, 'founding-engineer', 'user_reviewer', at);
    expect((await db.executor.selectFrom('ats_inbox_messages').selectAll().where('id', '=', second.id).executeTakeFirstOrThrow()).application_id).toBeNull();
    const commercial = await promoteAtsMail(db, second.id, 'senior-go-to-market-lead', 'user_reviewer', at);
    expect(commercial.id).not.toBe(engineer.id);
    expect(commercial.roleSlug).toBe('senior-go-to-market-lead');
  });
  it('preserves legacy messages with missing senders without permitting candidate promotion', async () => {
    await expect(importAtsMail(db, { ...mail, senderEmail: '' }, at)).rejects.toThrow();
    const imported = await importAtsMail(db, { ...mail, senderEmail: '' }, at, { notify: false, allowMissingSender: true });
    expect(imported.application_id).toBeNull();
    expect((await listAtsInbox(db))[0].sender_email).toBe('');
    await expect(promoteAtsMail(db, imported.id, 'founding-engineer', 'user_reviewer', at)).rejects.toThrow('sender');
    expect(await db.executor.selectFrom('ats_applications').selectAll().execute()).toHaveLength(0);
  });
});
