import { z } from "zod/v4";
import { MessagingBridgeHttpError } from "./errors.js";

/**
 * HTTP client for the shared bridge host. Every request carries the gate
 * header the host's reverse proxy requires on admin and provisioning paths,
 * a hard timeout, and `redirect: "error"`. Response bodies are bounded and
 * parsed as JSON; nothing here logs bodies, URLs or credentials.
 */
export const MESSAGING_BRIDGE_GATE_HEADER = "x-matrix-bridge-gate";
export const BRIDGE_REQUEST_TIMEOUT_MS = 10_000;
export const BRIDGE_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface BridgeHostResponse {
  status: number;
  /** Parsed JSON, or `undefined` for an empty or non-JSON body. */
  body: unknown;
}

export interface BridgeHostRequest {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | undefined>;
  bearer: string;
  body?: unknown;
  timeoutMs: number;
  /** Aborts early (caller disconnected or a shorter long-poll window). */
  signal?: AbortSignal;
}

/** The request never produced an HTTP response (network failure, timeout, abort). */
export class BridgeTransportError extends Error {
  readonly timedOut: boolean;
  constructor(timedOut: boolean, options?: { cause?: unknown }) {
    super(timedOut ? "bridge host request timed out" : "bridge host request failed", options);
    this.name = "BridgeTransportError";
    this.timedOut = timedOut;
  }
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new MessagingBridgeHttpError("bridge_unavailable", { stage: "response_too_large" });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createBridgeHostClient(options: { hostUrl: string; gateSecret: string; fetchImpl: typeof fetch }) {
  return {
    async request(input: BridgeHostRequest): Promise<BridgeHostResponse> {
      const url = new URL(`${options.hostUrl}${input.path}`);
      for (const [key, value] of Object.entries(input.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
      const timeout = AbortSignal.timeout(input.timeoutMs);
      const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
      const headers: Record<string, string> = {
        authorization: `Bearer ${input.bearer}`,
        [MESSAGING_BRIDGE_GATE_HEADER]: options.gateSecret,
        accept: "application/json",
      };
      if (input.body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await options.fetchImpl(url, {
          method: input.method,
          headers,
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
          signal,
          redirect: "error",
        });
      } catch (error: unknown) {
        if (isAbortLike(error) || signal.aborted) throw new BridgeTransportError(timeout.aborted, { cause: error });
        if (error instanceof TypeError || error instanceof Error) throw new BridgeTransportError(false, { cause: error });
        throw error;
      }
      let text: string;
      try {
        text = await readBounded(response);
      } catch (error: unknown) {
        if (error instanceof MessagingBridgeHttpError) throw error;
        if (isAbortLike(error) || signal.aborted) throw new BridgeTransportError(timeout.aborted, { cause: error });
        throw new BridgeTransportError(false, { cause: error });
      }
      let body: unknown;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError)) throw error;
          body = undefined;
        }
      }
      return { status: response.status, body };
    },
  };
}

export type BridgeHostClient = ReturnType<typeof createBridgeHostClient>;

/** Matrix-style error body (`{ errcode, error }`); only `errcode` is ever read. */
export function matrixErrcode(body: unknown): string | undefined {
  const parsed = z.object({ errcode: z.string().max(128).regex(/^[A-Za-z0-9._]+$/) }).safeParse(body);
  return parsed.success ? parsed.data.errcode : undefined;
}

const DeviceLoginResponseSchema = z.object({
  user_id: z.string().max(255),
  access_token: z.string().min(16).max(1_024),
  device_id: z.string().min(1).max(128),
});

/**
 * The homeserver calls behind `POST /session`: ensure the owner's user through
 * the admin API, then mint a token on a fixed device through an appservice
 * login. A stable device keeps Synapse's per-device transaction-id dedupe
 * working across token refreshes; the admin "login as user" API cannot bind a
 * device, so it is not used.
 */
export function createSynapseAdmin(client: BridgeHostClient, adminToken: string, appserviceToken: string) {
  function failure(stage: string, response: BridgeHostResponse): MessagingBridgeHttpError {
    const errcode = matrixErrcode(response.body);
    const detail = { stage, status: response.status, ...(errcode ? { errcode } : {}) };
    // A rejected admin/appservice token or a closed gate is operator misconfiguration, not a user problem.
    return new MessagingBridgeHttpError(response.status === 401 || response.status === 403 ? "misconfigured" : "bridge_unavailable", detail);
  }

  async function call(stage: string, request: Omit<BridgeHostRequest, "bearer" | "timeoutMs">, bearer: string): Promise<BridgeHostResponse> {
    try {
      return await client.request({ ...request, bearer, timeoutMs: BRIDGE_REQUEST_TIMEOUT_MS });
    } catch (error: unknown) {
      if (error instanceof BridgeTransportError) throw new MessagingBridgeHttpError("bridge_unavailable", { stage, transport: error.timedOut ? "timeout" : "failed" }, { cause: error });
      throw error;
    }
  }

  return {
    /** Create or update the user as a non-admin without a password (Synapse admin v2 PUT). */
    async ensureUser(userId: string): Promise<void> {
      const response = await call("ensure_user", { method: "PUT", path: `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`, body: { admin: false } }, adminToken);
      if (response.status !== 200 && response.status !== 201) throw failure("ensure_user", response);
    },

    /**
     * Mint an access token for the user on `deviceId` (`m.login.application_service`
     * through the owner-scoped double-puppet appservice). Logging in again on the
     * same device id reuses that device. The token is returned, never stored here.
     */
    async loginOnDevice(userId: string, deviceId: string): Promise<{ accessToken: string; deviceId: string }> {
      const response = await call("device_login", {
        method: "POST",
        path: "/_matrix/client/v3/login",
        body: {
          type: "m.login.application_service",
          identifier: { type: "m.id.user", user: userId },
          device_id: deviceId,
          initial_device_display_name: "Matrix OS",
        },
      }, appserviceToken);
      if (response.status !== 200) throw failure("device_login", response);
      const parsed = DeviceLoginResponseSchema.safeParse(response.body);
      if (!parsed.success || parsed.data.user_id !== userId || parsed.data.device_id !== deviceId) {
        throw new MessagingBridgeHttpError("bridge_unavailable", { stage: "device_login", shape: "invalid" });
      }
      return { accessToken: parsed.data.access_token, deviceId: parsed.data.device_id };
    },
  };
}
