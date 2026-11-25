import { z } from "zod/v4";
import type { MessagingBridgeLoginFlow, MessagingBridgeLogins, MessagingBridgeNetwork } from "@matrix-os/contracts/messaging-bridge";
import { MessagingBridgeHttpError } from "./errors.js";
import {
  BRIDGE_LONG_POLL_TIMEOUT_MS,
  BRIDGE_REQUEST_TIMEOUT_MS,
  BridgeTransportError,
  matrixErrcode,
  type BridgeHostClient,
  type BridgeHostResponse,
} from "./host-client.js";
import {
  NativeLoginStepSchema,
  normalizeLoginState,
  normalizeNativeStep,
  type NormalizedStep,
  type PendingNativeStep,
} from "./step-normalizer.js";

/**
 * mautrix bridgev2 provisioning API adapter (maunium.net/go/mautrix
 * bridgev2/matrix/provisioning.go). The bridge host exposes each bridge's
 * `/_matrix/provision/` tree under `/bridges/<network>/`. Requests authenticate
 * with the bridge's provisioning shared secret and act for `?user_id=`.
 * Every path and response shape the platform depends on lives here and in
 * `step-normalizer.ts`, so it can be corrected after the live spike.
 */
const provisionBase = (network: MessagingBridgeNetwork) => `/bridges/${network}/_matrix/provision/v3`;
const segment = (value: string) => encodeURIComponent(value);
const ID_PATTERN = /^[A-Za-z0-9._:=-]{1,128}$/;
const AUTH_ERRCODES = new Set(["M_UNKNOWN_TOKEN", "M_MISSING_TOKEN", "M_FORBIDDEN"]);
const EXPIRED_ERRCODES = new Set(["FI.MAU.BRIDGE.LOGIN_TIMED_OUT", "FI.MAU.BRIDGE.LOGIN_CANCELLED", "FI.MAU.BRIDGE.LOGIN_ALREADY_FINISHED", "M_NOT_FOUND"]);

/**
 * Flows an owner can finish in the link dialog. Telegram's `bot` (logs in as a
 * bot) and `manual` (raw session JSON) are never offered or startable.
 */
export const DIALOG_LOGIN_FLOWS: Record<MessagingBridgeNetwork, readonly string[]> = {
  whatsapp: ["qr", "phone"],
  telegram: ["phone", "qr"],
  linkedin: ["cookies"],
};

const LoginIdsSchema = z.object({ login_ids: z.array(z.string().max(256)).max(64).nullable() });

const FlowsSchema = z.object({
  flows: z.array(z.object({ id: z.string().max(256), name: z.string().max(4_096).optional(), description: z.string().max(16_384).optional() })).max(64).nullable(),
});
const WhoamiSchema = z.object({
  logins: z.array(z.object({
    id: z.string().max(256),
    name: z.string().max(4_096).optional(),
    state: z.object({ state_event: z.string().max(64).optional() }).optional(),
  })).max(64).nullable().optional(),
});

function clip(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function detail(stage: string, response: BridgeHostResponse, network: MessagingBridgeNetwork) {
  const errcode = matrixErrcode(response.body);
  return { stage, network, status: response.status, ...(errcode ? { errcode } : {}) };
}

/** A gate rejection (no Matrix errcode) or a rejected shared secret is operator misconfiguration. */
function isAuthFailure(response: BridgeHostResponse): boolean {
  if (response.status !== 401 && response.status !== 403) return false;
  const errcode = matrixErrcode(response.body);
  return errcode === undefined || AUTH_ERRCODES.has(errcode);
}

function requestFailure(stage: string, response: BridgeHostResponse, network: MessagingBridgeNetwork): MessagingBridgeHttpError {
  const errcode = matrixErrcode(response.body);
  const tags = detail(stage, response, network);
  if (errcode === "FI.MAU.BRIDGE.TOO_MANY_LOGINS") return new MessagingBridgeHttpError("conflict", tags);
  if (isAuthFailure(response)) return new MessagingBridgeHttpError("misconfigured", tags);
  if (errcode === "M_BAD_STATE") return new MessagingBridgeHttpError("conflict", tags);
  if (response.status === 404) return new MessagingBridgeHttpError("not_found", tags);
  if (response.status >= 400 && response.status < 500) return new MessagingBridgeHttpError("invalid_request", tags);
  return new MessagingBridgeHttpError("bridge_unavailable", tags);
}

/**
 * A failed step submission. bridgev2 deletes the login process whenever a step
 * returns an error, so most failures are terminal for the flow.
 */
function stepFailure(response: BridgeHostResponse, network: MessagingBridgeNetwork): NormalizedStep {
  const errcode = matrixErrcode(response.body);
  const tags = detail("login_step", response, network);
  if (errcode === "M_BAD_STATE") throw new MessagingBridgeHttpError("conflict", tags);
  if (isAuthFailure(response)) throw new MessagingBridgeHttpError("misconfigured", tags);
  const reason = response.status === 404 || response.status === 410 || (errcode !== undefined && EXPIRED_ERRCODES.has(errcode))
    ? "expired"
    : response.status >= 400 && response.status < 500
      ? "rejected"
      : errcode === undefined && response.status >= 502 && response.status <= 504
        ? "bridge_unavailable"
        : "unknown";
  return { kind: "terminal", step: { type: "failed", reason }, reason: `${tags.status}${errcode ? `:${errcode}` : ""}` };
}

function transportFailure(stage: string, network: MessagingBridgeNetwork, error: BridgeTransportError) {
  return new MessagingBridgeHttpError("bridge_unavailable", { stage, network, transport: error.timedOut ? "timeout" : "failed" }, { cause: error });
}

export type StepSubmitResult = { kind: "normalized"; result: NormalizedStep } | { kind: "still_waiting" };

export function createProvisioningAdapter(options: {
  client: BridgeHostClient;
  secretFor(network: MessagingBridgeNetwork): string;
  stepWaitMs: number;
}) {
  async function provision(network: MessagingBridgeNetwork, stage: string, userId: string, request: {
    method: "GET" | "POST"; path: string; query?: Record<string, string | undefined>; body?: unknown; timeoutMs?: number; signal?: AbortSignal;
  }): Promise<BridgeHostResponse> {
    return options.client.request({
      method: request.method,
      path: `${provisionBase(network)}${request.path}`,
      query: { user_id: userId, ...request.query },
      bearer: options.secretFor(network),
      ...(request.body !== undefined ? { body: request.body } : {}),
      timeoutMs: request.timeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS,
      ...(request.signal ? { signal: request.signal } : {}),
    }).catch((error: unknown) => {
      if (error instanceof BridgeTransportError) throw transportFailure(stage, network, error);
      throw error;
    });
  }

  function parseStep(network: MessagingBridgeNetwork, stage: string, body: unknown): { processId: string; result: NormalizedStep } {
    const native = NativeLoginStepSchema.safeParse(body);
    if (!native.success || !ID_PATTERN.test(native.data.login_id)) {
      throw new MessagingBridgeHttpError("bridge_unavailable", { stage, network, shape: "invalid_step" });
    }
    return { processId: native.data.login_id, result: normalizeNativeStep(native.data) };
  }

  return {
    async listFlows(network: MessagingBridgeNetwork, userId: string): Promise<MessagingBridgeLoginFlow[]> {
      const response = await provision(network, "login_flows", userId, { method: "GET", path: "/login/flows" });
      if (response.status !== 200) throw requestFailure("login_flows", response, network);
      const parsed = FlowsSchema.safeParse(response.body);
      if (!parsed.success) throw new MessagingBridgeHttpError("bridge_unavailable", { stage: "login_flows", network, shape: "invalid" });
      const offered = DIALOG_LOGIN_FLOWS[network];
      return (parsed.data.flows ?? []).filter(flow => ID_PATTERN.test(flow.id) && offered.includes(flow.id)).slice(0, 12).map(flow => {
        const description = clip(flow.description, 2_000);
        return { id: flow.id, name: clip(flow.name, 280) ?? flow.id, ...(description ? { description } : {}) };
      });
    },

    /**
     * The bridge cancels a login whose start request disconnects before the
     * first step, so this call gets the long timeout and no caller abort.
     */
    async startLogin(network: MessagingBridgeNetwork, userId: string, flowId: string, relinkLoginId?: string) {
      if (!DIALOG_LOGIN_FLOWS[network].includes(flowId)) throw new MessagingBridgeHttpError("invalid_request", { stage: "login_start", network, flow: "not_offered" });
      const response = await provision(network, "login_start", userId, {
        method: "POST", path: `/login/start/${segment(flowId)}`, timeoutMs: BRIDGE_LONG_POLL_TIMEOUT_MS,
        // Each owner may hold one login per network; re-linking in place avoids TOO_MANY_LOGINS.
        query: { login_id: relinkLoginId },
      });
      if (response.status !== 200) throw requestFailure("login_start", response, network);
      return parseStep(network, "login_start", response.body);
    },

    /**
     * Submit the current step. A `display_and_wait` step long-polls for at most
     * `stepWaitMs`; when that window elapses the bridge keeps waiting and the
     * caller is told the step is unchanged. Resubmitting with the same `txn_id`
     * re-attaches to the bridge's in-flight wait instead of starting another.
     */
    async submitStep(network: MessagingBridgeNetwork, userId: string, processId: string, pending: PendingNativeStep,
      fields: Record<string, string> | undefined, callerSignal?: AbortSignal): Promise<StepSubmitResult> {
      const waiting = pending.nativeType === "display_and_wait";
      const window = waiting ? AbortSignal.timeout(options.stepWaitMs) : undefined;
      const signal = window && callerSignal ? AbortSignal.any([window, callerSignal]) : window ?? callerSignal;
      let response: BridgeHostResponse;
      try {
        response = await options.client.request({
          method: "POST",
          path: `${provisionBase(network)}/login/step/${segment(processId)}/${segment(pending.stepId)}/${pending.nativeType}`,
          query: { user_id: userId, txn_id: pending.txnId },
          bearer: options.secretFor(network),
          ...(waiting ? {} : { body: fields ?? {} }),
          timeoutMs: waiting ? BRIDGE_LONG_POLL_TIMEOUT_MS : BRIDGE_REQUEST_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
      } catch (error: unknown) {
        if (!(error instanceof BridgeTransportError)) throw error;
        if (waiting && (window?.aborted || error.timedOut) && !callerSignal?.aborted) return { kind: "still_waiting" };
        throw transportFailure("login_step", network, error);
      }
      if (response.status !== 200) return { kind: "normalized", result: stepFailure(response, network) };
      const parsed = parseStep(network, "login_step", response.body);
      if (parsed.processId !== processId) throw new MessagingBridgeHttpError("bridge_unavailable", { stage: "login_step", network, shape: "process_mismatch" });
      return { kind: "normalized", result: parsed.result };
    },

    /** The owner's existing login ids on this network (`GET /v3/logins`). */
    async listLoginIds(network: MessagingBridgeNetwork, userId: string): Promise<string[]> {
      const response = await provision(network, "login_ids", userId, { method: "GET", path: "/logins" });
      if (response.status !== 200) throw requestFailure("login_ids", response, network);
      const parsed = LoginIdsSchema.safeParse(response.body);
      if (!parsed.success) throw new MessagingBridgeHttpError("bridge_unavailable", { stage: "login_ids", network, shape: "invalid" });
      return (parsed.data.login_ids ?? []).filter(id => ID_PATTERN.test(id));
    },

    /** `GET /v3/logins` returns ids only; `whoami` carries each login's name and bridge state. */
    async listLogins(network: MessagingBridgeNetwork, userId: string): Promise<MessagingBridgeLogins["logins"]> {
      const response = await provision(network, "logins", userId, { method: "GET", path: "/whoami" });
      if (response.status !== 200) throw requestFailure("logins", response, network);
      const parsed = WhoamiSchema.safeParse(response.body);
      if (!parsed.success) throw new MessagingBridgeHttpError("bridge_unavailable", { stage: "logins", network, shape: "invalid" });
      return (parsed.data.logins ?? []).filter(login => ID_PATTERN.test(login.id)).slice(0, 16).map(login => {
        const displayName = clip(login.name, 280);
        return { loginId: login.id, ...(displayName ? { displayName } : {}), state: normalizeLoginState(login.state?.state_event) };
      });
    },

    /** Best-effort cancel of an abandoned login process; a gone process (404) counts as cancelled. */
    async cancelLogin(network: MessagingBridgeNetwork, userId: string, processId: string): Promise<void> {
      const response = await provision(network, "login_cancel", userId, { method: "POST", path: `/login/cancel/${segment(processId)}` });
      if (response.status !== 200 && response.status !== 404) throw requestFailure("login_cancel", response, network);
    },

    async logout(network: MessagingBridgeNetwork, userId: string, loginId: string): Promise<void> {
      const response = await provision(network, "logout", userId, { method: "POST", path: `/logout/${segment(loginId)}` });
      if (response.status !== 200) throw requestFailure("logout", response, network);
    },
  };
}

export type ProvisioningAdapter = ReturnType<typeof createProvisioningAdapter>;
