import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { isCareersGroup, MAX_RAW_MAIL_BYTES, normalizeGroupMail } from './ats-group-mail.js';

interface RawObject { customMetadata?: Record<string, string>; arrayBuffer(): Promise<ArrayBuffer> }
interface Env {
  ATS_INTAKE_ADDRESS: string;
  ATS_MAIL_INGEST_SECRET: string;
  ATS_PLATFORM_ORIGIN: string;
  ATS_RAW_MAIL: {
    put(key: string, bytes: Uint8Array, options: { customMetadata: Record<string, string> }): Promise<unknown>;
    get(key: string): Promise<RawObject | null>;
    delete(key: string): Promise<void>;
  };
  ATS_MAIL_QUEUE: { send(body: { key: string }): Promise<void> };
}
interface EmailMessage {
  to: string; rawSize: number; raw: ReadableStream<Uint8Array>; headers: Headers; setReject(reason: string): void;
}
interface Job { body: unknown; ack(): void; retry(options?: { delaySeconds: number }): void }
const Reference = z.object({ key: z.string().regex(/^pending\/[a-zA-Z0-9-]+\.eml$/) });

async function boundedRaw(stream: ReadableStream<Uint8Array>) {
  const bytes = new Uint8Array(MAX_RAW_MAIL_BYTES);
  const reader = stream.getReader();
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return bytes.slice(0, size);
      size += chunk.value.byteLength;
      if (size > bytes.length) { await reader.cancel(); throw new Error('Email exceeds intake limit'); }
      bytes.set(chunk.value, size - chunk.value.byteLength);
    }
  } finally { reader.releaseLock(); }
}

export default {
  async email(message: EmailMessage, env: Env) {
    if (!env.ATS_INTAKE_ADDRESS || message.to.toLowerCase() !== env.ATS_INTAKE_ADDRESS.toLowerCase()
      || message.rawSize > MAX_RAW_MAIL_BYTES || !isCareersGroup(message.headers.get('list-id'))) {
      message.setReject('This intake accepts careers group mail up to 32 MB.');
      return;
    }
    const raw = await boundedRaw(message.raw);
    const key = `pending/${randomUUID()}.eml`;
    await env.ATS_RAW_MAIL.put(key, raw, { customMetadata: { receivedAt: new Date().toISOString() } });
    // Await both writes before accepting SMTP delivery. Lifecycle cleanup handles orphaned raw objects.
    await env.ATS_MAIL_QUEUE.send({ key });
  },
  async queue(batch: { messages: Job[] }, env: Env) {
    const origin = new URL(env.ATS_PLATFORM_ORIGIN);
    if (origin.protocol !== 'https:' || !env.ATS_MAIL_INGEST_SECRET) throw new Error('Intake is not configured');
    for (const job of batch.messages) {
      try {
        const { key } = Reference.parse(job.body);
        const raw = await env.ATS_RAW_MAIL.get(key);
        // Raw objects are removed only after platform acceptance. A retry may follow that deletion.
        if (!raw) { job.ack(); continue; }
        const body = await normalizeGroupMail(new Uint8Array(await raw.arrayBuffer()), raw.customMetadata?.receivedAt ?? new Date().toISOString());
        const response = await fetch(new URL('/api/ats/mail', origin.origin), {
          method: 'POST', headers: { authorization: `Bearer ${env.ATS_MAIL_INGEST_SECRET}`, 'content-type': 'application/json', 'user-agent': 'Matrix-Recruiting-Intake/1.0' },
          // Workers supports manual/follow only. Reject every redirect below;
          // never forward the intake credential or applicant data to Location.
          body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'manual',
        });
        if (!response.ok) throw new Error('ATS intake unavailable');
        z.object({ receiptId: z.string().min(1).max(128) }).parse(await response.json());
        await env.ATS_RAW_MAIL.delete(key);
        job.ack();
      } catch (error) {
        console.error('[ats] Group delivery failed:', error instanceof Error ? error.name : typeof error);
        job.retry({ delaySeconds: 60 });
      }
    }
  },
};
