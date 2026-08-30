import {
  FundedAiAuthorizationRequestSchema,
  FundedAiOperatorGlobalPolicyResponseSchema,
  FundedAiOperatorGlobalPolicyUpdateRequestSchema,
  FundedAiOperatorRuntimePolicyResponseSchema,
  FundedAiOperatorRuntimePolicyUpdateRequestSchema,
  FundedAiPromotionalGrantResponseSchema,
  FundedAiFinalizationRequestSchema,
  FundedAiPolicyCheckRequestSchema,
  FundedAiSafeErrorSchema,
  FundedAiReleaseRequestSchema,
  FundedAiRuntimeFundingSummaryResponseSchema,
  FundedAiSettlementRequestSchema,
  FundedAiStartRequestSchema,
  IsoTimestampSchema,
  type FundedAiSafeError,
} from "@matrix-os/contracts";
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { RuntimeSlotSchema } from "./customer-vps-schema.js";
import { getRunningUserMachineByHandle, type PlatformDB } from "./db.js";
import { AiFundedPolicyError, type AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";
import { buildPlatformRuntimeVerificationToken, timingSafeTokenEquals } from "./platform-token.js";

const RUNTIME_BODY_LIMIT = 1024;
const RELAY_BODY_LIMIT = 4 * 1024;
const HandleSchema = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/);
const EmptyBodySchema = z.object({}).strict();
const RuntimeQuerySchema = z.object({ runtimeSlot: RuntimeSlotSchema }).strict();
const EmptyQuerySchema = z.object({}).strict();
const CleanupBodySchema = z.object({ limit: z.number().int().min(1).max(1_000) }).strict();
const PromotionCampaignSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/);
const PromotionAmountSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export type AiFundedPromotionalGrantConfig = { enabled: false } | {
  enabled: true;
  campaignId: string;
  amountMicrousd: number;
  expiresAt: string;
};

export type AiFundedControlPlaneConfig = { enabled: false } | {
  enabled: true;
  platformSecret: string;
  relayControlToken: string;
  credentialHashSecret: string;
  credentialTtlMs: number;
  issueCooldownMs: number;
  policyFreshnessMs: number;
  promotionalGrant: AiFundedPromotionalGrantConfig;
};

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("Funded AI control plane is misconfigured");
  }
  return value;
}

function loadPromotionalGrantConfig(env: NodeJS.ProcessEnv): AiFundedPromotionalGrantConfig {
  if (env.AI_FUNDED_PROMOTIONAL_GRANT_ENABLED !== "true") return { enabled: false };
  const campaignId = PromotionCampaignSchema.safeParse(env.AI_FUNDED_PROMOTIONAL_GRANT_CAMPAIGN_ID);
  const amountMicrousd = PromotionAmountSchema.safeParse(Number(env.AI_FUNDED_PROMOTIONAL_GRANT_MICROUSD));
  const expiresAt = IsoTimestampSchema.safeParse(env.AI_FUNDED_PROMOTIONAL_GRANT_EXPIRES_AT);
  if (!campaignId.success || !amountMicrousd.success || !expiresAt.success) {
    throw new Error("Funded AI promotional grant is misconfigured");
  }
  return {
    enabled: true,
    campaignId: campaignId.data,
    amountMicrousd: amountMicrousd.data,
    expiresAt: expiresAt.data,
  };
}

export function loadAiFundedControlPlaneConfig(env: NodeJS.ProcessEnv): AiFundedControlPlaneConfig {
  if (env.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED !== "true") return { enabled: false };
  const platformSecret = env.PLATFORM_SECRET ?? "";
  const relayControlToken = env.AI_RELAY_CONTROL_TOKEN ?? "";
  const credentialHashSecret = env.AI_FUNDED_CREDENTIAL_HASH_SECRET ?? "";
  const secrets = [platformSecret, relayControlToken, credentialHashSecret];
  if (secrets.some((secret) => secret.length < 32) || new Set(secrets).size !== secrets.length) {
    throw new Error("Funded AI control plane credentials are misconfigured");
  }
  return {
    enabled: true,
    platformSecret,
    relayControlToken,
    credentialHashSecret,
    credentialTtlMs: boundedInteger(env.AI_FUNDED_CREDENTIAL_TTL_MS, 15 * 60_000, 60_000, 60 * 60_000),
    issueCooldownMs: boundedInteger(env.AI_FUNDED_ISSUE_COOLDOWN_MS, 30_000, 1_000, 60 * 60_000),
    policyFreshnessMs: boundedInteger(env.AI_FUNDED_POLICY_FRESHNESS_MS, 60_000, 1_000, 5 * 60_000),
    promotionalGrant: loadPromotionalGrantConfig(env),
  };
}

function noStore(c: Context): void {
  c.header("Cache-Control", "no-store, private");
  c.header("CDN-Cache-Control", "no-store");
  c.header("Cloudflare-CDN-Cache-Control", "no-store");
}

async function authenticatedRuntimeMachine(
  c: Context,
  options: { db: PlatformDB; platformSecret: string },
  runtimeSlot: string,
): Promise<Awaited<ReturnType<typeof getRunningUserMachineByHandle>> | undefined> {
  const handle = HandleSchema.parse(c.req.param("handle"));
  const machine = await getRunningUserMachineByHandle(options.db, handle, runtimeSlot);
  if (!machine) return undefined;
  const authorization = c.req.header("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const expected = buildPlatformRuntimeVerificationToken({
    handle,
    machineId: machine.machineId,
    runtimeSlot: machine.runtimeSlot,
  }, options.platformSecret);
  return timingSafeTokenEquals(token, expected) ? machine : undefined;
}

function safeError(code: FundedAiSafeError["error"]["code"]): FundedAiSafeError {
  const message = {
    unauthorized: "Unauthorized",
    access_disabled: "Matrix-funded AI is unavailable",
    model_not_allowed: "This model is not available",
    rate_limited: "Try again later",
    revision_conflict: "Policy changed; refresh and try again",
    insufficient_credit: "Not enough Matrix AI credit",
    budget_exceeded: "Monthly AI budget reached",
    idempotency_conflict: "Request already used",
    reservation_expired: "AI usage reservation expired",
    over_settlement: "AI usage exceeds its reservation",
    reservation_closed: "AI usage reservation is already closed",
    invalid_request: "Invalid request",
    not_found: "Runtime not found",
    unavailable: "Service unavailable",
  }[code];
  return FundedAiSafeErrorSchema.parse({ error: { code, message } });
}

function policyErrorResponse(c: Context, error: unknown) {
  if (error instanceof AiFundedPolicyError) {
    if (error.code === "unauthorized") return c.json(safeError("unauthorized"), 401);
    if (error.code === "identity_mismatch") return c.json(safeError("not_found"), 404);
    if (error.code === "rate_limited") return c.json(safeError("rate_limited"), 429);
    if (error.code === "revision_conflict") return c.json(safeError("revision_conflict"), 409);
    if (error.code === "idempotency_conflict") return c.json(safeError("idempotency_conflict"), 409);
    if (error.code === "reservation_expired") return c.json(safeError("reservation_expired"), 409);
    if (error.code === "over_settlement") return c.json(safeError("over_settlement"), 409);
    if (error.code === "reservation_closed") return c.json(safeError("reservation_closed"), 409);
    if (error.code === "insufficient_credit") return c.json(safeError("insufficient_credit"), 402);
    if (error.code === "budget_exceeded") return c.json(safeError("budget_exceeded"), 403);
    if (error.code === "model_not_allowed") return c.json(safeError("model_not_allowed"), 403);
    return c.json(safeError("access_disabled"), 403);
  }
  const errorName = error instanceof Error ? error.name : typeof error;
  console.error(`[ai-funded-policy] request failed (${errorName})`);
  return c.json(safeError("unavailable"), 503);
}

async function readStrictJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    const category = error instanceof SyntaxError ? "syntax_error" : "unexpected_error";
    // Log only a coarse category. The request body may contain provider
    // credentials and must never be included in platform logs.
    console.warn(`[ai-funded-policy] invalid JSON body (${category})`);
    return Symbol.for("invalid-json");
  }
}

export function createAiFundedRuntimeRoutes(options: {
  db: PlatformDB;
  platformSecret: string;
  repository: AiFundedPolicyRepository;
  topUpEnabled?: boolean;
}) {
  if (!options.repository || !options.db) throw new Error("Funded AI runtime dependencies are missing");
  if (options.platformSecret.length < 32) throw new Error("Funded AI runtime authentication is misconfigured");
  const app = new Hono();
  app.use("*", async (c, next) => {
    noStore(c);
    const parsedHandle = HandleSchema.safeParse(c.req.param("handle"));
    if (!parsedHandle.success) return c.json(safeError("invalid_request"), 400);
    return next();
  });
  app.post("/funded-credential", bodyLimit({ maxSize: RUNTIME_BODY_LIMIT }), async (c) => {
    const query = RuntimeQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!query.success) return c.json(safeError("invalid_request"), 400);
    let machine: Awaited<ReturnType<typeof getRunningUserMachineByHandle>>;
    try {
      machine = await authenticatedRuntimeMachine(c, options, query.data.runtimeSlot);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
    if (!machine) return c.json(safeError("unauthorized"), 401);
    const body = EmptyBodySchema.safeParse(await readStrictJson(c));
    if (!body.success) return c.json(safeError("invalid_request"), 400);
    try {
      const issued = await options.repository.issueRuntimeCredential({
        ownerId: machine.clerkUserId,
        machineId: machine.machineId,
        runtimeSlot: machine.runtimeSlot,
      });
      return c.json(issued, 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  app.post("/funding-summary", bodyLimit({ maxSize: RUNTIME_BODY_LIMIT }), async (c) => {
    const query = RuntimeQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!query.success) return c.json(safeError("invalid_request"), 400);
    let machine: Awaited<ReturnType<typeof getRunningUserMachineByHandle>>;
    try {
      machine = await authenticatedRuntimeMachine(c, options, query.data.runtimeSlot);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
    if (!machine) return c.json(safeError("unauthorized"), 401);
    const body = EmptyBodySchema.safeParse(await readStrictJson(c));
    if (!body.success) return c.json(safeError("invalid_request"), 400);
    try {
      const summary = await options.repository.getRuntimeFundingSummary({
        ownerId: machine.clerkUserId,
        machineId: machine.machineId,
        runtimeSlot: machine.runtimeSlot,
      });
      return c.json(FundedAiRuntimeFundingSummaryResponseSchema.parse({
        contractVersion: 1,
        funding: { ...summary.funding, topUpEnabled: options.topUpEnabled === true },
        policy: summary.policy,
      }), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  return app;
}

export function createAiFundedOperatorRoutes(options: {
  db: PlatformDB;
  operatorSecret: string;
  repository: AiFundedPolicyRepository;
  promotionalGrant: AiFundedPromotionalGrantConfig;
  now?: () => Date;
}) {
  if (!options.repository || !options.db) throw new Error("Funded AI operator dependencies are missing");
  if (options.operatorSecret.length < 32) throw new Error("Funded AI operator authentication is misconfigured");
  const now = options.now ?? (() => new Date());
  const app = new Hono();
  app.use("*", async (c, next) => {
    noStore(c);
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!timingSafeTokenEquals(token, options.operatorSecret)) {
      return c.json(safeError("unauthorized"), 401);
    }
    return next();
  });

  const runtimePolicyResponse = (policy: Awaited<ReturnType<AiFundedPolicyRepository["getRuntimePolicy"]>>) =>
    FundedAiOperatorRuntimePolicyResponseSchema.parse({
      contractVersion: 1,
      policy: {
        enabled: policy.enabled,
        revision: policy.revision,
        allowedModelIds: policy.allowedModelIds,
        monthlyBudgetMicrousd: policy.monthlyBudgetMicrousd,
        expiresAt: policy.expiresAt,
        updatedAt: policy.updatedAt,
      },
    });

  app.get("/global-policy", async (c) => {
    const query = EmptyQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!query.success) return c.json(safeError("invalid_request"), 400);
    try {
      const policy = await options.repository.getGlobalPolicy();
      return c.json(FundedAiOperatorGlobalPolicyResponseSchema.parse({ contractVersion: 1, policy }), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });

  app.get("/runtimes/:handle/policy", async (c) => {
    const handle = HandleSchema.safeParse(c.req.param("handle"));
    const query = EmptyQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!handle.success || !query.success) return c.json(safeError("invalid_request"), 400);
    try {
      const machine = await getRunningUserMachineByHandle(options.db, handle.data);
      if (!machine) return c.json(safeError("not_found"), 404);
      const policy = await options.repository.getRuntimePolicy({
        ownerId: machine.clerkUserId,
        machineId: machine.machineId,
        runtimeSlot: machine.runtimeSlot,
      });
      return c.json(runtimePolicyResponse(policy), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });

  app.put("/global-policy", bodyLimit({ maxSize: RELAY_BODY_LIMIT }), async (c) => {
    const query = EmptyQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    const request = FundedAiOperatorGlobalPolicyUpdateRequestSchema.safeParse(await readStrictJson(c));
    if (!query.success || !request.success) return c.json(safeError("invalid_request"), 400);
    try {
      const policy = await options.repository.updateGlobalPolicy(request.data);
      return c.json(FundedAiOperatorGlobalPolicyResponseSchema.parse({ contractVersion: 1, policy }), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });

  app.put("/runtimes/:handle/policy", bodyLimit({ maxSize: RELAY_BODY_LIMIT }), async (c) => {
    const handle = HandleSchema.safeParse(c.req.param("handle"));
    const query = EmptyQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    const request = FundedAiOperatorRuntimePolicyUpdateRequestSchema.safeParse(await readStrictJson(c));
    if (!handle.success || !query.success || !request.success) return c.json(safeError("invalid_request"), 400);
    try {
      const machine = await getRunningUserMachineByHandle(options.db, handle.data);
      if (!machine) return c.json(safeError("not_found"), 404);
      const updated = await options.repository.setRuntimePolicy({
        identity: {
          ownerId: machine.clerkUserId,
          machineId: machine.machineId,
          runtimeSlot: machine.runtimeSlot,
        },
        ...request.data,
      });
      return c.json(runtimePolicyResponse(updated), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });

  app.post("/runtimes/:handle/promotional-grant", bodyLimit({ maxSize: RUNTIME_BODY_LIMIT }), async (c) => {
    const handle = HandleSchema.safeParse(c.req.param("handle"));
    const query = EmptyQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    const body = EmptyBodySchema.safeParse(await readStrictJson(c));
    if (!handle.success || !query.success || !body.success) return c.json(safeError("invalid_request"), 400);
    if (!options.promotionalGrant.enabled) return c.json(safeError("access_disabled"), 403);
    const createdAt = now().toISOString();
    if (options.promotionalGrant.expiresAt <= createdAt) return c.json(safeError("access_disabled"), 403);
    try {
      const machine = await getRunningUserMachineByHandle(options.db, handle.data);
      if (!machine) return c.json(safeError("not_found"), 404);
      const identity = {
        ownerId: machine.clerkUserId,
        machineId: machine.machineId,
        runtimeSlot: machine.runtimeSlot,
      };
      const idempotencyDigest = createHash("sha256")
        .update(`${options.promotionalGrant.campaignId}\0${identity.ownerId}\0${identity.machineId}\0${identity.runtimeSlot}`)
        .digest("hex");
      const grant = await options.repository.grantCredit({
        entryId: `promotion:${idempotencyDigest}`,
        identity,
        kind: "promotional_grant",
        amountMicrousd: options.promotionalGrant.amountMicrousd,
        sourceReference: options.promotionalGrant.campaignId,
        expiresAt: options.promotionalGrant.expiresAt,
      });
      return c.json(FundedAiPromotionalGrantResponseSchema.parse({
        contractVersion: 1,
        grant: {
          kind: "promotional",
          amountMicrousd: grant.amountMicrousd,
          expiresAt: grant.expiresAt,
          createdAt: grant.createdAt,
          status: "active",
        },
      }), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  return app;
}

export function createAiFundedRelayRoutes(options: {
  relayControlToken: string;
  repository: AiFundedPolicyRepository;
}) {
  if (!options.repository) throw new Error("Funded AI relay dependencies are missing");
  if (options.relayControlToken.length < 32) throw new Error("Funded AI relay authentication is misconfigured");
  const app = new Hono();
  app.use("*", async (c, next) => {
    noStore(c);
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!timingSafeTokenEquals(token, options.relayControlToken)) {
      return c.json(safeError("unauthorized"), 401);
    }
    return next();
  });
  app.post("/authorize", bodyLimit({ maxSize: RELAY_BODY_LIMIT }), async (c) => {
    const request = FundedAiAuthorizationRequestSchema.safeParse(await readStrictJson(c));
    if (!request.success) return c.json(safeError("invalid_request"), 400);
    try {
      return c.json(await options.repository.authorize(request.data), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  app.post("/check", bodyLimit({ maxSize: RELAY_BODY_LIMIT }), async (c) => {
    const request = FundedAiPolicyCheckRequestSchema.safeParse(await readStrictJson(c));
    if (!request.success) return c.json(safeError("invalid_request"), 400);
    try {
      return c.json(await options.repository.checkPolicy(request.data), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  app.post("/settle", bodyLimit({ maxSize: RELAY_BODY_LIMIT }), async (c) => {
    const request = FundedAiSettlementRequestSchema.safeParse(await readStrictJson(c));
    if (!request.success) return c.json(safeError("invalid_request"), 400);
    try {
      return c.json(await options.repository.settleReservation(request.data), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  app.post("/finalize", bodyLimit({ maxSize: RELAY_BODY_LIMIT }), async (c) => {
    const request = FundedAiFinalizationRequestSchema.safeParse(await readStrictJson(c));
    if (!request.success) return c.json(safeError("invalid_request"), 400);
    try {
      return c.json(await options.repository.finalizeReservation(request.data), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  app.post("/start", bodyLimit({ maxSize: RELAY_BODY_LIMIT }), async (c) => {
    const request = FundedAiStartRequestSchema.safeParse(await readStrictJson(c));
    if (!request.success) return c.json(safeError("invalid_request"), 400);
    try {
      return c.json(await options.repository.startReservation(request.data), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  app.post("/release", bodyLimit({ maxSize: RELAY_BODY_LIMIT }), async (c) => {
    const request = FundedAiReleaseRequestSchema.safeParse(await readStrictJson(c));
    if (!request.success) return c.json(safeError("invalid_request"), 400);
    try {
      return c.json(await options.repository.releaseReservation(request.data), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  app.post("/reservations/cleanup", bodyLimit({ maxSize: RUNTIME_BODY_LIMIT }), async (c) => {
    const request = CleanupBodySchema.safeParse(await readStrictJson(c));
    if (!request.success) return c.json(safeError("invalid_request"), 400);
    try {
      return c.json({ processed: await options.repository.cleanupExpiredReservations(request.data) }, 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  return app;
}
