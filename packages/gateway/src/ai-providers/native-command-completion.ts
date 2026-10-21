import { TerminalCommandResultSchema } from '@matrix-os/terminal-runtime';

/** One bounded-lifetime workflow owns this nonoverlapping, read-only observer. */
export function observeNativeCommandCompletion(input: {
  read(): Promise<unknown>;
  active(): boolean;
  onExited(exitCode: number): Promise<void>;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const stop = () => { stopped = true; clearTimeout(timer); };
  const check = (): Promise<void> => {
    clearTimeout(timer);
    if (pending) return pending;
    if (stopped || !input.active()) return Promise.resolve();
    pending = (async () => {
      try {
        const result = TerminalCommandResultSchema.safeParse(await input.read());
        if (stopped || !input.active()) return;
        if (result.success && result.data.state === 'exited') {
          stop();
          await input.onExited(result.data.exitCode);
        }
      } catch (error) {
        console.warn('[provider-workflow] Native command result unavailable:', error instanceof Error ? error.name : 'UnknownError');
      }
    })().finally(() => {
      pending = undefined;
      if (!stopped && input.active()) { timer = setTimeout(() => { void check(); }, 1000); timer.unref(); }
    });
    return pending;
  };
  timer = setTimeout(() => { void check(); }, 0); timer.unref();
  return { check, stop };
}
