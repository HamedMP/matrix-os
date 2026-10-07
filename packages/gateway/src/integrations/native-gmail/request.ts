import { z } from 'zod/v4';
import { boundedOperation } from '../../bounded-operation.js';

export const NATIVE_GMAIL_ACCOUNT = /^gmail_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isNativeGmailAccount(id: string): boolean { return id.startsWith('gmail_'); }
export class NativeGmailRequestError extends Error {
  constructor(readonly statusCode = 502) { super('Gmail request unavailable'); this.name = 'NativeGmailRequestError'; }
}
export class NativeGmailHistoryExpiredError extends NativeGmailRequestError {
  readonly code = 'gmail_history_expired';
  constructor() { super(404); this.name = 'NativeGmailHistoryExpiredError'; }
}
const HistoryId = z.string().min(1).max(20).regex(/^\d+$/);
const HistoryPage = z.object({ historyId: HistoryId, nextPageToken: z.string().min(1).max(2048).optional(),
  history: z.array(z.object({ id: HistoryId }).passthrough()).max(500).optional() }).passthrough();
export interface GmailTokenSource {
  token(identity: { externalUserId: string; accountId: string }, signal?: AbortSignal): Promise<string>;
}
export interface NativeGmailRequest {
  externalUserId: string; accountId: string; url: string;
  params?: Record<string, string>; body?: Record<string, unknown>; headers?: Record<string, string>;
}
const identity = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/);
const readPath = /^\/gmail\/v1\/users\/me\/(?:profile|labels|history|messages|threads|messages\/[A-Za-z0-9_-]{1,128}|threads\/[A-Za-z0-9_-]{1,128}|messages\/[A-Za-z0-9_-]{1,128}\/attachments\/[A-Za-z0-9_-]{1,2048})$/;
const writePath = /^\/gmail\/v1\/users\/me\/(?:labels|messages\/send|messages\/[A-Za-z0-9_-]{1,128}\/modify)$/;
const queryKeys = new Set(['q', 'maxResults', 'pageToken', 'labelIds', 'startHistoryId', 'format', 'fields']);
const Attachment = z.object({ size: z.number().int().min(0).max(1024 * 1024), data: z.string().max(1398104).regex(/^[A-Za-z0-9_-]*={0,2}$/) });

export function gmailTarget(input: NativeGmailRequest, method: string): URL {
  if (!identity.safeParse(input.externalUserId).success || !NATIVE_GMAIL_ACCOUNT.test(input.accountId)
    || input.url.length > 8192 || /\/(?:\.|%2e)/i.test(input.url) || input.headers && Object.keys(input.headers).length) {
    throw new NativeGmailRequestError();
  }
  const target = new URL(input.url);
  if (target.origin !== 'https://gmail.googleapis.com' || target.username || target.password || target.hash
    || !(method === 'GET' ? readPath : method === 'POST' ? writePath : /$a/).test(target.pathname)) {
    throw new NativeGmailRequestError();
  }
  for (const [key, value] of Object.entries(input.params ?? {})) target.searchParams.set(key, value);
  for (const [key, value] of target.searchParams) {
    if (!queryKeys.has(key) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new NativeGmailRequestError();
    if (key === 'maxResults' && (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 500)) throw new NativeGmailRequestError();
    if (key === 'startHistoryId' && !/^\d{1,20}$/.test(value)) throw new NativeGmailRequestError();
    if (key === 'format' && !['full', 'minimal', 'metadata'].includes(value)) throw new NativeGmailRequestError();
  }
  // Gmail defaults list calls to 100; use one bounded page unless explicitly requested.
  if (method === 'GET' && /\/(messages|threads|history)$/.test(target.pathname) && !target.searchParams.has('maxResults')) target.searchParams.set('maxResults', '100');
  return target;
}
function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch(() => console.warn('[native-gmail] Body cleanup failed'));
}

/** End-to-end deadline includes credential resolution, fetch, and streamed bytes. No implicit retries. */
export function createNativeGmailRequest(options: { oauth: GmailTokenSource; fetcher?: typeof fetch }) {
  return async (input: NativeGmailRequest, method: string, maxBytes = 2 * 1024 * 1024, callerSignal?: AbortSignal): Promise<unknown> => {
    let target: URL;
    try { target = gmailTarget(input, method); }
    catch { throw new NativeGmailRequestError(); }
    const attachment = target.pathname.includes('/attachments/');
    if (attachment) maxBytes = Math.min(maxBytes, 1400 * 1024);
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body && Buffer.byteLength(body) > 128 * 1024) throw new NativeGmailRequestError();
    return boundedOperation(async signal => {
      const token = await options.oauth.token({ externalUserId: input.externalUserId, accountId: input.accountId }, signal);
      signal.throwIfAborted();
      const response = await (options.fetcher ?? fetch)(target.href, { method, body, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) } });
      const length = response.headers.get('content-length');
      if (!response.ok || !response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        cancel(response.body);
        if (response.status === 404 && target.pathname.endsWith('/history')) throw new NativeGmailHistoryExpiredError();
        // Only coarse statuses reach the existing safe failure mapper. No upstream body or headers.
        throw new NativeGmailRequestError([401, 403, 404, 429].includes(response.status) ? response.status : 502);
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      const aborted = () => cancel(reader); signal.addEventListener('abort', aborted, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > maxBytes || chunks.length >= 4096) throw new NativeGmailRequestError();
          chunks.push(next.value);
        }
        signal.throwIfAborted();
        const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
        if (attachment) {
          const parsed = Attachment.safeParse(result);
          if (!parsed.success) throw new NativeGmailRequestError();
          const decoded = Buffer.from(parsed.data.data, 'base64url');
          const canonical = decoded.toString('base64url');
          const padded = canonical.padEnd(Math.ceil(canonical.length / 4) * 4, '=');
          if (decoded.byteLength !== parsed.data.size || parsed.data.data !== canonical && parsed.data.data !== padded) throw new NativeGmailRequestError();
          return parsed.data;
        }
        if (target.pathname.endsWith('/history') && !HistoryPage.safeParse(result).success) throw new NativeGmailRequestError();
        return result;
      } catch (error) {
        cancel(reader);
        if (error instanceof NativeGmailRequestError) throw error;
        throw new NativeGmailRequestError();
      } finally { signal.removeEventListener('abort', aborted); reader.releaseLock(); }
    }, 10_000, callerSignal);
  };
}
