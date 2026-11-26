/** Thrown when the registry or one key's queue is full, or a waiter's deadline passes. Maps to a 503. */
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

export interface KeyedMutexRunOptions {
  /** When the caller stops waiting. A waiter gives up its turn then, and an operation never starts after it. */
  deadline?: { remainingMs(): number };
}

interface Slot {
  tail: Promise<void>;
  /** The holder plus everyone waiting. */
  users: number;
}

/** Waits for `previous`, or rejects once the deadline passes first. */
async function waitTurn(previous: Promise<void>, deadline: { remainingMs(): number }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new KeyedMutexBusyError()), deadline.remainingMs()); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Async mutex per key. Operations on one key run one at a time in arrival
 * order; different keys run in parallel. A key is evicted from the registry
 * the moment it has no holder and no waiter, so the registry only ever holds
 * live keys and is capped by `maxKeys`; a live holder is never evicted. A
 * waiter whose deadline passes leaves at once; its place in the order is
 * released only when the operation before it ends, so the order holds.
 */
export class KeyedMutex {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly options: KeyedMutexOptions) {}

  /** Number of keys currently held or awaited. */
  get size(): number {
    return this.slots.size;
  }

  async run<T>(key: string, operation: () => Promise<T>, options: KeyedMutexRunOptions = {}): Promise<T> {
    const { deadline } = options;
    if (deadline && deadline.remainingMs() <= 0) throw new KeyedMutexBusyError();
    let slot = this.slots.get(key);
    if (!slot) {
      if (this.slots.size >= this.options.maxKeys) throw new KeyedMutexBusyError();
      slot = { tail: Promise.resolve(), users: 0 };
      this.slots.set(key, slot);
    } else if (slot.users >= this.options.maxWaitersPerKey + 1) {
      throw new KeyedMutexBusyError();
    }
    const held = slot;
    const previous = held.tail;
    let release!: () => void;
    held.tail = new Promise<void>((done) => { release = done; });
    held.users++;
    const leave = () => {
      held.users--;
      release();
      if (held.users === 0 && this.slots.get(key) === held) this.slots.delete(key);
    };
    if (!deadline) await previous;
    else {
      try {
        await waitTurn(previous, deadline);
      } catch (error: unknown) {
        void previous.then(leave);
        throw error;
      }
    }
    try {
      if (deadline && deadline.remainingMs() <= 0) throw new KeyedMutexBusyError();
      return await operation();
    } finally {
      leave();
    }
  }
}
