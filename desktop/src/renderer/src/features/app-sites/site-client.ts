import { createSiteClient, SiteClientError, type SiteTransport } from "../../../../../../shell/src/lib/site-client";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";

async function normalize<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error: unknown) {
    if (error instanceof AppError) {
      if (error.status !== undefined) throw new SiteClientError(error.status);
      if (error.category === "notFound") throw new SiteClientError(404);
    }
    throw error;
  }
}

export function createDesktopSiteClient(api: ApiClient, runtimeSlot: string) {
  const bound = api.forRuntime(runtimeSlot);
  const transport: SiteTransport = {
    get: <T>(path: string, options?: { signal: AbortSignal; timeoutMs?: number }) => normalize(() => bound.get<T>(path, options)),
    post: <T>(path: string, value: unknown, options?: { signal: AbortSignal; timeoutMs?: number }) => normalize(() => bound.post<T>(path, value, options)),
    patch: <T>(path: string, value: unknown, options?: { signal: AbortSignal; timeoutMs?: number }) => normalize(() => bound.patch<T>(path, value, options)),
    delete: <T>(path: string, value?: unknown, options?: { signal: AbortSignal; timeoutMs?: number }) => normalize(() => bound.delete<T>(path, value, options)),
    getBlob: (path, options) => normalize(() => bound.getBlob(path, options)),
    getText: (path, options) => normalize(() => bound.getText(path, options)),
  };
  return createSiteClient(transport);
}
