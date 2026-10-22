import type { BotIntegrationTransport } from '../../bots/integration-client.js';
import { GooglePurgeAckSchema, GooglePurgeAckedSchema, GooglePurgeCommandsSchema, PurgeOwnerSchema, type GooglePurgeAck } from './contracts.js';
export class GooglePurgeDeliveryError extends Error {
  constructor() { super('Google cleanup unavailable'); this.name = 'GooglePurgeDeliveryError'; }
}
function deny(): never { throw new GooglePurgeDeliveryError(); }
function diagnostic(error: unknown) {
  console.warn('[google-purge-delivery] Transport unavailable', { category: error instanceof Error ? 'operation_failed' : 'untyped_failure' });
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new GooglePurgeDeliveryError());
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
  });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', stop); }
}
/** Fixed internal machine transport only. At most four actual operations, removed only after
 * fetch/body cancellation settles. Transport must honor its AbortSignal; close awaits actual
 * settlement rather than treating an abort race as proof the request has stopped. */
export function createGooglePurgeDeliveryClient(transport: BotIntegrationTransport) {
  const controllers = new Set<AbortController>();
  const operations = new Set<Promise<unknown>>(); // Same four-operation cap, finally eviction.
  let closed = false; let closing: Promise<void> | undefined;
  async function send(ownerId: string, action: 'purge-commands' | 'purge-ack', body: Record<string, unknown>, parent?: AbortSignal): Promise<unknown> {
    PurgeOwnerSchema.parse(ownerId);
    if (closed || controllers.size >= 4) deny();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000), ...(parent ? [parent] : [])]);
    signal.throwIfAborted(); controllers.add(controller);
    let actual!: Promise<unknown>;
    actual = (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        if (reader && !cancellation) cancellation = reader.cancel().catch(diagnostic);
        return cancellation;
      };
      const onAbort = () => { void cancel(); };
      try {
        // Intentionally await the real transport. The outer abort race can refuse callers promptly,
        // but this owned operation remains capped/tracked until any late body is cancelled.
        const response = await transport(ownerId, { method: 'POST', path: `/gmail/processing/${action}`, body, signal });
        if (signal.aborted || closed) { await response.body?.cancel().catch(diagnostic); deny(); }
        reader = response.body?.getReader(); if (!reader) deny();
        signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
        if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) deny();
        const bytes = new Uint8Array(65536); let size = 0; let chunks = 0;
        for (;;) {
          const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
          if (++chunks > 256 || size + part.value.length > bytes.length) deny();
          bytes.set(part.value, size); size += part.value.length;
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
      } catch (error) {
        await cancel(); if (!(error instanceof GooglePurgeDeliveryError)) diagnostic(error);
        throw new GooglePurgeDeliveryError();
      } finally {
        signal.removeEventListener('abort', onAbort); await cancellation;
        reader?.releaseLock(); controllers.delete(controller);
      }
    })().finally(() => { operations.delete(actual); });
    operations.add(actual);
    return abortable(actual, signal);
  }
  return {
    async poll(ownerId: string, signal?: AbortSignal) {
      try {
        const result = GooglePurgeCommandsSchema.parse(await send(ownerId, 'purge-commands', {}, signal));
        if (result.commands.some(command => command.ownerId !== ownerId)
          || new Set(result.commands.map(command => command.commandId)).size !== result.commands.length) deny();
        return result.commands;
      } catch (error) { if (!(error instanceof Error)) diagnostic(error); throw new GooglePurgeDeliveryError(); }
    },
    async ack(ownerId: string, value: GooglePurgeAck, signal?: AbortSignal) {
      try { const input = GooglePurgeAckSchema.parse(value); GooglePurgeAckedSchema.parse(await send(ownerId, 'purge-ack', input, signal)); }
      catch (error) { if (!(error instanceof Error)) diagnostic(error); throw new GooglePurgeDeliveryError(); }
    },
    close() {
      if (!closing) {
        closed = true; for (const controller of controllers) controller.abort();
        closing = (async () => { await Promise.allSettled([...operations]); })();
      }
      return closing;
    },
  };
}
