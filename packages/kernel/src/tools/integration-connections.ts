import { z } from 'zod/v4';
import { GmailConnectionMethodSchema, GmailConnectionOptionsSchema } from '@matrix-os/contracts/integration-marketplace';
import { API_TIMEOUT_MS, GATEWAY_BASE, defaultFetcher, gatewayAuthHeaders, textResult, errorResult,
  type GatewayFetchResponse, type GatewayFetcher, type ToolResult } from './integration-gateway.js';

export const ConnectServiceInputSchema = z.object({
  service: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).describe('Registry service ID to connect'),
  label: z.string().trim().min(1).max(100).optional().describe('Label for this account'),
  connectionMethod: GmailConnectionMethodSchema.optional().describe('Gmail only: honor the user’s explicit Matrix or Pipedream connection choice'),
});
export type ConnectServiceInput = z.infer<typeof ConnectServiceInputSchema>;
const validConnect = ConnectServiceInputSchema.refine(input => input.connectionMethod === undefined || input.service === 'gmail');
const unavailable = 'Integration service is temporarily unavailable. Please try again later.';

function discardBody(response: GatewayFetchResponse): void {
  void response.body?.cancel().catch(error => console.warn('[integrations] Response cleanup failed:', error instanceof Error ? error.name : 'UnknownError'));
}

async function smallJson(response: GatewayFetchResponse, signal: AbortSignal, limit: number): Promise<unknown> {
  if (!response.body) {
    const body = await response.text();
    if (Buffer.byteLength(body) > limit) throw new Error('Response too large');
    return JSON.parse(body);
  }
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(error => console.warn('[integrations] Response cleanup failed:', error instanceof Error ? error.name : 'UnknownError')); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit || chunks.length >= 1024) throw new Error('Response too large');
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch (error) { abort(); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** Bound the entire metadata operation, including injected fetchers and stream reads. */
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(API_TIMEOUT_MS)]);
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error('Integration deadline')); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([work(signal), aborted]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}

export async function connectServiceHandler(input: ConnectServiceInput, fetcher: GatewayFetcher = defaultFetcher()): Promise<ToolResult> {
  const parsed = validConnect.safeParse(input);
  if (!parsed.success) return errorResult('Invalid integration connection request.');
  try {
    return await bounded(async signal => {
      const response = await fetcher(`${GATEWAY_BASE}/api/integrations/connect`, {
        method: 'POST', headers: gatewayAuthHeaders(), body: JSON.stringify(parsed.data), redirect: 'error', signal });
      if (!response.ok) {
        // Preserve the bounded registry validation error; upstream failures remain generic.
        if (response.status === 400) {
          const error = z.object({ error: z.string().max(100).regex(/^Unknown service: [a-z0-9_-]{1,64}$/) }).safeParse(await smallJson(response, signal, 4096));
          if (error.success) return textResult(error.data.error);
        }
        discardBody(response);
        return errorResult(unavailable);
      }
      const result = z.object({ url: z.url().max(8192).refine(value => new URL(value).protocol === 'https:'), service: z.literal(parsed.data.service) }).parse(await smallJson(response, signal, 16_384));
      return textResult(`To connect ${result.service}, open this URL in your browser:\n\n${result.url}\n\nAfter authorizing, the connection will appear automatically.`);
    });
  } catch (error) { console.error('[integrations] Connection unavailable:', error instanceof Error ? error.name : 'UnknownError'); return errorResult(unavailable); }
}

export async function getGmailConnectionOptionsHandler(fetcher: GatewayFetcher = defaultFetcher()): Promise<ToolResult> {
  try {
    return await bounded(async signal => {
      const response = await fetcher(`${GATEWAY_BASE}/api/integrations/gmail/connection-options`, { method: 'GET', headers: gatewayAuthHeaders(), redirect: 'error', signal });
      if (response.status === 404) { discardBody(response); return textResult(JSON.stringify({ methods: ['pipedream'], defaultMethod: 'pipedream' })); }
      if (!response.ok) { discardBody(response); return errorResult('Gmail connection options are currently unavailable.'); }
      return textResult(JSON.stringify(GmailConnectionOptionsSchema.parse(await smallJson(response, signal, 4096))));
    });
  } catch (error) { console.error('[integrations] Connection options unavailable:', error instanceof Error ? error.name : 'UnknownError'); return errorResult('Gmail connection options are currently unavailable.'); }
}
