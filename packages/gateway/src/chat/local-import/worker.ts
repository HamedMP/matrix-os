/** One verifier per runtime; owning gateway drains it before destroying injected resources. */
export function createLocalChatImportWorker(options: { step(signal: AbortSignal): Promise<boolean>; sweep(): Promise<void> }) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let lastSweep = 0;
  let wakePending = false;
  const schedule = (delay: number) => {
    if (controller.signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay); timer.unref();
  };
  const run = () => {
    timer = undefined;
    if (controller.signal.aborted || active) return;
    active = (async () => {
      try {
        if (Date.now() - lastSweep >= 60_000) { await options.sweep(); lastSweep = Date.now(); }
        for (let n = 0; n < 8 && !controller.signal.aborted; n++) {
          if (!await options.step(controller.signal)) break;
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) console.warn("[chat/import] worker will retry", error instanceof Error ? error.name : "UnknownError");
      }
    })().finally(() => { active = undefined; const delay = wakePending ? 0 : 10_000; wakePending = false; schedule(delay); });
  };
  return {
    wake() { if (controller.signal.aborted) return; if (active) wakePending = true; else schedule(0); },
    async close() { controller.abort(); if (timer) clearTimeout(timer); timer = undefined; await active; },
  };
}
