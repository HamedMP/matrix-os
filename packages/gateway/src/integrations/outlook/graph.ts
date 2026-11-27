import { withinIntegrationDeadline } from "../bounded-proxy-transport.js";
import { validateActionParams } from "../parameter-validation.js";
import { getAction } from "../registry.js";
import { GRAPH_ORIGIN, OutlookError, requestOutlookJson } from "./http.js";
import type { OutlookLifecycle } from "./lifecycle.js";
import { isOutlookService } from "./oauth.js";

export type OutlookGraph = ReturnType<typeof createOutlookGraph>;

export function createOutlookGraph(options: { lifecycle: Pick<OutlookLifecycle, "accessToken">; fetcher?: typeof fetch }) {
  const fetcher = options.fetcher ?? fetch;
  return async (input: {
    userId: string;
    connectionId: string;
    service: string;
    action: string;
    params?: Record<string, unknown>;
    signal?: AbortSignal;
  }) => {
    const { userId, connectionId, service, action } = input;
    if (!isOutlookService(service)) throw new OutlookError("unavailable");
    const params = input.params ?? {};
    const definition = getAction(service, action);
    const api = definition?.directApi;
    if (!definition || !api || !validateActionParams(definition, params).valid) throw new OutlookError("unavailable");
    const target = new URL(typeof api.url === "function" ? api.url(params) : api.url);
    if (target.origin !== GRAPH_ORIGIN || !target.pathname.startsWith("/v1.0/me/")
      || (api.method !== "GET" && api.method !== "POST")) throw new OutlookError("unavailable");

    for (const [key, value] of Object.entries(api.mapParams?.(params) ?? {})) target.searchParams.set(key, value);
    const body = api.mapBody ? JSON.stringify(api.mapBody(params)) : undefined;
    const timeout = AbortSignal.timeout(10_000);
    const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
    const request = async (forceRefresh: boolean): Promise<unknown> => {
      // The service guard above also narrows the registry action and selected grant.
      const accessToken = await withinIntegrationDeadline(
        () => options.lifecycle.accessToken(userId, service, connectionId, { forceRefresh, signal }), signal,
      );
      return requestOutlookJson({
        url: target.href, signal, fetcher, maxBytes: 1024 * 1024,
        request: {
          method: api.method,
          headers: {
            Authorization: `Bearer ${accessToken}`, Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body } : {}),
        },
      });
    };

    try {
      return await request(false);
    } catch (error: unknown) {
      if (!(error instanceof OutlookError) || error.code !== "consent_required" || api.method !== "GET") throw error;
      return request(true);
    }
  };
}
