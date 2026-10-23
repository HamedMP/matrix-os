// Far more than a chat screen draws while one reply is being written.
const SEEN_LIMIT = 500;

/** The arriving messages a list has already shown, so none of them enters twice. */
export interface SeenMessages {
  has(id: string): boolean;
  add(id: string): void;
}

/** Remembers up to `limit` messages, forgetting the one seen longest ago. */
export function createSeenMessages(limit = SEEN_LIMIT): SeenMessages {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.delete(id);
      ids.add(id);
      if (ids.size > limit) {
        const oldest = ids.values().next().value;
        if (oldest !== undefined) ids.delete(oldest);
      }
    },
  };
}
