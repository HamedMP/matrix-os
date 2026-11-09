import {
  readUsageSyncPairing,
  transferUsageHistory,
  type UsageSyncPairing,
} from "./transfer";
interface Session {
  runtimeSlot: string;
  authGeneration: number;
  force?: boolean;
}
interface Owner extends Session {
  signedIn: boolean;
  userId?: string;
}
export function createUsageSyncService(options: {
  home: string;
  pairingFile: string;
  auth: { getStatus(): Owner; getGatewayOrigin(): string };
  readPairing?: (path: string) => Promise<UsageSyncPairing | null>;
  transfer?: typeof transferUsageHistory;
}) {
  type Result = { status: "synced"; syncedAt: string } | { status: "unpaired" };
  let disposed = false,
    restart = false,
    pending: Promise<Result> | null = null,
    pendingKey: string | null = null;
  let completed: { key: string; value: Result; at: number } | null = null;
  let controller: AbortController | null = null,
    timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay = 60 * 60 * 1000) => {
    if (timer) clearTimeout(timer);
    if (disposed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void sync(options.auth.getStatus()).catch((error: unknown) =>
        console.warn(
          "[ai-usage] background sync unavailable",
          error instanceof Error ? error.name : "UnknownError",
        ),
      );
    }, delay);
    timer.unref?.();
  };
  async function sync(request: Session): Promise<Result> {
    if (disposed) throw new Error("Usage sync unavailable");
    const start = options.auth.getStatus(),
      origin = options.auth.getGatewayOrigin();
    if (
      !start.signedIn ||
      !start.userId ||
      start.runtimeSlot !== request.runtimeSlot ||
      start.authGeneration !== request.authGeneration
    )
      throw new Error("Usage sync unavailable");
    const key = JSON.stringify([
      start.userId,
      start.runtimeSlot,
      start.authGeneration,
      origin,
    ]);
    if (pending) {
      if (pendingKey === key && !controller?.signal.aborted) return pending;
      try {
        await pending;
      } catch (error: unknown) {
        console.warn(
          "[ai-usage] previous sync drained",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
      return sync(request);
    }
    if (
      !request.force &&
      completed?.key === key &&
      Date.now() - completed.at < 60 * 60 * 1000
    )
      return completed.value;
    if (timer) clearTimeout(timer);
    const abort = new AbortController();
    controller = abort;
    restart = false;
    const current = () => {
      const now = options.auth.getStatus();
      if (
        abort.signal.aborted ||
        !now.signedIn ||
        now.userId !== start.userId ||
        now.runtimeSlot !== start.runtimeSlot ||
        now.authGeneration !== start.authGeneration ||
        options.auth.getGatewayOrigin() !== origin
      )
        throw new Error("Usage sync unavailable");
    };
    const task = (async () => {
      const pairing = await (options.readPairing ?? readUsageSyncPairing)(
        options.pairingFile,
      );
      current();
      if (!pairing) return { status: "unpaired" as const };
      if (
        pairing.ownerId !== start.userId ||
        pairing.runtimeSlot !== start.runtimeSlot ||
        pairing.gatewayOrigin !== origin
      )
        throw new Error("Usage sync is not paired");
      await (options.transfer ?? transferUsageHistory)(
        pairing,
        options.home,
        AbortSignal.any([abort.signal, AbortSignal.timeout(20 * 60 * 1000)]),
      );
      current();
      const value = {
        status: "synced" as const,
        syncedAt: new Date().toISOString(),
      };
      completed = { key, value, at: Date.now() };
      return value;
    })();
    pendingKey = key;
    pending = task;
    try {
      return await task;
    } finally {
      if (pending === task) {
        pending = null;
        pendingKey = null;
        controller = null;
        schedule(restart ? 0 : undefined);
      }
    }
  }
  schedule(0);
  return {
    sync,
    cancel() {
      restart = true;
      completed = null;
      controller?.abort();
      schedule(0);
    },
    async dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      try {
        await pending;
      } catch (error: unknown) {
        console.warn(
          "[ai-usage] sync stopped",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    },
  };
}
