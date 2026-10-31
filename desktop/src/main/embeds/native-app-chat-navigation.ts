import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  NATIVE_APP_CHAT_COMPLETION_CHANNEL,
  NativeAppChatCompletionSchema,
  type NativeAppChatCancellation,
  type NativeAppOpenChatEvent,
  type NativeAppOpenChatRequest,
} from "../../shared/native-app-chat";

type Pending = {
  requestId: string;
  resolve: () => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

export function createNativeAppChatNavigationBroker(options: {
  emit: (event: NativeAppOpenChatEvent) => void;
  cancel?: (event: NativeAppChatCancellation) => void;
  timeoutMs?: number;
}) {
  let pending: Pending | null = null;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 15_000, 30_000));

  const clear = (entry: Pending) => {
    clearTimeout(entry.timer);
    if (entry.signal && entry.abort) entry.signal.removeEventListener("abort", entry.abort);
    if (pending === entry) pending = null;
  };

  const cancel = (entry: Pending, error: Error) => {
    clear(entry);
    try {
      options.cancel?.({ requestId: entry.requestId });
    } catch (failure: unknown) {
      console.warn("[native-app-chat] cancellation delivery failed:", failure instanceof Error ? failure.name : "UnknownError");
    }
    entry.reject(error);
  };

  return {
    request(request: NativeAppOpenChatRequest, scope: { runtimeSlot: string; authGeneration: number }, signal?: AbortSignal): Promise<void> {
      if (pending) return Promise.reject(new Error("Chat navigation is busy"));
      if (signal?.aborted) return Promise.reject(new Error("Chat navigation canceled"));
      const requestId = `chat_${randomUUID().replaceAll("-", "")}`;
      return new Promise<void>((resolve, reject) => {
        const entry: Pending = {
          requestId,
          resolve,
          reject,
          timer: setTimeout(() => {
            cancel(entry, new Error("Chat navigation timed out"));
          }, timeoutMs),
          ...(signal ? { signal } : {}),
        };
        if (signal) {
          entry.abort = () => cancel(entry, new Error("Chat navigation canceled"));
          signal.addEventListener("abort", entry.abort, { once: true });
        }
        pending = entry;
        try {
          options.emit({ ...request, ...scope, requestId });
        } catch (failure: unknown) {
          console.warn("[native-app-chat] delivery failed:", failure instanceof Error ? failure.name : "UnknownError");
          clear(entry);
          reject(new Error("Chat navigation could not be delivered"));
        }
      });
    },
    complete(rawCompletion: unknown): void {
      const completion = NativeAppChatCompletionSchema.parse(rawCompletion);
      const entry = pending;
      if (!entry || entry.requestId !== completion.requestId) throw new Error("Unknown Chat navigation request");
      clear(entry);
      if (completion.ok) entry.resolve();
      else entry.reject(new Error("Chat navigation failed"));
    },
    cancelAll(): void {
      const entry = pending;
      if (!entry) return;
      cancel(entry, new Error("Chat navigation canceled"));
    },
  };
}

export function registerNativeAppChatCompletionIpc(
  ipcMain: Pick<IpcMain, "handle">,
  broker: ReturnType<typeof createNativeAppChatNavigationBroker>,
  authorizeRenderer: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle(NATIVE_APP_CHAT_COMPLETION_CHANNEL, (rawEvent: IpcMainInvokeEvent, completion: unknown) => {
    try {
      if (!authorizeRenderer(rawEvent)) throw new Error("not authorized");
      broker.complete(completion);
      return { ok: true };
    } catch (error: unknown) {
      console.warn("[native-app-chat] completion rejected:", error instanceof Error ? error.name : "UnknownError");
      throw new Error("Chat navigation completion is unavailable");
    }
  });
}
