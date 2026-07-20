export type BridgeDataAction = "read" | "write";

export type BridgeDataRequest = (
  action: BridgeDataAction,
  app: string,
  key: string,
  value: string | undefined,
) => Promise<unknown>;

interface PendingWrite {
  app: string;
  key: string;
  value: string | undefined;
  completion: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface ActiveWrite {
  pending: PendingWrite | null;
  drained: Promise<void>;
  resolveDrained: () => void;
}

const DEFAULT_MAX_ACTIVE_DATA_KEYS = 128;

/**
 * Keep one request in flight per app/key and retain only its latest pending
 * value. A caller can keep the bounded handler above individual AppViewer
 * lifetimes, so posted edits continue after an iframe is removed without
 * building an unbounded per-keystroke request chain.
 */
export function createCoalescedBridgeDataHandler(
  request: BridgeDataRequest,
  maxActiveKeys = DEFAULT_MAX_ACTIVE_DATA_KEYS,
): BridgeDataRequest {
  const activeWrites = new Map<string, ActiveWrite>();

  const createPendingWrite = (
    app: string,
    key: string,
    value: string | undefined,
  ): PendingWrite => {
    let resolve: (result: unknown) => void = () => void 0;
    let reject: (reason: unknown) => void = () => void 0;
    const completion = new Promise<unknown>((resolveWrite, rejectWrite) => {
      resolve = resolveWrite;
      reject = rejectWrite;
    });
    return { app, key, value, completion, resolve, reject };
  };

  const startWrite = (id: string, active: ActiveWrite, write: PendingWrite): void => {
    let result: Promise<unknown>;
    try {
      result = request("write", write.app, write.key, write.value);
    } catch (err: unknown) {
      result = Promise.reject(err);
    }

    void result
      .then(
        (value) => write.resolve(value),
        (err: unknown) => write.reject(err),
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

  const readAfterWrites = async (
    id: string,
    app: string,
    key: string,
    value: string | undefined,
  ): Promise<unknown> => {
    let active = activeWrites.get(id);
    while (active) {
      await active.drained;
      active = activeWrites.get(id);
    }
    return request("read", app, key, value);
  };

  return (action, app, key, value) => {
    const id = `${app}\u0000${key}`;
    if (action === "read") {
      return readAfterWrites(id, app, key, value);
    }

    const active = activeWrites.get(id);
    if (active) {
      if (active.pending) {
        // The prior pending value will never be sent. Settle its caller as
        // accepted by the queue immediately, then retain only the latest
        // value and its completion promise.
        active.pending.resolve(undefined);
      }
      const pending = createPendingWrite(app, key, value);
      active.pending = pending;
      return pending.completion;
    }

    if (activeWrites.size >= maxActiveKeys) {
      return Promise.reject(new Error("Too many active app data keys"));
    }

    let resolveDrained: () => void = () => void 0;
    const drained = new Promise<void>((resolveDrain) => {
      resolveDrained = resolveDrain;
    });
    const nextActive: ActiveWrite = { pending: null, drained, resolveDrained };
    const write = createPendingWrite(app, key, value);
    activeWrites.set(id, nextActive);
    startWrite(id, nextActive, write);
    return write.completion;
  };
}
