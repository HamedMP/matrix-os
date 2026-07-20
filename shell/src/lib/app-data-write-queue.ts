export type BridgeDataAction = "read" | "write";

export type BridgeDataRequest = (
  action: BridgeDataAction,
  app: string,
  key: string,
  value: string | undefined,
) => Promise<unknown>;

interface WriteWaiter {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface PendingWrite {
  app: string;
  key: string;
  value: string | undefined;
  waiters: WriteWaiter[];
}

interface ActiveWrite {
  pending: PendingWrite | null;
  drained: Promise<void>;
  resolveDrained: () => void;
}

const DEFAULT_MAX_ACTIVE_DATA_KEYS = 128;

/**
 * Keep one request in flight per app/key and retain only its latest pending
 * value. The bounded queue belongs to the parent AppViewer, so posted edits
 * keep saving after the child iframe is removed without building an unbounded
 * per-keystroke request chain.
 */
export function createCoalescedBridgeDataHandler(
  request: BridgeDataRequest,
  maxActiveKeys = DEFAULT_MAX_ACTIVE_DATA_KEYS,
): BridgeDataRequest {
  const activeWrites = new Map<string, ActiveWrite>();

  const startWrite = (id: string, active: ActiveWrite, write: PendingWrite): void => {
    let result: Promise<unknown>;
    try {
      result = request("write", write.app, write.key, write.value);
    } catch (err: unknown) {
      result = Promise.reject(err);
    }

    void result
      .then(
        (value) => write.waiters.forEach((waiter) => waiter.resolve(value)),
        (err: unknown) => write.waiters.forEach((waiter) => waiter.reject(err)),
      )
      .finally(() => {
        const next = active.pending;
        active.pending = null;
        if (next) {
          startWrite(id, active, next);
          return;
        }
        activeWrites.delete(id);
        active.resolveDrained();
      });
  };

  return async (action, app, key, value) => {
    const id = `${app}\u0000${key}`;
    if (action === "read") {
      let active = activeWrites.get(id);
      while (active) {
        await active.drained;
        active = activeWrites.get(id);
      }
      return request(action, app, key, value);
    }

    return new Promise<unknown>((resolve, reject) => {
      const waiter = { resolve, reject };
      const active = activeWrites.get(id);
      if (active) {
        if (active.pending) {
          active.pending.value = value;
          active.pending.waiters.push(waiter);
        } else {
          active.pending = { app, key, value, waiters: [waiter] };
        }
        return;
      }

      if (activeWrites.size >= maxActiveKeys) {
        reject(new Error("Too many active app data keys"));
        return;
      }

      let resolveDrained: () => void = () => void 0;
      const drained = new Promise<void>((resolveDrain) => {
        resolveDrained = resolveDrain;
      });
      const nextActive: ActiveWrite = { pending: null, drained, resolveDrained };
      activeWrites.set(id, nextActive);
      startWrite(id, nextActive, { app, key, value, waiters: [waiter] });
    });
  };
}
