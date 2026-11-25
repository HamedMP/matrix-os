import {
  APP_FILES_BRIDGE_PATH,
  APP_FILES_CHANNEL,
  APP_FILE_TIMEOUT_MS,
  AppFileErrorBodySchema,
  AppFileInputSchema,
  AppFileListReplySchema,
  AppFileMkdirReplySchema,
  AppFileReadReplySchema,
  AppFileStatReplySchema,
  AppFileWriteReplySchema,
  appFileErrorBody,
  appFileErrorCodeForStatus,
  appFileReplyBytes,
  appFileRequestBytes,
  type AppFileInput,
  type AppFileKind,
} from "@matrix-os/contracts/app-files";
import { AppIdentitySchema, MAX_APP_BRIDGE_REPLY_BYTES, MAX_APP_KV_REQUEST_BYTES } from "@matrix-os/contracts";
import { OPEN_REQUEST_ACK_KV_KEY, OPEN_REQUEST_KV_KEY } from "@matrix-os/contracts/office-open-with";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod/v4";
import {
  NATIVE_APP_OPEN_REQUEST_CHANNEL,
  NativeAppOpenRequestActionSchema,
  decodeNativeAppStoredValue,
  encodeNativeAppStoredValue,
  type NativeAppOpenRequestAction,
} from "../../shared/native-app-files";
import { readBoundedResponse, type CapabilitySender, type NativeAppRequesterOptions } from "./native-app-capabilities";

/** Same budget the web shell gives owner key-value requests. */
const OPEN_REQUEST_TIMEOUT_MS = 10_000;
/** Each file request may hold about 27 MB (base64 body and parsed reply). */
const MAX_PENDING_FILE_REQUESTS = 8;
const MAX_PENDING_OPEN_REQUESTS = 4;
const OPEN_REQUEST_UNAVAILABLE = "Open requests are unavailable";

const REPLY_SCHEMAS: Record<AppFileKind, z.ZodType> = {
  "files.list": AppFileListReplySchema,
  "files.stat": AppFileStatReplySchema,
  "files.read": AppFileReadReplySchema,
  "files.write": AppFileWriteReplySchema,
  "files.mkdir": AppFileMkdirReplySchema,
};
const KvReadReplySchema = z.object({ value: z.unknown() });

export interface NativeAppFilesRequester {
  /** Resolves with the reply body or an `appFileErrorBody`; never rejects. */
  files(app: string, input: AppFileInput, signal?: AbortSignal): Promise<unknown>;
  /** Reads the open request of `app`, or reads or writes its acknowledgement. Rejects with a generic error. */
  openRequest(app: string, action: NativeAppOpenRequestAction, signal?: AbortSignal): Promise<unknown>;
}

/** What the bridge knows about a registered app view. */
export interface NativeAppFilesIdentity { appIdentity: string; controller: AbortController }

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

async function postJson(options: NativeAppRequesterOptions, path: string, body: string, signal: AbortSignal): Promise<Response> {
  const token = options.getToken();
  if (!token) throw new Error("Authentication required");
  const origin = new URL(options.getGatewayOrigin());
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("Invalid gateway origin");
  return (options.fetchFn ?? fetch)(new URL(path, origin).toString(), {
    method: "POST", redirect: "error", signal, body,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

/** Runs `work` under one deadline that covers both the request and reading its body. */
async function withDeadline<T>(timeoutMs: number, senderSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = senderSignal ? AbortSignal.any([controller.signal, senderSignal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await work(signal); }
  finally { clearTimeout(timer); }
}

async function readErrorCode(response: Response, signal: AbortSignal) {
  const body = await readBoundedResponse(response, signal, MAX_APP_BRIDGE_REPLY_BYTES).catch((error: unknown) => {
    console.warn("[native-app-files] error body unavailable", errorName(error));
    return null;
  });
  const failure = AppFileErrorBodySchema.safeParse(body);
  return failure.success ? failure.data.error.code : appFileErrorCodeForStatus(response.status);
}

/** Gateway transport. Owner credentials stay in the main process. */
export function createNativeAppFilesRequester(options: NativeAppRequesterOptions): NativeAppFilesRequester {
  return {
    async files(app, rawInput, senderSignal) {
      const identity = AppIdentitySchema.safeParse(app);
      const input = AppFileInputSchema.safeParse(rawInput);
      if (!identity.success || !input.success) return appFileErrorBody("invalid_request");
      const { kind } = input.data;
      const body = JSON.stringify({ app: identity.data, input: input.data });
      if (Buffer.byteLength(body) > appFileRequestBytes(kind)) return appFileErrorBody("too_large");
      try {
        return await withDeadline(APP_FILE_TIMEOUT_MS, senderSignal, async (signal) => {
          const response = await postJson(options, APP_FILES_BRIDGE_PATH, body, signal);
          if (!response.ok) return appFileErrorBody(await readErrorCode(response, signal));
          // Only the contract's reply shape for this kind crosses to the app.
          const reply = REPLY_SCHEMAS[kind].safeParse(await readBoundedResponse(response, signal, appFileReplyBytes(kind)));
          return reply.success ? reply.data : appFileErrorBody("unavailable");
        });
      } catch (error: unknown) {
        console.warn("[native-app-files] request failed", errorName(error));
        return appFileErrorBody("unavailable");
      }
    },

    async openRequest(app, rawAction, senderSignal) {
      try {
        const identity = AppIdentitySchema.parse(app);
        const request = NativeAppOpenRequestActionSchema.parse(rawAction);
        const { action } = request;
        // Only Files writes the request key; the app records what it handled under the acknowledgement key.
        const body = JSON.stringify(action === "ack"
          ? { action: "write", app: identity, key: OPEN_REQUEST_ACK_KV_KEY, value: encodeNativeAppStoredValue(request.nonce) }
          : { action: "read", app: identity, key: action === "read" ? OPEN_REQUEST_KV_KEY : OPEN_REQUEST_ACK_KV_KEY });
        if (Buffer.byteLength(body) > MAX_APP_KV_REQUEST_BYTES) throw new Error("Request too large");
        return await withDeadline(OPEN_REQUEST_TIMEOUT_MS, senderSignal, async (signal) => {
          const response = await postJson(options, "/api/bridge/data", body, signal);
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Request failed");
          }
          const reply = await readBoundedResponse(response, signal, MAX_APP_BRIDGE_REPLY_BYTES);
          if (action === "ack") return { ok: true };
          return { value: decodeNativeAppStoredValue(KvReadReplySchema.parse(reply).value) ?? null };
        });
      } catch (error: unknown) {
        console.warn("[native-app-files] open request failed", errorName(error));
        throw new Error(OPEN_REQUEST_UNAVAILABLE);
      }
    },
  };
}

function senderOf(event: IpcMainInvokeEvent): CapabilitySender {
  if (event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed()) throw new Error("Not authorized");
  return { id: event.sender.id, get url() {
    if (event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed()) return "";
    return event.sender.getURL();
  } };
}

/**
 * Registers both file channels. `authorize` returns the registration of the
 * sending app view or throws; the app identity always comes from it, never from
 * the request. A reply is delivered only while the same registration is current.
 */
export function registerNativeAppFilesIpc(
  ipcMain: Pick<IpcMain, "handle">,
  requester: NativeAppFilesRequester,
  authorize: (sender: CapabilitySender) => NativeAppFilesIdentity,
): void {
  let pendingFiles = 0;
  let pendingOpenRequests = 0;
  const isCurrent = (sender: CapabilitySender, identity: NativeAppFilesIdentity) => {
    try { return authorize(sender) === identity; }
    catch (error: unknown) {
      console.warn("[native-app-files] app view changed", errorName(error));
      return false;
    }
  };

  ipcMain.handle(APP_FILES_CHANNEL, async (event: IpcMainInvokeEvent, rawInput: unknown) => {
    let sender: CapabilitySender;
    let identity: NativeAppFilesIdentity;
    try {
      sender = senderOf(event);
      identity = authorize(sender);
    } catch (error: unknown) {
      console.warn("[native-app-files] request refused", errorName(error));
      return appFileErrorBody("forbidden");
    }
    const input = AppFileInputSchema.safeParse(rawInput);
    if (!input.success) return appFileErrorBody("invalid_request");
    if (pendingFiles >= MAX_PENDING_FILE_REQUESTS) return appFileErrorBody("unavailable");
    pendingFiles++;
    try {
      const reply = await requester.files(identity.appIdentity, input.data, identity.controller.signal);
      return isCurrent(sender, identity) ? reply : appFileErrorBody("unavailable");
    } catch (error: unknown) {
      console.warn("[native-app-files] request failed", errorName(error));
      return appFileErrorBody("unavailable");
    } finally {
      pendingFiles--;
    }
  });

  ipcMain.handle(NATIVE_APP_OPEN_REQUEST_CHANNEL, async (event: IpcMainInvokeEvent, rawAction: unknown) => {
    let counted = false;
    try {
      const sender = senderOf(event);
      const identity = authorize(sender);
      const action = NativeAppOpenRequestActionSchema.parse(rawAction);
      if (pendingOpenRequests >= MAX_PENDING_OPEN_REQUESTS) throw new Error("Open requests are busy");
      pendingOpenRequests++;
      counted = true;
      const reply = await requester.openRequest(identity.appIdentity, action, identity.controller.signal);
      if (!isCurrent(sender, identity)) throw new Error("App view changed");
      return reply;
    } catch (error: unknown) {
      console.warn("[native-app-files] open request refused", errorName(error));
      throw new Error(OPEN_REQUEST_UNAVAILABLE);
    } finally {
      if (counted) pendingOpenRequests--;
    }
  });
}
