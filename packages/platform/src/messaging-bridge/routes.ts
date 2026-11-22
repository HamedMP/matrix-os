import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  MESSAGING_BRIDGE_FIELD_VALUE_MAX,
  MESSAGING_BRIDGE_PLATFORM_BASE_PATH,
  MESSAGING_BRIDGE_STEP_WAIT_MS,
  MessagingBridgeLoginCancelRequestSchema,
  MessagingBridgeLoginFlowsResponseSchema,
  MessagingBridgeLoginProgressSchema,
  MessagingBridgeLoginStartRequestSchema,
  MessagingBridgeLoginStepRequestSchema,
  MessagingBridgeLoginsResponseSchema,
  MessagingBridgeLogoutRequestSchema,
  MessagingBridgeNetworkSchema,
  MessagingBridgeSessionSchema,
  type MessagingBridgeLoginStep,
  type MessagingBridgeNetwork,
} from "@matrix-os/contracts/messaging-bridge";
import { HANDLE_PATTERN } from "../platform-route-utils.js";
import { configuredNetworks, type MessagingBridgeConfig, type MessagingBridgeHostConfig } from "./config.js";
import { MessagingBridgeHttpError, describeForLog, mapErrorToResponse, respondWithError, type MessagingBridgeLogger } from "./errors.js";
import { createBridgeHostClient, createSynapseAdmin } from "./host-client.js";
import { deriveMatrixUserId, type MessagingBridgeIdentityStore } from "./identity.js";
import { startLoginSweeper, type AbandonedLogin, type MessagingBridgeLoginStore } from "./login-store.js";
import { DIALOG_LOGIN_FLOWS, createProvisioningAdapter } from "./provisioning-adapter.js";
import type { NormalizedStep, PendingNativeStep } from "./step-normalizer.js";

/**
 * `/internal/messaging-bridge/*` (spec 2701): the owner's VPS gateway asks the
 * platform for its shared-homeserver session and drives bridge login flows.
 * Auth is the gateway's machine credential (`x-matrix-handle` plus the
 * handle-derived bearer); the owner always comes from that credential. The
 * platform never relays message content.
 */
/**
 * Every session for an owner is minted on this one device (device ids are
 * per user), so the gateway's send transaction ids stay deduplicated across
 * token refreshes.
 */
export const MESSAGING_BRIDGE_SESSION_DEVICE_ID = "MATRIXOS_GATEWAY";
/**
 * A step body holds at most 12 fields: each a value of up to the contract
 * maximum, an id of up to 128 characters and JSON punctuation, plus the
 * process and step ids. Values that need JSON escaping or multi-byte UTF-8
 * near the maximum do not fit; nothing larger than the contract is accepted.
 */
const STEP_BODY_LIMIT_BYTES = 12 * (MESSAGING_BRIDGE_FIELD_VALUE_MAX + 128 + 6) + 512;
const SMALL_BODY_LIMIT_BYTES = 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;

type Env = { Variables: { messagingBridgeOwner: string } };

export interface MessagingBridgeRouteDeps {
  config: MessagingBridgeConfig;
  /** Verifies the machine bearer for a handle and returns the owner's Clerk id. */
  authenticateMachine(input: { handle: string; token: string }): Promise<string | null>;
  /** Absent when the bridge host is unconfigured or its tables could not be bootstrapped. */
  identities?: MessagingBridgeIdentityStore;
  /** Pending logins shared by every platform instance; present whenever `identities` is. */
  logins?: MessagingBridgeLoginStore;
  fetchImpl: typeof fetch;
  log: MessagingBridgeLogger;
  now?: () => number;
  stepWaitMs?: number;
}

const ProgressInput = (loginProcessId: string, step: MessagingBridgeLoginStep) => MessagingBridgeLoginProgressSchema.parse({ loginProcessId, step });

export function createMessagingBridgeRoutes(deps: MessagingBridgeRouteDeps): { routes: Hono<Env>; shutdown(): void } {
  const now = deps.now ?? Date.now;
  const { log } = deps;
  const host = deps.config.host;
  const client = host ? createBridgeHostClient({ hostUrl: host.hostUrl, gateSecret: host.gateSecret, fetchImpl: deps.fetchImpl }) : undefined;
  const synapse = host && client ? createSynapseAdmin(client, host.adminToken, host.appserviceToken) : undefined;
  const adapter = host && client
    ? createProvisioningAdapter({ client, stepWaitMs: deps.stepWaitMs ?? MESSAGING_BRIDGE_STEP_WAIT_MS, secretFor: network => host.provisioningSecrets[network]! })
    : undefined;
  const logins = deps.logins;
  // Expired or evicted flows are cancelled at the bridge best-effort; the bridge also times them out itself.
  function cancelAbandoned(abandoned: AbandonedLogin[]) {
    if (!adapter) return;
    for (const login of abandoned) {
      void adapter.cancelLogin(login.network, login.userId, login.processId).catch((error: unknown) => {
        log.warn("[messaging-bridge] abandoned login cancel failed", { network: login.network, ...describeForLog(error) });
      });
    }
  }
  const stopSweeper = logins
    ? startLoginSweeper(async () => {
      try {
        cancelAbandoned(await logins.sweep(now()));
      } catch (error: unknown) {
        log.warn("[messaging-bridge] login sweep failed", describeForLog(error));
      }
    })
    : () => undefined;

  const app = new Hono<Env>().basePath(MESSAGING_BRIDGE_PLATFORM_BASE_PATH);
  const tooLarge = (c: Context) => respondWithError(c, "invalid_request", 413);
  const stepLimit = bodyLimit({ maxSize: STEP_BODY_LIMIT_BYTES, onError: tooLarge });
  const smallLimit = bodyLimit({ maxSize: SMALL_BODY_LIMIT_BYTES, onError: tooLarge });

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const handle = c.req.header("x-matrix-handle");
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!handle || !HANDLE_PATTERN.test(handle) || !token || !TOKEN_PATTERN.test(token)) return respondWithError(c, "unauthorized");
    let ownerId: string | null;
    try {
      ownerId = await deps.authenticateMachine({ handle, token });
    } catch (error: unknown) {
      return mapErrorToResponse(c, error, log, "authenticate");
    }
    if (!ownerId) return respondWithError(c, "unauthorized");
    if (!deps.config.allowedHandles.has(handle)) return respondWithError(c, "not_enabled");
    if (!host || !deps.identities || !logins) return respondWithError(c, "misconfigured");
    c.set("messagingBridgeOwner", ownerId);
    await next();
  });

  /** Run a handler; typed errors map to fixed bodies, body-limit errors reach `bodyLimit`. */
  function guarded(stage: string, handler: (c: Context<Env>, host: MessagingBridgeHostConfig) => Promise<Response>) {
    return async (c: Context<Env>) => {
      try {
        return await handler(c, host!);
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "BodyLimitError") throw error;
        return mapErrorToResponse(c, error, log, stage);
      }
    };
  }

  async function readBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
    let text: string;
    try {
      text = await c.req.text();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      throw new MessagingBridgeHttpError("invalid_request", { stage: "read_body" }, { cause: error });
    }
    let value: unknown = {};
    if (text.trim()) {
      try {
        value = JSON.parse(text);
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new MessagingBridgeHttpError("invalid_request", { stage: "parse_body" });
      }
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new MessagingBridgeHttpError("invalid_request", { stage: "validate_body" });
    return parsed.data;
  }

  function networkParam(c: Context, hostConfig: MessagingBridgeHostConfig): MessagingBridgeNetwork {
    const parsed = MessagingBridgeNetworkSchema.safeParse(c.req.param("network"));
    if (!parsed.success) throw new MessagingBridgeHttpError("invalid_request", { stage: "network_param" });
    if (!hostConfig.provisioningSecrets[parsed.data]) throw new MessagingBridgeHttpError("misconfigured", { stage: "network_secret", network: parsed.data });
    return parsed.data;
  }

  async function ownerUserId(c: Context<Env>, hostConfig: MessagingBridgeHostConfig): Promise<string> {
    const ownerId = c.get("messagingBridgeOwner");
    return deps.identities!.ensure(ownerId, deriveMatrixUserId(hostConfig.userIdKey, ownerId, hostConfig.serverName));
  }

  /**
   * Stores a pending step (`revision` absent: a new process from start) or ends the flow.
   * A step that lost a race with a cancel, another step or expiry is refused, never recreated.
   */
  async function record(processId: string, ownerId: string, network: MessagingBridgeNetwork, userId: string, result: NormalizedStep, revision?: number): Promise<MessagingBridgeLoginStep> {
    if (result.kind === "pending") {
      const next = { ownerId, network, userId, pending: result.pending };
      if (revision === undefined) cancelAbandoned(await logins!.create(processId, next, now()));
      else if (!(await logins!.advance(processId, next, revision, now()))) {
        throw new MessagingBridgeHttpError("conflict", { stage: "login_step", network, write: "stale" });
      }
      return result.pending.step;
    }
    await logins!.delete(processId, ownerId, network);
    if (result.step.type === "failed") log.warn("[messaging-bridge] login flow ended", { network, reason: result.reason ?? result.step.reason });
    return result.step;
  }

  function checkFields(pending: PendingNativeStep, fields: Record<string, string> | undefined) {
    if (pending.nativeType === "display_and_wait") {
      if (fields !== undefined) throw new MessagingBridgeHttpError("invalid_request", { stage: "fields_on_wait_step" });
      return;
    }
    if (!fields) throw new MessagingBridgeHttpError("invalid_request", { stage: "missing_fields" });
    const declared = new Set(pending.fieldIds.map(field => field.id));
    const unknown = Object.keys(fields).some(key => !declared.has(key));
    const missing = pending.fieldIds.some(field => field.required && !fields[field.id]?.trim());
    const invalidChoice = pending.fieldIds.some(field => field.options && fields[field.id] !== undefined && !field.options.includes(fields[field.id]!));
    if (unknown || missing || invalidChoice) throw new MessagingBridgeHttpError("invalid_request", { stage: "field_mismatch" });
  }

  app.post("/session", smallLimit, guarded("session", async (c, hostConfig) => {
    const userId = await ownerUserId(c, hostConfig);
    await synapse!.ensureUser(userId);
    const { accessToken, deviceId } = await synapse!.loginOnDevice(userId, MESSAGING_BRIDGE_SESSION_DEVICE_ID);
    const session = MessagingBridgeSessionSchema.safeParse({
      homeserverUrl: hostConfig.hostUrl,
      userId,
      accessToken,
      deviceId,
      networks: configuredNetworks(hostConfig),
    });
    if (!session.success) throw new MessagingBridgeHttpError("bridge_unavailable", { stage: "session", shape: "invalid" });
    return c.json(session.data);
  }));

  app.get("/:network/login/flows", guarded("login_flows", async (c, hostConfig) => {
    const network = networkParam(c, hostConfig);
    const flows = await adapter!.listFlows(network, await ownerUserId(c, hostConfig));
    return c.json(MessagingBridgeLoginFlowsResponseSchema.parse({ flows }));
  }));

  app.post("/:network/login/start", smallLimit, guarded("login_start", async (c, hostConfig) => {
    const network = networkParam(c, hostConfig);
    const body = await readBody(c, MessagingBridgeLoginStartRequestSchema);
    if (body.flowId !== undefined && !DIALOG_LOGIN_FLOWS[network].includes(body.flowId)) {
      throw new MessagingBridgeHttpError("invalid_request", { stage: "login_start", network, flow: "not_offered" });
    }
    const ownerId = c.get("messagingBridgeOwner");
    if (!(await logins!.tryStart(ownerId, now()))) throw new MessagingBridgeHttpError("rate_limited", { stage: "login_start", network });
    const userId = await ownerUserId(c, hostConfig);
    const flowId = body.flowId ?? (await adapter!.listFlows(network, userId))[0]?.id;
    if (!flowId) throw new MessagingBridgeHttpError("bridge_unavailable", { stage: "login_start", network, flows: 0 });
    // max_logins is 1 per network: an existing login (e.g. after BAD_CREDENTIALS) is re-linked in place.
    const [existingLoginId] = await adapter!.listLoginIds(network, userId);
    const started = await adapter!.startLogin(network, userId, flowId, existingLoginId);
    return c.json(ProgressInput(started.processId, await record(started.processId, ownerId, network, userId, started.result)));
  }));

  app.post("/:network/login/step", stepLimit, guarded("login_step", async (c, hostConfig) => {
    const network = networkParam(c, hostConfig);
    const body = await readBody(c, MessagingBridgeLoginStepRequestSchema);
    const ownerId = c.get("messagingBridgeOwner");
    const { record: process, abandoned } = await logins!.get(body.loginProcessId, ownerId, network, now());
    if (abandoned) cancelAbandoned([abandoned]);
    if (!process) throw new MessagingBridgeHttpError("not_found", { stage: "login_step", network });
    if (process.pending.stepId !== body.stepId) throw new MessagingBridgeHttpError("conflict", { stage: "login_step", network });
    checkFields(process.pending, body.fields);
    const outcome = await adapter!.submitStep(network, process.userId, body.loginProcessId, process.pending, body.fields, c.req.raw.signal);
    if (outcome.kind === "still_waiting") {
      // Refresh the expiry only if nothing changed the login while this request waited.
      if (!(await logins!.advance(body.loginProcessId, process, process.revision, now()))) {
        throw new MessagingBridgeHttpError("conflict", { stage: "login_step", network, write: "stale" });
      }
      return c.json(ProgressInput(body.loginProcessId, process.pending.step));
    }
    return c.json(ProgressInput(body.loginProcessId, await record(body.loginProcessId, ownerId, network, process.userId, outcome.result, process.revision)));
  }));

  /**
   * Best-effort and idempotent: only the caller's own process is cancelled, on
   * whichever instance receives the request; anything else is already gone.
   */
  app.post("/:network/login/cancel", smallLimit, guarded("login_cancel", async (c, hostConfig) => {
    const network = networkParam(c, hostConfig);
    const body = await readBody(c, MessagingBridgeLoginCancelRequestSchema);
    const process = await logins!.delete(body.loginProcessId, c.get("messagingBridgeOwner"), network);
    if (process) {
      try {
        await adapter!.cancelLogin(network, process.userId, body.loginProcessId);
      } catch (error: unknown) {
        log.warn("[messaging-bridge] login cancel failed", { network, ...describeForLog(error) });
      }
    }
    return c.json({ ok: true as const });
  }));

  app.get("/:network/logins", guarded("logins", async (c, hostConfig) => {
    const network = networkParam(c, hostConfig);
    const logins = await adapter!.listLogins(network, await ownerUserId(c, hostConfig));
    return c.json(MessagingBridgeLoginsResponseSchema.parse({ logins }));
  }));

  app.post("/:network/logout", smallLimit, guarded("logout", async (c, hostConfig) => {
    const network = networkParam(c, hostConfig);
    const body = await readBody(c, MessagingBridgeLogoutRequestSchema);
    // "all" is a bridge wildcard that would log out every account at once.
    if (body.loginId === "all") throw new MessagingBridgeHttpError("invalid_request", { stage: "logout_all" });
    await adapter!.logout(network, await ownerUserId(c, hostConfig), body.loginId);
    return c.json({ ok: true as const });
  }));

  app.all("*", c => respondWithError(c, "not_found"));

  return {
    routes: app,
    /** Pending logins live in Postgres and survive this instance; only the sweeper stops. */
    shutdown() {
      stopSweeper();
    },
  };
}
