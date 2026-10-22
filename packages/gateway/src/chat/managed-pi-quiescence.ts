import { z } from 'zod/v4';
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema } from '@matrix-os/contracts';

const identitySchema = z.object({ ownerId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  chatId: CanonicalChatIdSchema, runId: CanonicalChatRunIdSchema }).strict();
const runtimeSchema = z.object({ runtimeHandle: z.string().regex(/^runtime_[a-f0-9]{32}$/),
  executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/) }).strict();
export type ManagedPiRunIdentity = z.infer<typeof identitySchema>;
export type ManagedPiStopInput = ManagedPiRunIdentity & Partial<z.infer<typeof runtimeSchema>> & { signal: AbortSignal };
export type ManagedPiStoppedRunReceipt = Readonly<ManagedPiRunIdentity & z.infer<typeof runtimeSchema> & { version: 1; stoppedAt: string }>;
export class ManagedPiStopUnavailable extends Error { constructor() { super('Run stop unavailable'); this.name = 'ManagedPiStopUnavailable'; } }
export interface ManagedPiQuiescenceOptions {
  now?: () => number; ttlMs?: number; timeoutMs?: number; maxRows?: number;
  /** Trusted server-only durable receipt sink; no approval is inferred from run.status. */
  onStopped?(receipt: ManagedPiStoppedRunReceipt): Promise<void>;
}
interface Tracked {
  key: ManagedPiRunIdentity; identity?: ManagedPiStoppedRunReceipt;
  stop?: () => Promise<void>; done: Promise<void>; finish(): void;
  work?: Promise<unknown>;
  settled: boolean; failed: boolean; busy: boolean; expires: number;
}
const bounded = (value: number | undefined, fallback: number, max: number) => Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value!), max)) : fallback;

/** Process-local observed stop proofs, never a substitute for durable authority.
 * Missing/expired/restarted/uncertain records deny. The host can persist onStopped
 * for separately qualified later deletion; it must hold its admission fence and
 * durable Google context purge before invoking retention work. */
export function createManagedPiQuiescence(options: ManagedPiQuiescenceOptions = {}) {
  const now = options.now ?? Date.now;
  const timeout = bounded(options.timeoutMs, 30_000, 60_000);
  const ttl = bounded(options.ttlMs, 15 * 60_000, 60 * 60_000);
  const capacity = bounded(options.maxRows, 1024, 4096);
  const entries = new Map<string, Tracked>();
  let closed = false; let closing: Promise<void> | undefined;
  const check = (signal: AbortSignal) => { if (closed || signal.aborted || !Number.isFinite(now())) throw new ManagedPiStopUnavailable(); };
  function cleanup() { for (const [key, row] of entries) if (row.settled && !row.busy && row.expires <= now()) entries.delete(key); }
  const timer = setInterval(cleanup, Math.min(ttl, 60_000)); timer.unref();
  async function drain(row: Tracked, signal: AbortSignal) {
    if (row.failed) throw new ManagedPiStopUnavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const denied = new Promise<never>((_, reject) => {
      abort = () => reject(new ManagedPiStopUnavailable());
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, timeout);
    });
    try {
      const operation = (async () => {
        const outcomes = await Promise.allSettled([row.stop?.(), row.done]);
        if (outcomes.some(outcome => outcome.status === 'rejected')) throw new ManagedPiStopUnavailable();
      })();
      await Promise.race([operation, denied]);
      if (row.failed || !row.identity || row.expires <= now() || signal.aborted) throw new ManagedPiStopUnavailable();
      return row.identity;
    } catch (error: unknown) {
      // A timeout/caller abort withholds work without inventing a worker ACK.
      if (error instanceof ManagedPiStopUnavailable) throw error;
      throw new ManagedPiStopUnavailable();
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
  function select(input: ManagedPiStopInput, exclusive: boolean) {
    const { signal, runtimeHandle, executionGeneration, ...key } = input;
    check(signal); cleanup();
    const parsed = identitySchema.safeParse(key);
    if (!parsed.success) throw new ManagedPiStopUnavailable();
    const row = entries.get(parsed.data.runId);
    if (!row || row.key.ownerId !== parsed.data.ownerId || row.key.chatId !== parsed.data.chatId || (exclusive && row.busy)
      || (runtimeHandle !== undefined && row.identity?.runtimeHandle !== runtimeHandle)
      || (executionGeneration !== undefined && row.identity?.executionGeneration !== executionGeneration)) throw new ManagedPiStopUnavailable();
    return { row, signal };
  }
  return {
    track(key: ManagedPiRunIdentity, stop: () => Promise<void>) {
      key = Object.freeze(identitySchema.parse(key)); cleanup();
      if (closed || entries.has(key.runId) || entries.size >= capacity) throw new ManagedPiStopUnavailable();
      let finish!: () => void;
      const row: Tracked = { key, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish(),
        settled: false, failed: false, busy: false, expires: Infinity, stop };
      entries.set(key.runId, row);
      return {
        bind(binding: ManagedPiRunIdentity & z.infer<typeof runtimeSchema>, stop: () => Promise<void>) {
          if (binding.ownerId !== key.ownerId || binding.chatId !== key.chatId || binding.runId !== key.runId || row.identity) throw new ManagedPiStopUnavailable();
          row.identity = Object.freeze({ ...key, ...runtimeSchema.parse({ runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration }), version: 1, stoppedAt: '' });
          row.stop = stop;
        },
        /** Called only after the real execution and verified admission.release settle. */
        async settle(error?: unknown) {
          if (row.settled) return;
          row.stop = undefined;
          try {
            if (error !== undefined || !row.identity) throw new ManagedPiStopUnavailable();
            const receipt = Object.freeze({ ...row.identity, stoppedAt: new Date(now()).toISOString() });
            await options.onStopped?.(receipt);
            row.identity = receipt;
          } catch (failure: unknown) {
            row.failed = true;
            console.warn('[managed-pi] stopped receipt unavailable', failure instanceof Error ? 'error' : 'unknown');
          } finally { row.expires = now() + ttl; row.settled = true; row.finish(); }
        },
      };
    },
    async stopAndDrain(input: ManagedPiStopInput): Promise<ManagedPiStoppedRunReceipt> {
      const { row, signal } = select(input, false);
      const receipt = await drain(row, signal); check(signal); return receipt;
    },
    async withStoppedRun<T>(input: ManagedPiStopInput, work: (receipt: ManagedPiStoppedRunReceipt) => Promise<T>): Promise<T> {
      const { row, signal } = select(input, true); row.busy = true;
      try {
        const receipt = await drain(row, signal); check(signal);
        const pending = Promise.resolve().then(() => { check(signal); return work(receipt); });
        row.work = pending;
        const result = await pending; check(signal); return result;
      } finally { row.work = undefined; row.busy = false; }
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true; clearInterval(timer);
      closing = (async () => {
        try { const outcomes = await Promise.allSettled([...entries.values()].map(async row => {
          if (row.failed && row.identity) throw new ManagedPiStopUnavailable();
          if (!row.settled) await drain(row, new AbortController().signal);
          await row.work;
        })); if (outcomes.some(outcome => outcome.status === 'rejected')) throw new ManagedPiStopUnavailable(); }
        catch (error: unknown) {
          if (error instanceof ManagedPiStopUnavailable) throw error;
          throw new ManagedPiStopUnavailable();
        }
        finally { entries.clear(); }
      })();
      return closing;
    },
  };
}
