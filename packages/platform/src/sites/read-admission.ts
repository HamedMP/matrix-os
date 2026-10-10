/** Hold a bounded read slot through downstream transfer, including stalled consumers. */
export function createSiteReadAdmission(maximum = 16) {
  let active = 0;
  return {
    admit() {
      if (active >= maximum) return null;
      active++;
      let released = false;
      const release = () => { if (!released) { released = true; active--; } };
      return { release, wrap(response: Response, signal: AbortSignal): Response {
        if (!response.body) { release(); return response; }
        const reader = response.body.getReader();
        let timer: ReturnType<typeof setTimeout>;
        let finished = false;
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const finish = () => {
          if (finished) return false;
          finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); release(); return true;
        };
        const cancelReader = async () => {
          try { await reader.cancel(); }
          catch (error) { console.warn('[sites] read cancellation failed', error instanceof Error ? error.name : 'UnknownError'); }
          finally { reader.releaseLock(); }
        };
        const abort = () => { if (finish()) { controller.error(new Error('Site unavailable')); void cancelReader(); } };
        const body = new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          async pull(value) {
            try {
              const part = await reader.read();
              if (finished) return;
              if (part.done) { finish(); reader.releaseLock(); value.close(); }
              else value.enqueue(part.value);
            } catch (error) {
              if (finish()) { reader.releaseLock(); value.error(error); }
            }
          },
          async cancel() { if (finish()) await cancelReader(); },
        }, { highWaterMark: 0 });
        timer = setTimeout(abort, 30_000); timer.unref?.();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } };
    },
  };
}
