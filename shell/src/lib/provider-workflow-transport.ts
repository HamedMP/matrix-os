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
  // Native browser fetch requires its global receiver, not the request object.
  const response = await input.fetcher.call(globalThis, input.path, {
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
    throw new ProviderWorkflowClientError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden"
      : response.status === 400 && code === "rejected" ? "rejected" : "unavailable");
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
  // noopener intentionally returns null even when opening succeeds. Create a
  // same-origin blank handle, sever its opener before navigation, and suppress
  // the outbound Referer without mistaking that null for popup blocking.
  let popup: Window | null = null;
  try {
    popup = window.open("about:blank", "_blank");
    if (!popup) return false;
    popup.opener = null;
    if (popup.opener !== null) throw new Error("Popup isolation unavailable");
    const policy = popup.document.createElement("meta");
    policy.name = "referrer";
    policy.content = "no-referrer";
    popup.document.head.append(policy);
    popup.location.replace(url);
    return true;
  } catch (error) {
    console.warn("[provider-settings] Authorization popup unavailable:", error instanceof Error ? error.name : typeof error);
    try { popup?.close(); } catch (closeError) {
      console.warn("[provider-settings] Popup cleanup unavailable:", closeError instanceof Error ? closeError.name : typeof closeError);
    }
    return false;
  }
}
