/** Bound control/DB checks by release batches rather than provider token events. Each batch still needs
 * fresh authorization before enqueue; this creates no grant cache. One pending read, <=64 KiB output,
 * <=64 input chunks/100ms collection window. Existing upstream/total-response caps remain authoritative. */
export function coalesceQualifiedResponse(source: ReadableStream<Uint8Array>, options: { windowMs?: number; onComplete?: (sourceBytes: number) => void } = {}) {
  const windowMs = options.windowMs ?? 100;
  if (!Number.isInteger(windowMs) || windowMs < 1 || windowMs > 100) throw new Error('Invalid response window');
  const reader = source.getReader(); let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let carry: Uint8Array | undefined; let ended = false; let cancelled = false; let sourceBytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ended || cancelled) { controller.close(); return; }
      const bytes = new Uint8Array(65536); let size = 0; let chunks = 0;
      let timer: ReturnType<typeof setTimeout> | undefined; let expired: Promise<null> | undefined;
      try {
        while (size < bytes.length && chunks < 64 && !cancelled) {
          let next: ReadableStreamReadResult<Uint8Array> | null;
          if (carry) { next = { done: false, value: carry }; carry = undefined; }
          else { pending ??= reader.read(); next = expired ? await Promise.race([pending, expired]) : await pending;
            if (next === null) break; pending = undefined; }
          // cancel() resolves a pending read as done; that is not provider EOF.
          if (cancelled) return;
          if (next.done) { ended = true; reader.releaseLock(); options.onComplete?.(sourceBytes); break; }
          if (!expired) expired = new Promise(resolve => { timer = setTimeout(() => resolve(null), windowMs); timer.unref?.(); });
          const length = Math.min(next.value.length, bytes.length - size); bytes.set(next.value.subarray(0, length), size); size += length; sourceBytes += length; chunks++;
          if (length < next.value.length) carry = next.value.subarray(length);
        }
        if (cancelled) return;
        if (!size && !ended && chunks >= 64) throw new Error('Invalid response chunks');
        if (size) controller.enqueue(bytes.subarray(0, size)); else if (ended) controller.close();
      } catch (error) {
        ended = true; await reader.cancel().catch(cleanup => console.warn('[qualified-relay] Batch cleanup unavailable'));
        controller.error(new Error('AI response stream failed'));
      } finally { if (timer) clearTimeout(timer); }
    },
    async cancel(reason) { cancelled = true; carry = undefined; if (ended) return;
      try { await reader.cancel(reason); } finally { pending = undefined; } },
  }, { highWaterMark: 0 });
}
