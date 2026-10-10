import { resolve } from "node:path";

const MAX_ACTIVE_HOMES = 64;
const MAX_PENDING_PER_HOME = 32;
interface MutationQueue { tail: Promise<void>; users: number }
// Process-local, shared by gallery services and File API registrars. Never evict a live holder.
// Settlement removes idle entries; both active homes and each home's waiting requests are capped.
const queues = new Map<string, MutationQueue>();
export class OwnerFileMutationBusyError extends Error {
  readonly status = 503;
  constructor() { super("Owner file mutations are busy"); }
}

/** Acquire once at the outer mutation boundary; callers must not acquire recursively. */
export async function withOwnerFileMutation<T>(homePath: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(homePath);
  let queue = queues.get(key);
  if (!queue) {
    if (queues.size >= MAX_ACTIVE_HOMES) throw new OwnerFileMutationBusyError();
    queue = { tail: Promise.resolve(), users: 0 };
    queues.set(key, queue);
  } else if (queue.users >= MAX_PENDING_PER_HOME + 1) {
    throw new OwnerFileMutationBusyError();
  }
  const previous = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>(done => { release = done; });
  queue.users++;
  await previous;
  try { return await operation(); }
  finally {
    queue.users--;
    release();
    if (queue.users === 0) queues.delete(key);
  }
}
