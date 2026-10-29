import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import { NativeGmailRequestError } from './request.js';

const MAX_DEPTH = 12;
const MAX_PARTS = 256;
const Part = z.object({ mimeType: z.string().max(128), filename: z.string().max(1024).optional(),
  headers: z.array(z.object({ name: z.string().max(128), value: z.string().max(8192) })).max(256).optional(),
  body: z.object({ size: z.number().int().nonnegative().max(128 * 1024).optional(),
    attachmentId: z.string().optional(), data: z.string().optional() }).passthrough().optional(),
  parts: z.array(z.unknown()).max(MAX_PARTS).optional() }).passthrough();
function deny(): never { throw new NativeGmailRequestError(); }

/** Fields deliberately omit all body data, including at the depth boundary.
 * Multipart at that boundary fails closed instead of trusting omitted children. */
export function messageTextPreflightFields(): string {
  let fields = 'mimeType,filename,headers(name,value),body(size,attachmentId)';
  for (let i = 0; i < MAX_DEPTH; i++) fields = `mimeType,filename,headers(name,value),body(size,attachmentId),parts(${fields})`;
  return `id,payload(${fields})`;
}

function shape(value: unknown, preflight: boolean): unknown {
  let count = 0, bytes = 0;
  function visit(raw: unknown, depth: number): unknown {
    if (++count > MAX_PARTS || depth > MAX_DEPTH) deny();
    const result = Part.safeParse(raw); if (!result.success) deny();
    const p = result.data;
    if (p.filename || p.body?.attachmentId !== undefined || preflight && p.body?.data !== undefined) deny();
    if (p.headers?.some(h => h.name.toLowerCase() === 'content-disposition' && h.value.trim().toLowerCase() !== 'inline'
      || h.name.toLowerCase() === 'content-type' && /(?:file)?name\s*=/i.test(h.value))) deny();
    bytes += p.body?.size ?? 0; if (bytes > 128 * 1024) deny();
    const multipart = ['multipart/alternative', 'multipart/mixed', 'multipart/related'].includes(p.mimeType);
    if (multipart ? !p.parts?.length || depth === MAX_DEPTH : !['text/plain', 'text/html'].includes(p.mimeType) || Boolean(p.parts?.length)) deny();
    if (multipart && (p.body?.size || p.body?.data)) deny();
    return { mimeType: p.mimeType, filename: p.filename ?? '', size: p.body?.size ?? 0,
      parts: p.parts?.map(part => visit(part, depth + 1)) ?? [] };
  }
  return visit(value, 0);
}

/** Gmail message IDs identify immutable content. Labels may change between the
 * requests. Revalidate MIME identity before releasing any body to a caller. */
export function messageTextShape(value: unknown, id: string, preflight: boolean): unknown {
  const parsed = z.object({ id: z.literal(id), payload: z.unknown() }).passthrough().safeParse(value);
  if (!parsed.success) deny();
  return shape(parsed.data.payload, preflight);
}
export function assertMessageTextUnchanged(metadata: unknown, content: unknown, id: string): void {
  if (!isDeepStrictEqual(messageTextShape(metadata, id, true), messageTextShape(content, id, false))) deny();
}

/** Release an allowlisted projection, never unexpected provider fields. */
export function projectMessageText(value: unknown): unknown {
  const message = z.object({ id: z.string(), threadId: z.string().optional(), internalDate: z.string().optional(),
    snippet: z.string().optional(), payload: z.unknown() }).parse(value);
  function project(raw: unknown): unknown {
    const p = Part.parse(raw);
    return { mimeType: p.mimeType, filename: '', ...(p.headers ? { headers: p.headers } : {}),
      ...(p.body ? { body: { ...(p.body.size === undefined ? {} : { size: p.body.size }),
        ...(p.body.data === undefined ? {} : { data: p.body.data }) } } : {}),
      ...(p.parts ? { parts: p.parts.map(project) } : {}) };
  }
  return { ...message, payload: project(message.payload) };
}
