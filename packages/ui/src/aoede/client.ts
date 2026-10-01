import { z } from "zod/v4";
import {
  CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatDetailResponseSchema,
  CanonicalCancelChatRunRequestSchema, CanonicalChatRunCancellationResponseSchema,
  CanonicalSubmitChatApprovalRequestSchema, CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalSubmitChatInputRequestSchema, CanonicalChatInputSubmissionResponseSchema,
  CanonicalActionIdSchema, CanonicalChatActionCancellationResponseSchema,
  CanonicalProviderCatalogSchema, CanonicalChatRecordSchema,
  CanonicalUpdateChatSelectionRequestSchema,
  chatMessageVersionUrl, chatReadStateVersionUrl,
  AoedeBootstrapRequestSchema, AoedeBootstrapResponseSchema,
  type CanonicalChatDetailResponse, type CanonicalSubmitChatApprovalRequest,
  type CanonicalSubmitChatInputRequest, type CanonicalCancelChatRunRequest,
  type AoedeBootstrapRequest, type AoedeBootstrapResponse,
  type CanonicalProviderCatalog, type CanonicalChatRecord,
  type CanonicalUpdateChatSelectionRequest, type CanonicalChatActionCancellationResponse,
} from "@matrix-os/contracts";
import { createCanonicalChatEventSource as createSharedCanonicalChatEventSource, type CanonicalChatEventSource } from "../canonical-chat-event-source.js";
import { boundedJson } from "../voice-session/session-api.js";
import { SafeVoiceErrorSchema, type SafeVoiceError } from "@matrix-os/contracts/voice-session";

export class AoedeRequestError extends Error {
  constructor(public readonly status: number, public readonly safeError?: SafeVoiceError) { super("Assistant request unavailable"); this.name = "AoedeRequestError"; }
}
export interface AoedeApi {
  bootstrap(input: AoedeBootstrapRequest): Promise<AoedeBootstrapResponse>;
  detail(chatId: string): Promise<CanonicalChatDetailResponse>;
  events(): CanonicalChatEventSource;
  providers(): Promise<CanonicalProviderCatalog>;
  updateSelection(chatId: string, input: CanonicalUpdateChatSelectionRequest): Promise<CanonicalChatRecord>;
  cancelRun(chatId: string, runId: string, input: CanonicalCancelChatRunRequest): Promise<unknown>;
  cancelAction(chatId: string, actionId: string): Promise<CanonicalChatActionCancellationResponse>;
  submitApproval(chatId: string, runId: string, approvalId: string, input: CanonicalSubmitChatApprovalRequest): Promise<unknown>;
  submitInput(chatId: string, runId: string, requestId: string, input: CanonicalSubmitChatInputRequest): Promise<unknown>;
}
const ReferenceSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export function createAoedeApi(options: { baseUrl: string; fetcher?: typeof fetch }): AoedeApi {
  // Capture the target and fetch implementation; old cleanup cannot follow a new runtime.
  const base = options.baseUrl.replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;
  // Catalog discovery and speech readiness can each consume their own bounded
  // server probe. Allow cold startup to finish before the browser aborts it.
  const request = async (path: string, body?: unknown, method = "POST", timeoutMs = 10_000): Promise<unknown> => {
    const response = await fetcher(`${base}${path}`, {
      method: body === undefined ? "GET" : method,
      headers: { "X-Matrix-Chat-Metadata": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      let safeError: SafeVoiceError | undefined;
      try {
        const payload = await boundedJson(response);
        const parsed = z.strictObject({ error: SafeVoiceErrorSchema }).safeParse(payload);
        if (parsed.success) safeError = parsed.data.error;
      } catch (error: unknown) {
        console.warn("[aoede] error response unavailable", error instanceof Error ? error.name : "UnknownError");
      }
      throw new AoedeRequestError(response.status, safeError);
    }
    return boundedJson(response);
  };
  const chatPath = (chatId: string) => `/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(chatId))}`;
  const runPath = (chatId: string, runId: string) => `${chatPath(chatId)}/runs/${encodeURIComponent(CanonicalChatRunIdSchema.parse(runId))}`;
  const actionPath = (chatId: string, actionId: string) => `${chatPath(chatId)}/actions/${encodeURIComponent(CanonicalActionIdSchema.parse(actionId))}`;
  return {
    async bootstrap(input) { return AoedeBootstrapResponseSchema.parse(await request("/api/aoede/bootstrap", AoedeBootstrapRequestSchema.parse(input), "POST", 30_000)); },
    async detail(chatId) { return CanonicalChatDetailResponseSchema.parse(await request(chatReadStateVersionUrl(chatMessageVersionUrl(`${chatPath(chatId)}?limit=200`)))); },
    events() {
      return createSharedCanonicalChatEventSource({ openStream: ({ cursor, signal }) => fetcher(
        `${base}${chatReadStateVersionUrl(chatMessageVersionUrl("/api/chats/events"))}`,
        { headers: { Accept: "text/event-stream", "X-Matrix-Chat-Protocol": "2", "X-Matrix-Chat-Metadata": "1", ...(cursor === undefined ? {} : { "Last-Event-ID": String(cursor) }) },
          signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60 * 1000)]) },
      ) });
    },
    async providers() { return CanonicalProviderCatalogSchema.parse(await request("/api/chat-providers", undefined, "GET", 30_000)); },
    async updateSelection(chatId, input) {
      return CanonicalChatRecordSchema.parse(await request(
        `${chatPath(chatId)}/selection`,
        CanonicalUpdateChatSelectionRequestSchema.parse(input),
        "PATCH",
        30_000,
      ));
    },
    async cancelRun(chatId, runId, input) { return CanonicalChatRunCancellationResponseSchema.parse(await request(`${runPath(chatId, runId)}/cancel`, CanonicalCancelChatRunRequestSchema.parse(input))); },
    async cancelAction(chatId, actionId) {
      return CanonicalChatActionCancellationResponseSchema.parse(await request(`${actionPath(chatId, actionId)}/cancel`, {}));
    },
    async submitApproval(chatId, runId, approvalId, input) { return CanonicalChatApprovalSubmissionResponseSchema.parse(await request(`${runPath(chatId, runId)}/approvals/${encodeURIComponent(ReferenceSchema.parse(approvalId))}`, CanonicalSubmitChatApprovalRequestSchema.parse(input))); },
    async submitInput(chatId, runId, requestId, input) { return CanonicalChatInputSubmissionResponseSchema.parse(await request(`${runPath(chatId, runId)}/inputs/${encodeURIComponent(ReferenceSchema.parse(requestId))}`, CanonicalSubmitChatInputRequestSchema.parse(input))); },
  };
}
