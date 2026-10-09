import { beforeEach, afterEach, it, expect } from 'vitest';
import { createTestAtsDb, destroyTestAtsDb } from './ats-db-test-helper.js';
import type { AtsDB } from '../../packages/platform/src/ats-db.js';
import { importAtsMail } from '../../packages/platform/src/ats-mail.js';
import { getAtsMailAttachment } from '../../packages/platform/src/ats-attachments.js';

let db: AtsDB;
beforeEach(async () => { ({ db } = await createTestAtsDb()); });
afterEach(async () => { await destroyTestAtsDb(db); });
const mail = { messageId: 'abcdef', threadId: '', senderName: 'Ada', senderEmail: 'ada@example.com', subject: 'Application', body: 'Hello', receivedAt: '2026-10-09T10:00:00.000Z', sourceUrl: 'https://groups.google.com/a/finna.ai/g/careers' };

it('stores bounded CV attachments atomically and replays without duplicates', async () => {
  const attachment = { filename: 'cv.pdf', contentType: 'application/pdf', base64: Buffer.from('%PDF-1.7').toString('base64') };
  await importAtsMail(db, { ...mail, attachments: [attachment] }, mail.receivedAt);
  await importAtsMail(db, { ...mail, attachments: [attachment] }, mail.receivedAt);
  const rows = await db.executor.selectFrom('ats_mail_attachments').selectAll().execute();
  expect(rows).toHaveLength(1);
  const cv = await getAtsMailAttachment(db, rows[0].id);
  expect(Buffer.from(cv!.bytes).toString()).toBe('%PDF-1.7');
});

it('rejects disguised executable content before writing any email', async () => {
  await expect(importAtsMail(db, { ...mail, attachments: [{ filename: 'cv.pdf', contentType: 'application/pdf', base64: Buffer.from('<script>').toString('base64') }] }, mail.receivedAt)).rejects.toThrow();
  expect(await db.executor.selectFrom('ats_inbox_messages').selectAll().execute()).toHaveLength(0);
});
