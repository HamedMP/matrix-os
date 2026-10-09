import { expect, it, vi } from 'vitest';
import { normalizeGroupMail } from '../../packages/platform/src/ats-group-mail.js';
import worker from '../../packages/platform/src/ats-email-worker.js';

const receivedAt = '2026-10-09T10:00:00.000Z';
const raw = ['From: Ada <ada@example.com>', 'To: careers@finna.ai', 'List-Id: <careers.finna.ai>', 'Message-Id: <application-1@example.com>', 'Subject: Engineer application', 'Content-Type: text/plain; charset=utf-8', '', 'Hello hiring team'].join('\r\n');
it('normalizes Google Group delivery without mailbox credentials and deduplicates by RFC message ID', async () => {
  const first = await normalizeGroupMail(new TextEncoder().encode(raw), receivedAt);
  const replay = await normalizeGroupMail(new TextEncoder().encode(raw.replace('Hello hiring team', 'Hello again')), receivedAt);
  expect(first.senderEmail).toBe('ada@example.com');
  expect(first.body.trim()).toBe('Hello hiring team');
  expect(replay.messageId).toBe(first.messageId);
  expect(first.sourceUrl).toBe('https://groups.google.com/a/finna.ai/g/careers');
  expect(first.attachments).toEqual([]);
});
it('rejects messages outside the careers group', async () => {
  await expect(normalizeGroupMail(new TextEncoder().encode(raw.replace('careers.finna.ai', 'other.example.com')), receivedAt)).rejects.toThrow();
});
it('durably archives before enqueueing and refuses unknown recipient or oversized input', async () => {
  const calls: string[] = [];
  const env = { ATS_INTAKE_ADDRESS: 'intake-test@intake.matrix-os.com', ATS_RAW_MAIL: { put: vi.fn(async () => { calls.push('archive'); }) }, ATS_MAIL_QUEUE: { send: vi.fn(async () => { calls.push('queue'); }) } };
  const reject = vi.fn();
  const message = { to: env.ATS_INTAKE_ADDRESS, raw: new Blob([raw]).stream(), rawSize: raw.length, headers: new Headers({ 'list-id': '<careers.finna.ai>' }), setReject: reject };
  await worker.email(message as never, env as never);
  expect(calls).toEqual(['archive', 'queue']);
  await worker.email({ ...message, to: 'other@intake.matrix-os.com' } as never, env as never);
  await worker.email({ ...message, rawSize: 9 * 1024 * 1024 } as never, env as never);
  expect(reject).toHaveBeenCalledTimes(2);
  expect(calls).toHaveLength(2);
});
it('retries when platform intake fails and deletes raw mail only after durable acceptance', async () => {
  const stored = { customMetadata: { receivedAt }, arrayBuffer: async () => new TextEncoder().encode(raw).buffer };
  const env = { ATS_PLATFORM_ORIGIN: 'https://api.matrix-os.com', ATS_MAIL_INGEST_SECRET: 'test', ATS_RAW_MAIL: { get: vi.fn(async () => stored), delete: vi.fn() } };
  const job = { body: { key: 'pending/123.eml' }, ack: vi.fn(), retry: vi.fn() };
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValue(new Response(JSON.stringify({ receiptId: 'receipt' })));
  vi.stubGlobal('fetch', fetcher);
  try {
    await worker.queue({ messages: [job] } as never, env as never);
    expect(job.retry).toHaveBeenCalledOnce();
    expect(env.ATS_RAW_MAIL.delete).not.toHaveBeenCalled();
    await worker.queue({ messages: [job] } as never, env as never);
    expect(job.ack).toHaveBeenCalledOnce();
    expect(env.ATS_RAW_MAIL.delete).toHaveBeenCalledWith(job.body.key);
    expect(fetcher.mock.calls[0][1].signal).toBeDefined();
  } finally { vi.unstubAllGlobals(); }
});
