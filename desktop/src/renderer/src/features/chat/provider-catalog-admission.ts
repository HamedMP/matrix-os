import { CanonicalChatModelSelectionSchema } from "@matrix-os/contracts";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient, JsonRequestOptions } from "../../lib/api";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";

const AVAILABILITY_ERRORS = ["provider_unavailable", "model_unavailable", "credit_required", "insufficient_credit", "credit_reserved", "budget_exceeded", "authorization_failed"];

/** Observes live admission failures; cached display never authorizes a send. */
export async function postWithProviderCatalogRecovery<T>(
  api: Pick<ApiClient, "post">, path: string, body: unknown, options?: JsonRequestOptions,
): Promise<T> {
  const identityKey = desktopProviderIdentityKey(useConnection.getState());
  try {
    return await (options === undefined ? api.post<T>(path, body) : api.post<T>(path, body, options));
  } catch (error: unknown) {
    if (/^\/api\/chats\/[^/]+\/(?:turns|queued-turns|runs)(?:[/?]|$)/.test(path)
      && error instanceof AppError && (error.category === "unauthorized"
        || error.detail && AVAILABILITY_ERRORS.includes(error.detail))) {
      const selection = CanonicalChatModelSelectionSchema.safeParse(
        body && typeof body === "object" ? Reflect.get(body, "selection") : undefined,
      );
      useConnection.getState().invalidateProviderCatalog(identityKey, error.category !== "unauthorized" && selection.success ? [selection.data.instanceId] : null);
    }
    throw error;
  }
}
