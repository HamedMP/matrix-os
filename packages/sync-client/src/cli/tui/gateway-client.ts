import { codeFromErrorPayload, createTuiSafeError, normalizeTuiError, type TuiSafeError } from "./errors.js";

export interface TuiGatewayClientOptions {
  gatewayUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface TuiGatewayClientError extends TuiSafeError {}

export interface TuiGatewayClient {
  requestJson(path: string, init?: RequestInit): Promise<unknown>;
}

export function createTuiGatewayClient(options: TuiGatewayClientOptions): TuiGatewayClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.gatewayUrl.replace(/\/+$/, "");

  return {
    async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
      if (!path.startsWith("/")) {
        throw createTuiSafeError("invalid_request");
      }
      const headers = new Headers(init.headers);
      if (options.token) {
        headers.set("Authorization", `Bearer ${options.token}`);
      }
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      let response: Response;
      try {
        response = await fetchImpl(`${base}${path}`, {
          ...init,
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw normalizeTuiError(error);
      }

      let payload: unknown = {};
      try {
        payload = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw createTuiSafeError("invalid_response");
        }
        throw normalizeTuiError(error);
      }

      if (!response.ok) {
        throw createTuiSafeError(codeFromErrorPayload(payload));
      }
      return payload;
    },
  };
}
