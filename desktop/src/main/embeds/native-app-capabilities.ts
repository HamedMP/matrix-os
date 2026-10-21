import {
  APP_CAPABILITY_CHANNEL,
  APP_CAPABILITY_TIMEOUT_MS,
  APP_AI_ROUTES_CHANNEL,
  AppCapabilityInputSchema,
  AppIdentitySchema,
  AppAiRoutesSchema,
  type AppCapabilityInput,
  MAX_APP_BRIDGE_REPLY_BYTES,
  MAX_APP_RESPONSE_CHUNKS,
  appCapabilityReplyBytes,
} from "@matrix-os/contracts";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod/v4";

export interface NativeAppRequesterOptions {
  getGatewayOrigin: () => string;
  getToken: () => string | null;
  fetchFn?: typeof fetch;
}
export interface CapabilitySender { id: number; readonly url: string }

async function readBoundedResponse(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  if (signal.aborted) {
    await response.body?.cancel();
    throw new Error("Request cancelled");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }
  if (!response.body) throw new Error("Missing response");
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel().catch((error: unknown) => console.warn("[native-app-capabilities] cancellation failed", error instanceof Error ? error.name : "UnknownError"));
    return cancellation;
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let chunkCount = 0;
  try {
    if (signal.aborted) { await cancel(); throw new Error("Request cancelled"); }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("Request cancelled");
      if (done) break;
      if (++chunkCount > MAX_APP_RESPONSE_CHUNKS) { await cancel(); throw new Error("Too many response chunks"); }
      size += value.byteLength;
      if (size > maxBytes) { await cancel(); throw new Error("Response too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    // Keep the host's pending slot until stream cancellation has drained.
    await cancellation;
    reader.releaseLock();
  }
}

export async function requestNativeAppJson(options: NativeAppRequesterOptions, path: string, init: RequestInit, maxBytes = MAX_APP_BRIDGE_REPLY_BYTES, senderSignal?: AbortSignal, timeoutMs = APP_CAPABILITY_TIMEOUT_MS): Promise<unknown> {
  const token = options.getToken();
  if (!token) throw new Error("Authentication required");
  const origin = new URL(options.getGatewayOrigin());
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("Invalid gateway origin");
  const controller = new AbortController();
  const signal = senderSignal ? AbortSignal.any([controller.signal, senderSignal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchFn ?? fetch)(new URL(path, origin).toString(), {
      ...init, redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Request failed"); }
    return await readBoundedResponse(response, signal, maxBytes);
  } finally {
    clearTimeout(timer);
  }
}

export function createNativeAppCapabilityRequester(options: NativeAppRequesterOptions) {
  return async (app: string, rawInput: AppCapabilityInput, signal?: AbortSignal): Promise<unknown> => {
    try {
      const identity = AppIdentitySchema.parse(app);
      const input = AppCapabilityInputSchema.parse(rawInput);
      return await requestNativeAppJson(options, "/api/bridge/capabilities", { method: "POST", body: JSON.stringify({ app: identity, input }) }, appCapabilityReplyBytes(input), signal);
    } catch (error) {
      console.warn("[native-app-capabilities] request failed", error instanceof Error ? error.name : "UnknownError");
      throw new Error("App integrations are unavailable");
    }
  };
}

export function createNativeAppAiRoutesRequester(options: NativeAppRequesterOptions) {
  return async (app: string, signal?: AbortSignal): Promise<unknown> => {
    try {
      const identity = AppIdentitySchema.parse(app);
      const params = new URLSearchParams({ app: identity });
      return AppAiRoutesSchema.parse(await requestNativeAppJson(options, `/api/bridge/ai/routes?${params}`, { method: "GET" }, MAX_APP_BRIDGE_REPLY_BYTES, signal));
    } catch (error) {
      console.warn("[native-app-capabilities] AI routes failed", error instanceof Error ? error.name : "UnknownError");
      throw new Error("App AI is unavailable");
    }
  };
}

/** Main-frame and live URL checks remain in the trusted process. */
export function registerNativeAppCapabilityIpc(ipcMain: Pick<IpcMain, "handle">, options: {
  capability: (sender: CapabilitySender, input: unknown) => Promise<unknown>;
  aiRoutes: (sender: CapabilitySender) => Promise<unknown>;
}) {
  const sender = (event: IpcMainInvokeEvent): CapabilitySender => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed()) throw new Error("Not authorized");
    return { id: event.sender.id, get url() {
      if (event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed()) return "";
      return event.sender.getURL();
    } };
  };
  ipcMain.handle(APP_CAPABILITY_CHANNEL, async (event, rawInput: unknown) => {
    try { return await options.capability(sender(event), rawInput); }
    catch (error) {
      console.warn("[native-app-capabilities] IPC failed", error instanceof Error ? error.name : "UnknownError");
      throw new Error("App integrations are unavailable");
    }
  });
  ipcMain.handle(APP_AI_ROUTES_CHANNEL, async (event, rawInput: unknown) => {
    try {
      z.strictObject({}).parse(rawInput);
      return await options.aiRoutes(sender(event));
    } catch (error) {
      console.warn("[native-app-capabilities] AI routes IPC failed", error instanceof Error ? error.name : "UnknownError");
      throw new Error("App AI is unavailable");
    }
  });
}
