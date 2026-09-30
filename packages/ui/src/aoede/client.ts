import { z } from "zod/v4";
import {
  CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatDetailResponseSchema,
  CanonicalCancelChatRunRequestSchema, CanonicalChatRunCancellationResponseSchema,
  CanonicalSubmitChatApprovalRequestSchema, CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalSubmitChatInputRequestSchema, CanonicalChatInputSubmissionResponseSchema,
  chatMessageVersionUrl, chatReadStateVersionUrl,
  AoedeBootstrapRequestSchema, AoedeBootstrapResponseSchema,
  type CanonicalChatDetailResponse, type CanonicalSubmitChatApprovalRequest,
  type CanonicalSubmitChatInputRequest, type CanonicalCancelChatRunRequest,
  type AoedeBootstrapRequest, type AoedeBootstrapResponse,
} from "@matrix-os/contracts";
import { createCanonicalChatEventSource as createSharedCanonicalChatEventSource, type CanonicalChatEventSource } from "../canonical-chat-event-source.js";

export class AoedeRequestError extends Error {
  constructor(public readonly status: number) { super("Assistant request unavailable"); this.name = "AoedeRequestError"; }
}
export interface AoedeApi {
  bootstrap(input: AoedeBootstrapRequest): Promise<AoedeBootstrapResponse>;
  detail(chatId: string): Promise<CanonicalChatDetailResponse>;
  events(): CanonicalChatEventSource;
  cancelRun(chatId: string, runId: string, input: CanonicalCancelChatRunRequest): Promise<unknown>;
  submitApproval(chatId: string, runId: string, approvalId: string, input: CanonicalSubmitChatApprovalRequest): Promise<unknown>;
  submitInput(chatId: string, runId: string, requestId: string, input: CanonicalSubmitChatInputRequest): Promise<unknown>;
}
const ReferenceSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export function createAoedeApi(options: { baseUrl: string; fetcher?: typeof fetch }): AoedeApi {
  // Capture the target and fetch implementation; old cleanup cannot follow a new runtime.
  const base = options.baseUrl.replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetcher(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-Matrix-Chat-Metadata": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new AoedeRequestError(response.status);
    return response.json();
  };
  const chatPath = (chatId: string) => `/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}`;
  const runPath = (chatId: string, runId: string) => `${chatPath(chatId)}/runs/${encodeURIComponent(CanonicalChatRunIdSchema.parse(runId))}`;
  return {
    async bootstrap(input) { return AoedeBootstrapResponseSchema.parse(await request("/api/aoede/bootstrap", AoedeBootstrapRequestSchema.parse(input))); },
    async detail(chatId) { return CanonicalChatDetailResponseSchema.parse(await request(chatReadStateVersionUrl(chatMessageVersionUrl(`${chatPath(chatId)}?limit=200`)))); },
    events() {
      return createSharedCanonicalChatEventSource({ openStream: ({ cursor, signal }) => fetcher(
        `${base}${chatReadStateVersionUrl(chatMessageVersionUrl("/api/chats/events"))}`,
        { headers: { Accept: "text/event-stream", "X-Matrix-Chat-Protocol": "2", "X-Matrix-Chat-Metadata": "1", ...(cursor === undefined ? {} : { "Last-Event-ID": String(cursor) }) },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      ) });
    },
    async cancelRun(chatId, runId, input) { return CanonicalChatRunCancellationResponseSchema.parse(await request(`${runPath(chatId, runId)}/cancel`, CanonicalCancelChatRunRequestSchema.parse(input))); },
    async submitApproval(chatId, runId, approvalId, input) { return CanonicalChatApprovalSubmissionResponseSchema.parse(await request(`${runPath(chatId, runId)}/approvals/${encodeURIComponent(ReferenceSchema.parse(approvalId))}`, CanonicalSubmitChatApprovalRequestSchema.parse(input))); },
    async submitInput(chatId, runId, requestId, input) { return CanonicalChatInputSubmissionResponseSchema.parse(await request(`${runPath(chatId, runId)}/inputs/${encodeURIComponent(ReferenceSchema.parse(requestId))}`, CanonicalSubmitChatInputRequestSchema.parse(input))); },
  };
}
