export function createBoundedPathIntentQueue<T>(options: {
  maxSize: number;
  process: (path: string, intent: T) => Promise<void>;
  onError: (err: unknown, path: string) => void;
  onOverflow: (path: string) => void;
  onIdle?: () => void;
}): {
  enqueue: (path: string, intent: T) => boolean;
  drain: () => Promise<void>;
  size: () => number;
} {
  if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
    throw new Error("bounded path intent queue size must be a positive integer");
  }
  const pending = new Map<string, T>();
  let active = false;
  let worker: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    try {
      while (pending.size > 0) {
        const next = pending.entries().next().value as [string, T] | undefined;
        if (!next) break;
        const [path, intent] = next;
        pending.delete(path);
        active = true;
        try {
          await options.process(path, intent);
        } catch (err: unknown) {
          options.onError(err, path);
        } finally {
          active = false;
        }
      }
    } finally {
      worker = null;
      options.onIdle?.();
      if (pending.size > 0) {
        worker = run();
      }
    }
  };

  return {
    enqueue(path, intent): boolean {
      if (!pending.has(path) && pending.size + (active ? 1 : 0) >= options.maxSize) {
        options.onOverflow(path);
        return false;
      }
      pending.delete(path);
      pending.set(path, intent);
      worker ??= run();
      return true;
    },
    async drain(): Promise<void> {
      while (worker) {
        await worker;
      }
    },
    size(): number {
      return pending.size + (active ? 1 : 0);
    },
  };
}

