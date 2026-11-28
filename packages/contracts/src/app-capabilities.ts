import { z } from "zod/v4";

export const APP_CAPABILITY_CHANNEL = "native-app:capability";
export const APP_CAPABILITY_TIMEOUT_MS = 35_000;
export const MAX_APP_CAPABILITY_BYTES = 65_536;
/** Matches the bounded connected-account inventory accepted by the gateway. */
export const MAX_APP_CONNECTED_SERVICES = 256;
export const MAX_APP_BRIDGE_REPLY_BYTES = 256 * 1024;
/** Count every streamed chunk, including empty chunks, independently of byte limits. */
export const MAX_APP_RESPONSE_CHUNKS = 8192;
/** Database replies retain the established Electron bridge budget. find supports
 * limit/offset paging; hosts reject oversized replies without truncating rows. */
export const MAX_APP_DATABASE_REPLY_BYTES = 8 * 1024 * 1024;
/** Exact JSON body limits of the existing structured database and legacy KV endpoints. */
export const MAX_APP_DATABASE_REQUEST_BYTES = 1_000_000;
export const MAX_APP_KV_REQUEST_BYTES = 1_000_000;
/** Envelope prefix for typed `readData`/`writeData` values; owner and public-site bridges share stored rows. */
export const APP_BRIDGE_STORED_VALUE_PREFIX = "__matrix_os_value_v1__:";
/** Month views exceed the default; an oversized reply fails whole. */
const LARGE_INTEGRATION_REPLY_BYTES: Readonly<Record<string, number>> = Object.freeze({
  "google_calendar/list_events": 1024 * 1024,
});
export function appIntegrationReplyBytes(service: string, action: string): number {
  if (service === "gmail" && action === "get_attachment") return 1536 * 1024;
  const large = LARGE_INTEGRATION_REPLY_BYTES[`${service}/${action}`];
  if (large !== undefined) return large;
  //512KiB source text may require six JSON bytes per escaped ASCII character.
  if (service === "google_drive" && action === "read_file") return 3 * 1024 * 1024 + 32 * 1024;
  return MAX_APP_BRIDGE_REPLY_BYTES;
}
export function appCapabilityReplyBytes(input?: AppCapabilityInput): number {
  return input?.kind === "integrations.call" ? appIntegrationReplyBytes(input.service, input.action) : MAX_APP_BRIDGE_REPLY_BYTES;
}
export const AppIdentitySchema = z.string().min(1).max(256).regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/);
/** Only OS-bundled migrations have a runtime URL alias. Persisted grants and
 * storage always retain the full identity; arbitrary nested apps never alias. */
export function appRuntimeSlugFromIdentity(identity: string): string {
  AppIdentitySchema.parse(identity);
  const migrated = /^games\/(2048|backgammon|chess|minesweeper|snake|solitaire|tetris)$/.exec(identity);
  return migrated?.[1] ?? identity;
}
const Name = z.string().min(1).max(128).regex(/^[a-z][a-z0-9_-]*$/);
const Call = z.strictObject({
  kind: z.literal("integrations.call"),
  service: Name,
  action: Name,
  params: z.record(z.string().max(128), z.json()).optional(),
  label: z.string().trim().min(1).max(100).optional(),
});
function boundedUtf8(value: string): boolean {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_APP_CAPABILITY_BYTES - 512) return false;
  }
  return true;
}

export const AppCapabilityInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capabilities") }),
  z.strictObject({ kind: z.literal("integrations.list") }),
  z.strictObject({ kind: z.literal("integrations.describe"), service: Name }),
  Call,
]).refine((value) => boundedUtf8(JSON.stringify(value)));
export type AppCapabilityInput = z.infer<typeof AppCapabilityInputSchema>;
export const AppCapabilityRequestSchema = z.strictObject({ app: AppIdentitySchema, input: AppCapabilityInputSchema });
export const AppConnectedServiceSchema = z.object({
  service: Name,
  account_label: z.string().max(100),
  account_email: z.string().max(320).nullable().optional(),
  status: z.string().max(64),
});
export const AppCapabilitiesSchema = z.strictObject({
  version: z.literal(1),
  integrations: z.boolean(),
  ai: z.boolean(),
});
export type AppCapabilities = z.infer<typeof AppCapabilitiesSchema>;
export const AppServiceDescriptionSchema = z.object({
  service: Name,
  name: z.string().max(160),
  actions: z.array(z.object({
    id: Name,
    description: z.string().max(4_000),
    risk: z.enum(["read", "write", "destructive"]),
    params: z.record(z.string().max(128), z.json()),
  })).max(200),
});
export type AppServiceDescription = z.infer<typeof AppServiceDescriptionSchema>;

/**
 * A host whose transport drops error details (Electron IPC, `contextBridge`)
 * resolves a failed request with `{ [APP_CAPABILITY_ERROR_KEY]: status }`
 * instead. Only these statuses cross: they tell an app what to do (choose an
 * account, connect one, wait) and carry no provider or account detail.
 */
export const APP_CAPABILITY_ERROR_KEY = "__matrixAppCapabilityError";
export const APP_CAPABILITY_FAILURE_STATUSES = [400, 403, 404, 409, 429] as const;
export type AppCapabilityFailureStatus = (typeof APP_CAPABILITY_FAILURE_STATUSES)[number];

function safeFailureStatus(value: unknown): AppCapabilityFailureStatus | undefined {
  return (APP_CAPABILITY_FAILURE_STATUSES as readonly unknown[]).includes(value) ? value as AppCapabilityFailureStatus : undefined;
}

/** The failure reply for a gateway status, or undefined when the status must not cross. */
export function appCapabilityFailureReply(status: number): { [APP_CAPABILITY_ERROR_KEY]: AppCapabilityFailureStatus } | undefined {
  const safe = safeFailureStatus(status);
  return safe === undefined ? undefined : { [APP_CAPABILITY_ERROR_KEY]: safe };
}

function isFailureReply(value: unknown): value is Record<typeof APP_CAPABILITY_ERROR_KEY, unknown> {
  return typeof value === "object" && value !== null && Object.hasOwn(value, APP_CAPABILITY_ERROR_KEY);
}

const UNAVAILABLE = "App integrations are unavailable";
const INVALID = "Invalid app capability request";

/** Every client failure. `status` is set only for an allowlisted gateway status. */
export class AppCapabilityRequestError extends Error {
  readonly status?: AppCapabilityFailureStatus;
  readonly invalid: boolean;

  constructor(status?: AppCapabilityFailureStatus, invalid = false) {
    super(invalid ? INVALID : UNAVAILABLE);
    this.name = "AppCapabilityRequestError";
    this.invalid = invalid;
    if (status !== undefined) this.status = status;
  }
}

/** App identity and credentials are supplied by the trusted host, never the app. */
export function createAppCapabilityClient(invoke: (input: AppCapabilityInput) => Promise<unknown>) {
  async function request(input: unknown): Promise<unknown> {
    const parsed = AppCapabilityInputSchema.safeParse(input);
    if (!parsed.success) throw new AppCapabilityRequestError(undefined, true);
    let reply: unknown;
    try { reply = await invoke(parsed.data); }
    catch (error) {
      console.warn("[app-capabilities] request failed", error instanceof Error ? error.name : "UnknownError");
      throw new AppCapabilityRequestError();
    }
    if (isFailureReply(reply)) throw new AppCapabilityRequestError(safeFailureStatus(reply[APP_CAPABILITY_ERROR_KEY]));
    return reply;
  }
  return Object.freeze({
    capabilities: async (): Promise<AppCapabilities> => AppCapabilitiesSchema.parse(await request({ kind: "capabilities" })),
    integrations: async () => z.object({ services: z.array(AppConnectedServiceSchema).max(MAX_APP_CONNECTED_SERVICES) }).parse(await request({ kind: "integrations.list" })).services,
    describeService: async (service: string): Promise<AppServiceDescription> => AppServiceDescriptionSchema.parse(await request({ kind: "integrations.describe", service })),
    service: async (service: string, action: string, params: Record<string, unknown> = {}, label?: string): Promise<unknown> => request({
      kind: "integrations.call", service, action, params, ...(label !== undefined ? { label } : {}),
    }),
  });
}

export type AppCapabilityClient = ReturnType<typeof createAppCapabilityClient>;
/** A call's outcome as plain data, so it survives a copy that drops error properties. */
export type AppCapabilityResult<T> = { ok: true; value: T } | { ok: false; status?: AppCapabilityFailureStatus; invalid?: true };

function settle<A extends unknown[], T>(call: (...args: A) => Promise<T>): (...args: A) => Promise<AppCapabilityResult<T>> {
  return async (...args) => {
    try { return { ok: true, value: await call(...args) }; }
    catch (error: unknown) {
      if (!(error instanceof AppCapabilityRequestError)) {
        console.warn("[app-capabilities] reply rejected", error instanceof Error ? error.name : "UnknownError");
        return { ok: false };
      }
      if (error.invalid) return { ok: false, invalid: true };
      return error.status === undefined ? { ok: false } : { ok: false, status: error.status };
    }
  };
}

/**
 * The client with every call resolving to an `AppCapabilityResult`. A host
 * that copies the client into another world exposes this and rethrows there.
 */
export function settleAppCapabilityClient(client: AppCapabilityClient) {
  return Object.freeze({
    capabilities: settle(client.capabilities),
    integrations: settle(client.integrations),
    describeService: settle(client.describeService),
    service: settle(client.service),
  });
}
