import { AiCreditHistoryQuerySchema, AiCreditHistoryResponseSchema, type AiCreditHistoryResponse } from "@matrix-os/contracts";
import { createProviderWorkflowClient, isProviderWorkflowAuthorizationUrl, ProviderWorkflowClientError, providerWorkflowTimeoutMs } from "@matrix-os/ui";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import { invoke } from "../../lib/operator";

const options = { maxBytes: 64 * 1024, timeoutMs: 15_000 };
function unavailable(): Error { return new Error("Provider action is unavailable."); }

export function createDesktopProviderWorkflowClient(api: ApiClient, isIdentityCurrent: () => boolean) {
  return createProviderWorkflowClient(async input => {
    if (!isIdentityCurrent() || input.signal.aborted) throw unavailable();
    const requestOptions = { ...options, timeoutMs: providerWorkflowTimeoutMs(input.method), signal: input.signal };
    let value: unknown;
    try {
      value = input.method === "GET" ? await api.get<unknown>(input.path, requestOptions)
        : input.method === "POST" ? await api.post<unknown>(input.path, input.body, requestOptions)
          : await api.delete<unknown>(input.path, input.body, requestOptions);
    } catch (error) {
      if (!isIdentityCurrent() || input.signal.aborted) throw unavailable();
      throw new ProviderWorkflowClientError(error instanceof AppError && error.detail === "forbidden" ? "forbidden"
        : error instanceof AppError && error.detail === "rejected" ? "rejected" : "unavailable");
    }
    if (!isIdentityCurrent() || input.signal.aborted) throw unavailable();
    return value;
  });
}

export async function loadDesktopAiCreditHistory(input: {
  api: ApiClient; runtimeSlot: string; cursor: string | null; signal: AbortSignal; isIdentityCurrent: () => boolean;
}): Promise<AiCreditHistoryResponse> {
  if (!input.isIdentityCurrent() || input.signal.aborted) throw unavailable();
  const query = AiCreditHistoryQuerySchema.safeParse({ runtimeSlot: input.runtimeSlot, limit: "20", ...(input.cursor === null ? {} : { cursor: input.cursor }) });
  if (!query.success) throw unavailable();
  const params = new URLSearchParams({ runtimeSlot: query.data.runtimeSlot, limit: "20" });
  if (query.data.cursor) params.set("cursor", query.data.cursor);
  // This is a platform endpoint. Its explicit runtimeSlot selects the ledger;
  // the gateway client's additional runtime routing query is not part of it.
  const value = await input.api.forRuntime("primary").get<unknown>(`/billing/ai-credit/history?${params}`, { ...options, signal: input.signal });
  if (!input.isIdentityCurrent() || input.signal.aborted) throw unavailable();
  const parsed = AiCreditHistoryResponseSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export async function openDesktopProviderWorkflowAuthorization(
  url: string, openExternal: (url: string) => Promise<unknown> = target => invoke("shell:open-external", { url: target }),
): Promise<boolean> {
  if (!isProviderWorkflowAuthorizationUrl(url)) return false;
  try { await openExternal(url); return true; }
  catch (error: unknown) {
    console.warn("[provider-workflow] Sign-in page unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  }
}
