import { AiCreditHistoryQuerySchema, AiCreditHistoryResponseSchema, type AiCreditHistoryResponse } from "@matrix-os/contracts";
import { createProviderWorkflowClient, isProviderWorkflowAuthorizationUrl, ProviderWorkflowClientError, providerWorkflowTimeoutMs } from "@matrix-os/ui";
import { getGatewayUrl } from "./gateway";
import { boundedProviderSettingsJson } from "./provider-settings-transport";

const TIMEOUT_MS = 15_000;
function unavailable(): Error { return new ProviderWorkflowClientError(); }

async function requestJson(input: {
  path: string; method: string; body?: unknown; signal: AbortSignal;
  fetcher: typeof fetch; isIdentityCurrent: () => boolean;
}): Promise<unknown> {
  if (input.signal.aborted || !input.isIdentityCurrent()) throw unavailable();
  const response = await input.fetcher(input.path, {
    method: input.method, cache: "no-store", credentials: "include",
    headers: { Accept: "application/json", ...(input.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(
      input.method === "GET" ? TIMEOUT_MS : providerWorkflowTimeoutMs("POST"),
    )]),
  });
  if (input.signal.aborted || !input.isIdentityCurrent()) {
    await response.body?.cancel();
    throw unavailable();
  }
  const value = await boundedProviderSettingsJson(response);
  if (input.signal.aborted || !input.isIdentityCurrent()) throw unavailable();
  if (!response.ok) {
    const code = value && typeof value === "object" && "error" in value
      && value.error && typeof value.error === "object" && "code" in value.error
      ? value.error.code : null;
    throw new ProviderWorkflowClientError(response.status === 400 && code === "rejected" ? "rejected" : "unavailable");
  }
  return value;
}

export function createWebProviderWorkflowClient(options: { fetcher?: typeof fetch; isIdentityCurrent?: () => boolean } = {}) {
  const gateway = getGatewayUrl();
  return createProviderWorkflowClient(input => requestJson({
    ...input, path: `${gateway}${input.path}`, fetcher: options.fetcher ?? fetch,
    isIdentityCurrent: () => getGatewayUrl() === gateway && options.isIdentityCurrent?.() !== false,
  }));
}

export async function loadWebAiCreditHistory(input: {
  runtimeSlot: string; cursor: string | null; signal: AbortSignal;
  fetcher?: typeof fetch; isIdentityCurrent?: () => boolean;
}): Promise<AiCreditHistoryResponse> {
  const parsed = AiCreditHistoryQuerySchema.safeParse({ runtimeSlot: input.runtimeSlot, limit: "20", ...(input.cursor === null ? {} : { cursor: input.cursor }) });
  if (!parsed.success) throw unavailable();
  const query = new URLSearchParams({ runtimeSlot: parsed.data.runtimeSlot, limit: "20" });
  if (parsed.data.cursor) query.set("cursor", parsed.data.cursor);
  const value = await requestJson({ path: `/billing/ai-credit/history?${query}`, method: "GET", signal: input.signal,
    fetcher: input.fetcher ?? fetch, isIdentityCurrent: () => input.isIdentityCurrent?.() !== false });
  const result = AiCreditHistoryResponseSchema.safeParse(value);
  if (!result.success) throw unavailable();
  return result.data;
}

export function openWebProviderWorkflowAuthorization(url: string): boolean {
  if (!isProviderWorkflowAuthorizationUrl(url)) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
