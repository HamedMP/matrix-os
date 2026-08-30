import {
  FundedAiAuthorizationRequestSchema,
  FundedAiSafeErrorSchema,
  type FundedAiSafeError,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { getRunningUserMachineByHandle, type PlatformDB } from "./db.js";
import { AiFundedPolicyError, type AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";
import { buildPlatformRuntimeVerificationToken, timingSafeTokenEquals } from "./platform-token.js";

const RUNTIME_BODY_LIMIT = 1024;
const RELAY_BODY_LIMIT = 4 * 1024;
const HandleSchema = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/);
const EmptyBodySchema = z.object({}).strict();

export type AiFundedControlPlaneConfig = { enabled: false } | {
  enabled: true;
  platformSecret: string;
  relayControlToken: string;
  credentialHashSecret: string;
  credentialTtlMs: number;
  issueCooldownMs: number;
  policyFreshnessMs: number;
};

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("Funded AI control plane is misconfigured");
  }
  return value;
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
  };
}

function noStore(c: Context): void {
  c.header("Cache-Control", "no-store, private");
  c.header("CDN-Cache-Control", "no-store");
  c.header("Cloudflare-CDN-Cache-Control", "no-store");
}

function safeError(code: FundedAiSafeError["error"]["code"]): FundedAiSafeError {
  const message = {
    unauthorized: "Unauthorized",
    access_disabled: "Matrix-funded AI is unavailable",
    model_not_allowed: "This model is not available",
    rate_limited: "Try again later",
    revision_conflict: "Policy changed; refresh and try again",
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
  } catch {
    return Symbol.for("invalid-json");
  }
}

export function createAiFundedRuntimeRoutes(options: {
  db: PlatformDB;
  platformSecret: string;
  repository: AiFundedPolicyRepository;
}) {
  if (options.platformSecret.length < 32) throw new Error("Funded AI runtime authentication is misconfigured");
  const app = new Hono();
  app.use("*", async (c, next) => {
    noStore(c);
    const parsedHandle = HandleSchema.safeParse(c.req.param("handle"));
    if (!parsedHandle.success) return c.json(safeError("invalid_request"), 400);
    return next();
  });
  app.post("/funded-credential", bodyLimit({ maxSize: RUNTIME_BODY_LIMIT }), async (c) => {
    const handle = HandleSchema.parse(c.req.param("handle"));
    let machine: Awaited<ReturnType<typeof getRunningUserMachineByHandle>>;
    try {
      machine = await getRunningUserMachineByHandle(options.db, handle);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
    if (!machine) return c.json(safeError("unauthorized"), 401);
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const expected = buildPlatformRuntimeVerificationToken({
      handle,
      machineId: machine.machineId,
      runtimeSlot: machine.runtimeSlot,
    }, options.platformSecret);
    if (!timingSafeTokenEquals(token, expected)) return c.json(safeError("unauthorized"), 401);
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
  return app;
}

export function createAiFundedRelayRoutes(options: {
  relayControlToken: string;
  repository: AiFundedPolicyRepository;
}) {
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
      return c.json(await options.repository.authorize({
        credential: request.data.credential,
        modelId: request.data.modelId,
      }), 200);
    } catch (error) {
      return policyErrorResponse(c, error);
    }
  });
  return app;
}
