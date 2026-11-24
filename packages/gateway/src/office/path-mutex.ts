/** Thrown when the registry or one key's queue is full. Maps to a 503. */
export class KeyedMutexBusyError extends Error {
  constructor() {
    super("Keyed mutex is busy");
    this.name = "KeyedMutexBusyError";
  }
}

export interface KeyedMutexOptions {
  /** Keys that may be held or awaited at once. */
  maxKeys: number;
  /** Operations that may wait behind the holder of one key. */
  maxWaitersPerKey: number;
}

interface Slot {
  tail: Promise<void>;
  /** The holder plus everyone waiting. */
  users: number;
}

/**
 * Async mutex per key. Operations on one key run one at a time in arrival
 * order; different keys run in parallel. A key is evicted from the registry
 * the moment it has no holder and no waiter, so the registry only ever holds
 * live keys and is capped by `maxKeys`; a live holder is never evicted.
 */
export class KeyedMutex {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly options: KeyedMutexOptions) {}

  /** Number of keys currently held or awaited. */
  get size(): number {
    return this.slots.size;
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let slot = this.slots.get(key);
    if (!slot) {
      if (this.slots.size >= this.options.maxKeys) throw new KeyedMutexBusyError();
      slot = { tail: Promise.resolve(), users: 0 };
      this.slots.set(key, slot);
    } else if (slot.users >= this.options.maxWaitersPerKey + 1) {
      throw new KeyedMutexBusyError();
    }
    const previous = slot.tail;
    let release!: () => void;
    slot.tail = new Promise<void>((done) => { release = done; });
    slot.users++;
    await previous;
    try {
      return await operation();
    } finally {
      slot.users--;
      release();
      if (slot.users === 0 && this.slots.get(key) === slot) this.slots.delete(key);
    }
  }
}
