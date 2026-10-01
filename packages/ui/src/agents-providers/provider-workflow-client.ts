import {
  ProviderWorkflowCapabilitiesSchema, ProviderWorkflowKeySchema, ProviderWorkflowLogsSchema,
  ProviderWorkflowSchema, ProviderWorkflowStartSchema,
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
const verified = z.object({ verified: z.literal(true) }).strict();
const root = "/api/ai/provider-settings/workflows";

export function isProviderWorkflowAuthorizationUrl(value: unknown): value is string {
  return typeof value === "string" && ProviderWorkflowSchema.shape.authorizationUrl.safeParse(value).success;
}

export class ProviderWorkflowClientError extends Error {
  constructor(readonly reason: "rejected" | "unavailable" = "unavailable") {
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
  return {
    capabilities: signal => send({ path: `${root}/capabilities`, method: "GET", signal }, ProviderWorkflowCapabilitiesSchema),
    start: async (body, signal) => send({ path: root, method: "POST", body: parse(ProviderWorkflowStartSchema, body), signal }, ProviderWorkflowSchema),
    get: async (id, signal) => send({ path: path(id), method: "GET", signal }, ProviderWorkflowSchema),
    cancel: async (id, signal) => send({ path: `${path(id)}/cancel`, method: "POST", body: {}, signal }, ProviderWorkflowSchema),
    submitKey: async (body, signal) => send({ path: `${root}/keys`, method: "POST", body: parse(ProviderWorkflowKeySchema, body), signal }, verified),
    logs: async (id, signal) => send({ path: `${root}/logs/${encodeURIComponent(parse(reference, id))}`, method: "GET", signal }, ProviderWorkflowLogsSchema),
  };
}
