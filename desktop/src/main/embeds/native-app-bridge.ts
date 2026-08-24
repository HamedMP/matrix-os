import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod/v4";
import {
  NATIVE_APP_QUERY_CHANNEL,
  NativeAppQuerySchema,
  type NativeAppQuery,
} from "../../shared/native-app-bridge";

const SAFE_APP_IDENTITY = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const MAX_APP_IDENTITY_LENGTH = 256;
const DEFAULT_MAX_SENDERS = 64;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

const JsonRecordSchema = z.record(z.string(), z.json());
const MutationResponseSchema = z.strictObject({ ok: z.literal(true) });

function parseQueryResponse(query: NativeAppQuery, value: unknown): unknown {
  const schema = (() => {
    switch (query.action) {
      case "find":
        return z.array(JsonRecordSchema).max(10_000);
      case "findOne":
        return JsonRecordSchema.nullable();
      case "insert":
        return z.strictObject({ id: z.string().min(1).max(512) });
      case "bulkInsert":
        return z.strictObject({ ids: z.array(z.string().min(1).max(512)).max(200) });
      case "update":
      case "bulkUpdate":
      case "delete":
        return MutationResponseSchema;
      case "count":
        return z.strictObject({ count: z.number().int().min(0) });
      case "schema":
        return JsonRecordSchema.nullable();
      case "appInfo":
        return z.strictObject({ installedVersion: z.string().min(1).max(128).nullable() });
    }
  })();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("invalid database response");
  return parsed.data;
}

function isSafeAppIdentity(value: string): boolean {
  return value.length <= MAX_APP_IDENTITY_LENGTH && SAFE_APP_IDENTITY.test(value);
}

interface NativeAppBridgeOptions {
  request: (slug: string, query: NativeAppQuery) => Promise<unknown>;
  gatewayOrigin: () => string;
  maxSenders?: number;
}

export interface NativeAppSender {
  id: number;
  url: string;
}

interface NativeAppQueryRequesterOptions {
  getGatewayOrigin: () => string;
  getToken: () => string | null;
  fetchFn?: typeof fetch;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("database response too large");
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("database response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function createNativeAppQueryRequester(
  options: NativeAppQueryRequesterOptions,
): (slug: string, query: NativeAppQuery) => Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  return async (slug, rawQuery) => {
    if (!isSafeAppIdentity(slug)) throw new Error("invalid app identity");
    const query = NativeAppQuerySchema.parse(rawQuery);
    const token = options.getToken();
    if (!token) throw new Error("desktop authentication required");
    const origin = new URL(options.getGatewayOrigin());
    if (origin.protocol !== "https:" && origin.protocol !== "http:") {
      throw new Error("invalid gateway origin");
    }

    const response = await fetchFn(new URL("/api/bridge/query", origin).toString(), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ app: slug, ...query }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`database request failed (${response.status})`);
    return parseQueryResponse(query, await readBoundedJson(response));
  };
}

function isSenderAtApp(sender: NativeAppSender, origin: string, slug: string): boolean {
  try {
    const url = new URL(sender.url);
    return url.origin === new URL(origin).origin
      && (url.pathname === `/apps/${slug}` || url.pathname.startsWith(`/apps/${slug}/`));
  } catch {
    return false;
  }
}

export class NativeAppBridge {
  private readonly senders = new Map<number, { appIdentity: string; routeSlug: string }>();
  private readonly options: NativeAppBridgeOptions;
  private readonly maxSenders: number;

  constructor(options: NativeAppBridgeOptions) {
    this.options = options;
    this.maxSenders = Math.max(1, Math.min(options.maxSenders ?? DEFAULT_MAX_SENDERS, DEFAULT_MAX_SENDERS));
  }

  register(senderId: number, appIdentity: string, routeSlug = appIdentity): void {
    if (
      !Number.isSafeInteger(senderId)
      || senderId < 1
      || !isSafeAppIdentity(appIdentity)
      || !isSafeAppIdentity(routeSlug)
    ) {
      throw new Error("invalid app bridge identity");
    }
    this.senders.delete(senderId);
    this.senders.set(senderId, { appIdentity, routeSlug });
    while (this.senders.size > this.maxSenders) {
      const oldest = this.senders.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.senders.delete(oldest);
    }
  }

  unregister(senderId: number): void {
    this.senders.delete(senderId);
  }

  clear(): void {
    this.senders.clear();
  }

  async query(sender: NativeAppSender, rawQuery: unknown): Promise<unknown> {
    const identity = this.senders.get(sender.id);
    if (!identity || !isSenderAtApp(sender, this.options.gatewayOrigin(), identity.routeSlug)) {
      throw new Error("not authorized");
    }
    const parsed = NativeAppQuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new Error("invalid request");
    return this.options.request(identity.appIdentity, parsed.data);
  }

  registerIpc(ipcMain: Pick<IpcMain, "handle">): void {
    ipcMain.handle(NATIVE_APP_QUERY_CHANNEL, async (event: IpcMainInvokeEvent, rawQuery: unknown) => {
      try {
        return await this.query({ id: event.sender.id, url: event.sender.getURL() }, rawQuery);
      } catch (error: unknown) {
        console.warn(
          "[native-app-bridge] query failed:",
          error instanceof Error ? error.message : String(error),
        );
        throw new Error("app database request failed");
      }
    });
  }
}
