/**
 * Server-side integration access for bots (spec 536). Bots never hold a
 * bearer: the gateway calls integrations for the owner. On a customer
 * machine that is the platform's internal integrations route, authenticated
 * with the machine token and a signed delegation of the owner; with local
 * integrations it is the gateway's own routes, called in process. Accounts
 * are selected by label, so a call names a label that is unique for its
 * service. Every call is bounded in time and size, and failures surface as
 * allowlisted codes, never upstream text.
 */
import type { Hono } from "hono";
import { z } from "zod/v4";
import { delegatedIntegrationHeaders } from "../integrations/delegated-identity.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "../integrations/scope-provenance.js";

const LIST_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 25_000;
const MAX_LIST_BYTES = 128 * 1024;
const MAX_CALL_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 256;

export type BotIntegrationErrorCode = "unavailable" | "ambiguous" | "missing" | "invalid" | "denied";

export class BotIntegrationError extends Error {
  constructor(readonly code: BotIntegrationErrorCode) {
    super(`Integration request failed: ${code}`);
    this.name = "BotIntegrationError";
  }
}

export interface BotIntegrationConnection {
  connectionId: string;
  service: string;
  label: string;
}

/** Sends one request for the owner and returns the upstream response. */
export type BotIntegrationTransport = (ownerId: string, request: {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  readScope?: boolean;
  signal: AbortSignal;
}) => Promise<Response>;

const InventorySchema = z.array(z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  service: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  account_label: z.string().min(1).max(120),
  status: z.string().max(32),
}).passthrough()).max(MAX_CONNECTIONS);

const CallResultSchema = z.object({ data: z.unknown(), summary: z.string().max(2_000).optional() }).passthrough();
const ConnectResultSchema = z.object({ url: z.url({ protocol: /^https$/ }).max(4_096) }).passthrough();

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new BotIntegrationError("unavailable");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BotIntegrationError("unavailable");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function failureFor(status: number): BotIntegrationErrorCode {
  if (status === 409) return "ambiguous";
  if (status === 400 || status === 404) return "missing";
  if (status === 403 || status === 401) return "denied";
  return "unavailable";
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new BotIntegrationError(failureFor(response.status));
  }
  try {
    return JSON.parse(await boundedText(response, maxBytes));
  } catch (error: unknown) {
    if (error instanceof BotIntegrationError) throw error;
    throw new BotIntegrationError("unavailable");
  }
}

export function createBotIntegrationClient(transport: BotIntegrationTransport) {
  async function send<T>(ownerId: string, request: Omit<Parameters<BotIntegrationTransport>[1], "signal">, timeoutMs: number, parse: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = await transport(ownerId, { ...request, signal: bounded });
    } catch (error: unknown) {
      console.warn("[bots] integration request failed:", error instanceof Error ? error.name : "UnknownError");
      throw new BotIntegrationError("unavailable");
    }
    return parse(response);
  }

  return {
    /** The owner's active connected accounts. */
    async inventory(ownerId: string, signal?: AbortSignal): Promise<BotIntegrationConnection[]> {
      return send(ownerId, { method: "GET", path: "/" }, LIST_TIMEOUT_MS, async (response) => {
        const rows = InventorySchema.safeParse(await readJson(response, MAX_LIST_BYTES));
        if (!rows.success) throw new BotIntegrationError("unavailable");
        return rows.data.filter((row) => row.status === "active")
          .map((row) => ({ connectionId: row.id, service: row.service, label: row.account_label }));
      }, signal);
    },
    /** A provider-hosted consent URL for connecting a new account of `service`. */
    async connect(ownerId: string, service: string, signal?: AbortSignal): Promise<string> {
      return send(ownerId, { method: "POST", path: "/connect", body: { service } }, LIST_TIMEOUT_MS, async (response) => {
        const result = ConnectResultSchema.safeParse(await readJson(response, MAX_LIST_BYTES));
        if (!result.success) throw new BotIntegrationError("unavailable");
        return result.data.url;
      }, signal);
    },
    /** Asks integrations to pick up accounts connected since the last sync. */
    async sync(ownerId: string, signal?: AbortSignal): Promise<void> {
      await send(ownerId, { method: "POST", path: "/sync" }, CALL_TIMEOUT_MS, async (response) => {
        await readJson(response, MAX_CALL_BYTES);
      }, signal);
    },
    /** Runs one action on the account with `label`. Reads use the read-only route, which never syncs. */
    async call(ownerId: string, input: { service: string; action: string; label: string; params: Record<string, unknown>; read: boolean }, signal?: AbortSignal) {
      return send(ownerId, {
        method: "POST",
        path: input.read ? "/read-call" : "/call",
        body: { service: input.service, action: input.action, label: input.label, params: input.params },
        readScope: input.read,
      }, CALL_TIMEOUT_MS, async (response) => {
        const result = CallResultSchema.safeParse(await readJson(response, MAX_CALL_BYTES));
        if (!result.success) throw new BotIntegrationError("unavailable");
        return { data: result.data.data, ...(result.data.summary !== undefined ? { summary: result.data.summary } : {}) };
      }, signal);
    },
  };
}

export type BotIntegrationClient = ReturnType<typeof createBotIntegrationClient>;

/** The platform's internal integrations route, as the owner, with the machine token. */
export function createPlatformIntegrationTransport(options: { baseUrl: string; machineToken: string; fetchImpl?: typeof fetch }): BotIntegrationTransport {
  const base = options.baseUrl.replace(/\/$/, "");
  return (ownerId, request) => {
    const headers = new Headers({
      authorization: `Bearer ${options.machineToken}`,
      ...delegatedIntegrationHeaders(ownerId, options.machineToken),
    });
    if (request.body) headers.set("content-type", "application/json");
    if (request.readScope) headers.set(INTEGRATION_READ_SCOPE_HEADER, "read");
    return (options.fetchImpl ?? fetch)(`${base}${request.path === "/" ? "" : request.path}`, {
      method: request.method,
      headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      redirect: "error",
      signal: request.signal,
    });
  };
}

/** The gateway's own integration routes, called in process for the owner. */
export function createLocalIntegrationTransport(routes: Pick<Hono, "request">): BotIntegrationTransport {
  return (ownerId, request) => {
    const headers = new Headers({ "x-platform-user-id": ownerId });
    if (request.body) headers.set("content-type", "application/json");
    if (request.readScope) headers.set(INTEGRATION_READ_SCOPE_HEADER, "read");
    return Promise.resolve(routes.request(request.path, {
      method: request.method,
      headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: request.signal,
    }));
  };
}
