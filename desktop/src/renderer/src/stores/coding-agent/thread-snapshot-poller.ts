export interface ThreadSnapshotPoller {
  start(poll: () => Promise<boolean>): void;
  stop(): void;
}

export function createThreadSnapshotPoller(intervalMs: number): ThreadSnapshotPoller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  function stop(): void {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function start(poll: () => Promise<boolean>): void {
    stop();
    const activeGeneration = generation;

    const schedule = () => {
      timer = setTimeout(() => {
        timer = null;
        void poll().then((continuePolling) => {
          if (generation !== activeGeneration || !continuePolling) return;
          schedule();
        });
      }, intervalMs);
    };

    schedule();
  }

  return { start, stop };
}
