export interface ConversationMutationLock {
  run<T>(id: string, operation: () => Promise<T>): Promise<T>;
  readonly size: number;
}

export function createConversationMutationLock(options: {
  maxKeys: number;
}): ConversationMutationLock {
  if (!Number.isInteger(options.maxKeys) || options.maxKeys < 1) {
    throw new Error("conversation mutation maxKeys must be a positive integer");
  }

  const tails = new Map<string, Promise<void>>();

  return {
    get size() {
      return tails.size;
    },

    async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(id);
      if (!previous && tails.size >= options.maxKeys) {
        throw new Error("conversation mutation capacity reached");
      }

      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(id, current);

      if (previous) {
        await previous;
      }

      try {
        return await operation();
      } finally {
        release();
        if (tails.get(id) === current) {
          tails.delete(id);
        }
      }
    },
  };
}
