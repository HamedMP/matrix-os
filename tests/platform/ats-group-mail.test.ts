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
  await worker.email({ ...message, rawSize: 33 * 1024 * 1024 } as never, env as never);
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
    expect(fetcher.mock.calls[0][1].headers['user-agent']).toBe('Matrix-Recruiting-Intake/1.0');
  } finally { vi.unstubAllGlobals(); }
});

it.each([301,302,303,307,308])('rejects a %s redirect without forwarding credentials or removing retained email',async status=>{
 const stored={customMetadata:{receivedAt},arrayBuffer:async()=>new TextEncoder().encode(raw).buffer};
 const env={ATS_PLATFORM_ORIGIN:'https://api.matrix-os.com',ATS_MAIL_INGEST_SECRET:'test',ATS_RAW_MAIL:{get:vi.fn(async()=>stored),delete:vi.fn()}};
 const job={body:{key:'pending/123.eml'},ack:vi.fn(),retry:vi.fn()};
 const fetcher=vi.fn().mockResolvedValue(new Response(null,{status,headers:{location:'https://untrusted.example/mail'}}));
 vi.stubGlobal('fetch',fetcher);const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try {
  await worker.queue({messages:[job]} as never,env as never);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
  expect(job.retry).toHaveBeenCalledWith({delaySeconds:60});
  expect(job.ack).not.toHaveBeenCalled();expect(env.ATS_RAW_MAIL.delete).not.toHaveBeenCalled();
 }finally {vi.unstubAllGlobals();log.mockRestore();}
});

it('preserves HTML email content and every attachment type instead of omitting portfolios',async()=>{
 const value=['From: Ada <ada@example.com>','To: careers@finna.ai','List-Id: <careers.finna.ai>','Message-Id: <with-file@example.com>','Content-Type: multipart/mixed; boundary="part"','','--part','Content-Type: text/html; charset=utf-8','','<p>My <b>complete</b> answer &amp; portfolio</p>','--part','Content-Type: image/png','Content-Disposition: attachment; filename="portfolio.png"','Content-Transfer-Encoding: base64','','aW1hZ2U=','--part--'].join('\r\n');
 const mail=await normalizeGroupMail(new TextEncoder().encode(value),receivedAt);
 expect(mail.body).toContain('My complete answer & portfolio');expect(mail.attachments).toHaveLength(2);
 expect(mail.attachments?.map(file=>file.filename)).toContain('portfolio.png');
 expect(mail.attachments?.map(file=>file.filename)).toContain('original-message.html');
});
it('does not truncate long answers',async()=>{
 const mail=await normalizeGroupMail(new TextEncoder().encode(raw.replace('Hello hiring team','a'.repeat(70000))),receivedAt);
 expect(mail.body.trim()).toHaveLength(70000);
});
it('reports an attachment whose MIME part contains no bytes without fabricating a file',async()=>{
 const value=['From: Ada <ada@example.com>','To: careers@finna.ai','List-Id: <careers.finna.ai>','Message-Id: <empty-file@example.com>','Content-Type: multipart/mixed; boundary="part"','','--part','Content-Type: text/plain','','My CV is attached.','--part','Content-Type: application/pdf','Content-Disposition: attachment; filename="cv.pdf"','Content-Transfer-Encoding: base64','','--part--'].join('\r\n');
 const bytes=new TextEncoder().encode(value);
 const mail=await normalizeGroupMail(bytes,receivedAt);
 expect(mail.body).toContain('My CV is attached.');
 expect(mail.body).toContain('Attachment unavailable: cv.pdf (the original email contains no file bytes).');
 expect(mail.attachments).toEqual([]);
 expect(mail.sourceUrl).toBe('https://groups.google.com/a/finna.ai/g/careers');
});
it('does not duplicate a large retained file into the attachment allowance when another part is empty',async()=>{
 const file=Buffer.alloc(10*1024*1024,65);file.write('%PDF-1.7');
 const value=['From: Ada <ada@example.com>','To: careers@finna.ai','List-Id: <careers.finna.ai>','Message-Id: <large-empty-file@example.com>','Content-Type: multipart/mixed; boundary="part"','','--part','Content-Type: text/plain','','Complete application.','--part','Content-Type: application/pdf','Content-Disposition: attachment; filename="cv.pdf"','Content-Transfer-Encoding: base64','',file.toString('base64'),'--part','Content-Type: application/pdf','Content-Disposition: attachment; filename="missing.pdf"','Content-Transfer-Encoding: base64','','--part--'].join('\r\n');
 const mail=await normalizeGroupMail(new TextEncoder().encode(value),receivedAt);
 expect(mail.attachments).toHaveLength(1);
 expect(Buffer.from(mail.attachments![0].base64,'base64').equals(file)).toBe(true);
 expect(mail.body).toContain('Attachment unavailable: missing.pdf');
});
it('allows missing List-Id only for an explicitly captured careers archive URL',async()=>{
 const original=raw.replace('List-Id: <careers.finna.ai>\r\n','').replace('Subject: Engineer application','Date: Thu, 01 Oct 2026 12:00:00 +0000\r\nSubject: Engineer application');
 await expect(normalizeGroupMail(new TextEncoder().encode(original),receivedAt)).rejects.toThrow();
 const archived=await normalizeGroupMail(new TextEncoder().encode(original),receivedAt,'https://groups.google.com/a/finna.ai/g/careers/c/thread1');expect(archived.receivedAt).toBe('2026-10-01T12:00:00.000Z');
 await expect(normalizeGroupMail(new TextEncoder().encode(original),receivedAt,'https://groups.google.com/a/other/g/careers/c/thread1')).rejects.toThrow('Unexpected');
});

it('routes same-zone intake requests through the public edge authentication layer',async()=>{
 const {readFile}=await import('node:fs/promises');
 const config=await readFile('packages/platform/wrangler.ats.toml','utf8');
 expect(config).toMatch(/compatibility_flags\s*=\s*\[[^\]]*"global_fetch_strictly_public"/);
});
