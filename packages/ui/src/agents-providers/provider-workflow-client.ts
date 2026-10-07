import { createBotConnectionClient } from "../chat-agents/bots/provider-connections-client.js";
import {
  ProviderWorkflowCapabilitiesSchema, ProviderWorkflowKeySchema, ProviderWorkflowLogsSchema,
  ProviderWorkflowSchema, ProviderWorkflowStartSchema, ProviderWorkflowCodeSchema,
  ProviderWorkflowCapabilitiesV2Schema, ProviderWorkflowStartV2Schema, ProviderWorkflowKeyV2Schema, ProviderWorkflowV2Schema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ProviderWorkflowClient } from "./types.js";

export interface ProviderWorkflowRequest {
  path: string;
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal: AbortSignal;
}

const reference = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const accepted = z.object({ accepted: z.literal(true) }).strict();
const verified = z.object({ verified: z.literal(true) }).strict();
const root = "/api/ai/provider-settings/workflows";

export function isProviderWorkflowAuthorizationUrl(value: unknown): value is string {
  return typeof value === "string" && ProviderWorkflowSchema.shape.authorizationUrl.safeParse(value).success;
}

export class ProviderWorkflowClientError extends Error {
  constructor(readonly reason: "rejected" | "forbidden" | "unauthorized" | "unsupported" | "unavailable" = "unavailable") {
    super("Provider action is unavailable.");
    this.name = "ProviderWorkflowClientError";
  }
}

/** Mutations include native process cleanup; reads remain short and bounded. */
export function providerWorkflowTimeoutMs(method: ProviderWorkflowRequest["method"]): number {
  return method === "GET" ? 15_000 : 90_000;
}

/** Shared validation; renderer adapters supply bounded, identity-bound transport. */
export function createProviderWorkflowClient(
  request: (input: ProviderWorkflowRequest) => Promise<unknown>,
): ProviderWorkflowClient {
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ProviderWorkflowClientError();
    return parsed.data;
  }
  async function send<T>(input: ProviderWorkflowRequest, schema: z.ZodType<T>): Promise<T> {
    if (input.signal.aborted) throw new ProviderWorkflowClientError();
    let value: unknown;
    try { value = await request(input); }
    catch (error: unknown) {
      console.warn("[provider-workflow] Request failed:", error instanceof Error ? error.name : typeof error);
      if (error instanceof ProviderWorkflowClientError) throw error;
      throw new ProviderWorkflowClientError();
    }
    if (input.signal.aborted) throw new ProviderWorkflowClientError();
    return parse(schema, value);
  }
  function path(id: string): string { return `${root}/${encodeURIComponent(parse(reference, id))}`; }
  const receipt = z.union([ProviderWorkflowV2Schema, ProviderWorkflowSchema]);
  // Discovery may negotiate down only when the versioned route is absent.
  // A denial, malformed response or network error is never a legacy grant.
  async function readWithFallback<T>(modernPath: string, legacyPath: string, signal: AbortSignal, modern: z.ZodType<T>, legacy: z.ZodType<T>): Promise<T> {
    try { return await send({path: modernPath, method: "GET", signal}, modern); }
    catch (error) {
      if (!(error instanceof ProviderWorkflowClientError) || error.reason !== "unsupported") throw error;
      return send({path: legacyPath, method: "GET", signal}, legacy);
    }
  }
  const modernOperations = new Set<string>();
  const remember = <T extends {id: string}>(value: T): T => {
    if (modernOperations.size >= 32) modernOperations.delete(modernOperations.values().next().value!);
    modernOperations.add(value.id);
    return value;
  };
  return {
    botConnections: createBotConnectionClient((path, method, body, signal = new AbortController().signal) => request({path, method, ...(body === undefined ? {} : {body}), signal})),
    capabilities: signal => readWithFallback(`${root}/v2/capabilities`, `${root}/capabilities?connectionVersion=2`, signal, ProviderWorkflowCapabilitiesV2Schema, ProviderWorkflowCapabilitiesSchema),
    startConnection: async (body, signal) => remember(await send({path: `${root}/v2/start`, method: "POST", body: parse(ProviderWorkflowStartV2Schema, body), signal}, ProviderWorkflowV2Schema)),
    submitConnectionKey: async (body, signal) => send({path: `${root}/v2/keys`, method: "POST", body: parse(ProviderWorkflowKeyV2Schema, body), signal}, verified),
    start: async (body, signal) => send({ path: root, method: "POST", body: parse(ProviderWorkflowStartSchema, body), signal }, ProviderWorkflowSchema),
    get: async (id, signal) => {
      const value = await readWithFallback(`${root}/v2/${encodeURIComponent(parse(reference, id))}`, path(id), signal, receipt, ProviderWorkflowSchema);
      if ("connectionOption" in value) remember(value);
      return value;
    },
    cancel: async (id, signal) => send({ path: `${modernOperations.has(id) ? `${root}/v2/${encodeURIComponent(parse(reference, id))}` : path(id)}/cancel`, method: "POST", body: {}, signal }, receipt),
    submitCode: async (id, code, signal) => send({ path: `${modernOperations.has(id) ? `${root}/v2/${encodeURIComponent(parse(reference, id))}` : path(id)}/code`, method: "POST", body: parse(ProviderWorkflowCodeSchema, { code }), signal }, accepted),
    submitKey: async (body, signal) => send({ path: `${root}/keys`, method: "POST", body: parse(ProviderWorkflowKeySchema, body), signal }, verified),
    logs: async (id, signal) => send({ path: `${root}/logs/${encodeURIComponent(parse(reference, id))}`, method: "GET", signal }, ProviderWorkflowLogsSchema),
  };
}
