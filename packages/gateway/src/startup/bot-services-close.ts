import type { OwnedInferenceAnalytics } from "../bots/inference-analytics.js";
import type { BotContinuationAdmitter } from "../bots/continuations.js";

type Closable = { close(): void | Promise<unknown> };
export async function closeOwnedInferenceAnalytics(analytics?: OwnedInferenceAnalytics): Promise<void> {
  if (analytics && (await analytics.close()).drained !== true) throw new Error("Chat usage shutdown incomplete");
}

/** Reconciliation is one bounded owner pass at a time, and close drains the
 * actual accepted pass before the host may destroy its database. */
export function createBotConnectionReconciler(input: {
  available: boolean; intervalMs: number; reconcile(admit: BotContinuationAdmitter): Promise<void>;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;
  return {
    start(admit: BotContinuationAdmitter) {
      if (!input.available || timer || closed) return;
      timer = setInterval(() => {
        connecting ??= input.reconcile(admit).catch((error: unknown) => {
          console.warn("[bots] Connection reconciliation unavailable", { errorClass: error instanceof Error ? "Error" : "UnknownError" });
        }).finally(() => { connecting = undefined; });
      }, input.intervalMs);
      timer.unref();
    },
    async stop() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await connecting;
    },
  };
}

export function startBotInteractionSweeper(input: { intervalMs: number; expire(): Promise<unknown> }): () => Promise<void> {
  let sweeping: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    sweeping ??= input.expire().catch((error: unknown) => {
      console.warn("[bots] Question expiry unavailable", { errorClass: error instanceof Error ? "Error" : "UnknownError" });
    }).finally(() => { sweeping = undefined; });
  }, input.intervalMs);
  timer.unref();
  return async () => { clearInterval(timer); await sweeping; };
}

/** Drain all acquired resources even if one close fails. The host must await
 * this before destroying the owner database; incomplete analytics is a failure. */
export function createBotServicesCloser(input: {
  lifetime: AbortController; purgeDelivery?: Closable; copyLifecycle?: Closable; chatgptPlanPeers?: Closable;
  unregister(): void; registry: { shutdown(): void }; jevTools?: Closable;
  checkpointTimer?: ReturnType<typeof setInterval>; saveSweepTimer: ReturnType<typeof setInterval>;
  reconciling(): Promise<unknown> | undefined; sweepingSaves(): Promise<unknown> | undefined;
  stopConnections(): Promise<void>; stopSweep(): Promise<void>; reconciler: { stop(): void | Promise<void> };
  nativeTasks?: Closable; managed: Closable; googleData: Closable; qualifiedCredentials?: Closable;
  chatAnalytics?: OwnedInferenceAnalytics;
}): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => closing ??= (async () => {
    input.lifetime.abort();
    const work: Array<() => void | Promise<unknown>> = [
      () => input.purgeDelivery?.close(), () => input.copyLifecycle?.close(),
      () => input.chatgptPlanPeers?.close(), input.unregister, () => input.registry.shutdown(),
      () => input.jevTools?.close(),
      () => { if (input.checkpointTimer) clearInterval(input.checkpointTimer); clearInterval(input.saveSweepTimer); },
      () => input.reconciling(), () => input.sweepingSaves(), input.stopConnections, input.stopSweep,
      () => input.reconciler.stop(), () => input.nativeTasks?.close(), () => input.managed.close(),
      () => closeOwnedInferenceAnalytics(input.chatAnalytics), () => input.googleData.close(), () => input.qualifiedCredentials?.close(),
    ];
    let failed = false;
    for (const close of work) {
      try { await close(); }
      catch (error: unknown) {
        failed = true;
        console.warn("[bots] Service drain incomplete", { errorClass: error instanceof Error ? "Error" : "UnknownError" });
      }
    }
    if (failed) throw new Error("Bot service shutdown incomplete");
  })();
}
