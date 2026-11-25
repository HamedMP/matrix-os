import { z } from "zod/v4";
import {
  MESSAGING_BRIDGE_PLATFORM_BASE_PATH,
  MessagingBridgeErrorSchema,
  MessagingBridgeLoginCancelRequestSchema,
  MessagingBridgeLoginFlowsResponseSchema,
  MessagingBridgeLoginProgressSchema,
  MessagingBridgeLoginStartRequestSchema,
  MessagingBridgeLoginStepRequestSchema,
  MessagingBridgeLoginsResponseSchema,
  MessagingBridgeLogoutRequestSchema,
  MessagingBridgeNetworkSchema,
  MessagingBridgeSessionSchema,
  type MessagingBridgeLoginFlow,
  type MessagingBridgeLoginProgress,
  type MessagingBridgeLogins,
  type MessagingBridgeNetwork,
  type MessagingBridgeSession,
} from "@matrix-os/contracts/messaging-bridge";
import { cancelBody, errorName, readBoundedJson } from "./bridge-http.js";

export const BRIDGE_PLATFORM_TIMEOUT_MS = 10_000;
export const BRIDGE_PLATFORM_LONG_POLL_TIMEOUT_MS = 35_000;
/** The bridge may take ~35 s to produce the first step; the platform asks for at least 40 s. */
export const BRIDGE_PLATFORM_LOGIN_START_TIMEOUT_MS = 40_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OkSchema = z.object({ ok: z.literal(true) }).strict();

export type BridgePlatformFailure =
  | "not_enabled"
  | "misconfigured"
  | "unauthorized"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "rate_limited"
  | "unavailable";

/** Fixed message: platform bodies and transport details never reach callers. */
export class BridgePlatformError extends Error {
  constructor(readonly code: BridgePlatformFailure) {
    super(`Messaging bridge platform request failed (${code})`);
    this.name = "BridgePlatformError";
  }
}

export interface MessagingBridgePlatformClient {
  createSession(): Promise<MessagingBridgeSession>;
  listLoginFlows(network: MessagingBridgeNetwork): Promise<MessagingBridgeLoginFlow[]>;
  startLogin(network: MessagingBridgeNetwork, body: { flowId?: string }): Promise<MessagingBridgeLoginProgress>;
  submitLoginStep(
    network: MessagingBridgeNetwork,
    body: { loginProcessId: string; stepId: string; fields?: Record<string, string> },
    options: { longPoll: boolean },
  ): Promise<MessagingBridgeLoginProgress>;
  cancelLogin(network: MessagingBridgeNetwork, body: { loginProcessId: string }): Promise<void>;
  listLogins(network: MessagingBridgeNetwork): Promise<MessagingBridgeLogins["logins"]>;
  logout(network: MessagingBridgeNetwork, body: { loginId: string }): Promise<void>;
}

const PLATFORM_CODE_MAP: Record<z.infer<typeof MessagingBridgeErrorSchema>["error"]["code"], BridgePlatformFailure> = {
  unauthorized: "unauthorized",
  forbidden: "unauthorized",
  not_enabled: "not_enabled",
  not_found: "not_found",
  invalid_request: "invalid_request",
  conflict: "conflict",
  rate_limited: "rate_limited",
  bridge_unavailable: "unavailable",
  misconfigured: "misconfigured",
  internal: "unavailable",
};

export function createMessagingBridgePlatformClient(options: {
  platformUrl: string;
  machineToken: string;
  handle: string;
  fetchImpl?: typeof fetch;
}): MessagingBridgePlatformClient {
  const base = new URL(options.platformUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || !options.machineToken || !HANDLE.test(options.handle)) {
    throw new Error("Messaging bridge platform client unavailable");
  }
  const origin = base.origin;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    timeoutMs = BRIDGE_PLATFORM_TIMEOUT_MS,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${origin}${MESSAGING_BRIDGE_PLATFORM_BASE_PATH}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${options.machineToken}`,
          "x-matrix-handle": options.handle,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch (err: unknown) {
      console.warn("[messages/bridge-platform] request failed", errorName(err));
      throw new BridgePlatformError("unavailable");
    }
    let payload: unknown;
    try {
      payload = await readBoundedJson(response, RESPONSE_LIMIT_BYTES);
    } catch (err: unknown) {
      await cancelBody(response);
      console.warn("[messages/bridge-platform] unreadable response", response.status, errorName(err));
      throw new BridgePlatformError("unavailable");
    }
    if (!response.ok) {
      const parsedError = MessagingBridgeErrorSchema.safeParse(payload);
      const code = parsedError.success ? PLATFORM_CODE_MAP[parsedError.data.error.code] : "unavailable";
      console.warn("[messages/bridge-platform] request rejected", response.status, code);
      throw new BridgePlatformError(code);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      console.warn("[messages/bridge-platform] response failed contract validation", path.split("/").slice(0, 3).join("/"));
      throw new BridgePlatformError("unavailable");
    }
    return parsed.data;
  }

  function networkPath(network: MessagingBridgeNetwork): string {
    const parsed = MessagingBridgeNetworkSchema.safeParse(network);
    if (!parsed.success) throw new BridgePlatformError("invalid_request");
    return `/${parsed.data}`;
  }

  return {
    createSession: () => call("POST", "/session", MessagingBridgeSessionSchema),
    async listLoginFlows(network) {
      const path = networkPath(network);
      return (await call("GET", `${path}/login/flows`, MessagingBridgeLoginFlowsResponseSchema)).flows;
    },
    async startLogin(network, body) {
      const path = networkPath(network);
      // The bridge connects to the network before returning the first step (e.g. the first QR code).
      return call(
        "POST",
        `${path}/login/start`,
        MessagingBridgeLoginProgressSchema,
        MessagingBridgeLoginStartRequestSchema.parse(body),
        BRIDGE_PLATFORM_LOGIN_START_TIMEOUT_MS,
      );
    },
    async submitLoginStep(network, body, stepOptions) {
      const path = networkPath(network);
      return call(
        "POST",
        `${path}/login/step`,
        MessagingBridgeLoginProgressSchema,
        MessagingBridgeLoginStepRequestSchema.parse(body),
        stepOptions.longPoll ? BRIDGE_PLATFORM_LONG_POLL_TIMEOUT_MS : BRIDGE_PLATFORM_TIMEOUT_MS,
      );
    },
    async cancelLogin(network, body) {
      const path = networkPath(network);
      await call("POST", `${path}/login/cancel`, OkSchema, MessagingBridgeLoginCancelRequestSchema.parse(body));
    },
    async listLogins(network) {
      const path = networkPath(network);
      return (await call("GET", `${path}/logins`, MessagingBridgeLoginsResponseSchema)).logins;
    },
    async logout(network, body) {
      const path = networkPath(network);
      await call("POST", `${path}/logout`, OkSchema, MessagingBridgeLogoutRequestSchema.parse(body));
    },
  };
}
