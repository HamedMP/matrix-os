import { createSiteClient, SiteClientError, SITE_CLIENT_MAX_RESPONSE_BYTES, type SiteTransport } from "../../../../../../shell/src/lib/site-client";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";

async function normalize<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error: unknown) {
    console.warn("[desktop-sites] request failed", error instanceof Error ? "Error" : "UnknownError");
    const reason = error instanceof AppError ? error.cause : error;
    if (reason instanceof Error && reason.message === "file_too_large") throw new SiteClientError(413);
    if (error instanceof AppError) {
      const httpStatus = error.httpStatus;
      if (typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) {
        throw new SiteClientError(httpStatus);
      }
      if (error.category === "notFound") throw new SiteClientError(404);
    }
    throw error;
  }
}

export function createDesktopSiteClient(api: ApiClient, runtimeSlot: string) {
  const bound = api.forRuntime(runtimeSlot);
  const bounds = (options?: { signal: AbortSignal; timeoutMs?: number }) => ({
    ...options, maxBytes: SITE_CLIENT_MAX_RESPONSE_BYTES, omitErrorBody: true,
  });
  const transport: SiteTransport = {
    get: <T>(path: string, options?: { signal: AbortSignal; timeoutMs?: number }) => normalize(() => bound.get<T>(path, bounds(options))),
    post: <T>(path: string, value: unknown, options?: { signal: AbortSignal; timeoutMs?: number }) => normalize(() => bound.post<T>(path, value, bounds(options))),
    patch: <T>(path: string, value: unknown, options?: { signal: AbortSignal; timeoutMs?: number }) => normalize(() => bound.patch<T>(path, value, bounds(options))),
    delete: <T>(path: string, value?: unknown, options?: { signal: AbortSignal; timeoutMs?: number }) => normalize(() => bound.delete<T>(path, value, bounds(options))),
    getBlob: (path, options) => normalize(() => bound.getBlob(path, bounds(options))),
    getText: (path, options) => normalize(() => bound.getText(path, bounds(options))),
  };
  return createSiteClient(transport);
}
