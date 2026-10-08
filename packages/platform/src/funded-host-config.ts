import { Hono } from "hono";
import { getAccountDeletionAdmission } from "./account-deletion/admission.js";
import { sql } from "kysely";
import { z } from "zod/v4";
import type { PlatformDB } from "./db.js";
import { CustomerHandleSchema } from "./customer-vps-schema.js";
import { buildPlatformRuntimeVerificationToken, buildPlatformSyncVerificationToken, timingSafeTokenEquals } from "./platform-token.js";

const EpochSchema = z.number().int().min(1).max(2_147_483_647);
const TimestampSchema = z.string().datetime({ precision: 3 });
const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
// Untagged production Cloud Run services only. Reviewed operators configure the
// exact origin; recipient requests cannot supply an origin or path.
const RelayOriginSchema = z.string().max(256).regex(
  /^https:\/\/matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app$/,
);
const IdentitySchema = z.object({ handle: CustomerHandleSchema, machineId: z.uuid(),
  runtimeSlot: z.literal("primary"), runtimeTokenEpoch: EpochSchema }).strict();
export const FundedHostConfigResponseSchema = z.object({
  contractVersion: z.literal(1), kind: z.literal("matrix-funded-host-config"), source: z.literal("platform"),
  sourceSha: ShaSchema, issuedAt: TimestampSchema, expiresAt: TimestampSchema,
  identity: IdentitySchema,
  configuration: z.object({ MATRIX_FUNDED_AI_ENABLED: z.literal("true"),
    MATRIX_FUNDED_AI_RELAY_URL: RelayOriginSchema,
    MATRIX_FUNDED_AI_RUNTIME_TOKEN: z.string().regex(/^[a-f0-9]{64}$/),
    MATRIX_FUNDED_AI_PLATFORM_URL: z.literal("https://app.matrix-os.com"),
  }).strict(),
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.issuedAt)
  && Date.parse(value.expiresAt) - Date.parse(value.issuedAt) <= 30_000);
export type FundedHostConfigResponse = z.infer<typeof FundedHostConfigResponseSchema>;
export type FundedHostConfig = { enabled: false } | {
  enabled: true; machineIds: readonly string[]; relayOrigin: string; validThrough: string; sourceSha: string;
};

export function loadFundedHostConfig(env: NodeJS.ProcessEnv, now = new Date()): FundedHostConfig {
  const gate = env.MATRIX_FUNDED_HOST_CONFIG_ENABLED ?? "false";
  if (gate === "false") return { enabled: false };
  if (gate !== "true" || env.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED !== "true") {
    throw new Error("Funded host configuration is misconfigured");
  }
  const raw = env.MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS ?? "";
  const machineIds = raw === "" ? [] : raw.split(",");
  const valid = z.object({ machineIds: z.array(z.uuid()).max(100), relayOrigin: RelayOriginSchema,
    validThrough: TimestampSchema, sourceSha: ShaSchema }).safeParse({ machineIds,
    relayOrigin: env.MATRIX_FUNDED_AI_RELAY_URL, validThrough: env.MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH,
    sourceSha: env.MATRIX_FUNDED_HOST_CONFIG_SOURCE_SHA });
  if (!valid.success || new Set(machineIds).size !== machineIds.length
    || Date.parse(valid.data.validThrough) <= now.getTime()
    || Date.parse(valid.data.validThrough) - now.getTime() > 7 * 24 * 60 * 60_000) {
    throw new Error("Funded host configuration is misconfigured");
  }
  return { enabled: true, ...valid.data };
}

const RequestSchema = IdentitySchema.extend({
  runtimeTokenEpoch: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(EpochSchema),
  authorization: z.string().regex(/^Bearer [a-f0-9]{64}$/),
});
const SupportedChatModels = ["anthropic/claude-sonnet-5", "@cf/zai-org/glm-5.3-flash"] as readonly string[];
function permittedModels(globalRaw: string, runtimeRaw: string): boolean {
  const models = z.array(z.string().max(128)).max(16);
  const global = models.parse(JSON.parse(globalRaw) as unknown);
  const runtime = models.parse(JSON.parse(runtimeRaw) as unknown);
  return global.some(model => SupportedChatModels.includes(model) && runtime.includes(model));
}

/** No policy repository is injected: config delivery cannot grant, reserve,
 * issue credentials, settle usage, probe models or reconcile financial state. */
export function createFundedHostConfigRoutes(options: {
  db: PlatformDB; platformSecret: string; config: FundedHostConfig; now?: () => Date; env?: NodeJS.ProcessEnv;
}) {
  if (!options.db?.kysely || options.platformSecret.length < 32 || !options.config) {
    throw new Error("Funded host configuration dependencies are missing");
  }
  const { db, platformSecret } = options;
  const now = options.now ?? (() => new Date());
  const deletionEnv = { ACCOUNT_DELETION_SECRET: (options.env ?? process.env).ACCOUNT_DELETION_SECRET };
  // Copy and validate at registration so typed dependency injection cannot
  // silently enlarge the cohort or validity window after startup.
  const config = options.config.enabled ? loadFundedHostConfig({
    MATRIX_FUNDED_HOST_CONFIG_ENABLED: "true", MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
    MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: options.config.machineIds.join(","),
    MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: options.config.validThrough,
    MATRIX_FUNDED_HOST_CONFIG_SOURCE_SHA: options.config.sourceSha,
    MATRIX_FUNDED_AI_RELAY_URL: options.config.relayOrigin,
  }, now()) : { enabled: false as const };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store, private"); c.header("CDN-Cache-Control", "no-store");
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
    return next();
  });
  app.get("/funded-host-config", async c => {
    const parsed = RequestSchema.safeParse({ handle: c.req.param("handle"),
      machineId: c.req.header("x-matrix-machine-id"), runtimeSlot: c.req.header("x-matrix-runtime-slot"),
      runtimeTokenEpoch: c.req.header("x-matrix-runtime-token-epoch"), authorization: c.req.header("authorization") });
    if (!parsed.success || new URL(c.req.url).search !== "") return c.json({ error: "Invalid request" }, 400);
    if (!config.enabled || config.machineIds.length === 0 || Date.parse(config.validThrough) <= now().getTime()) {
      return c.json({ error: "Service unavailable" }, 503);
    }
    const request = parsed.data;
    if (!config.machineIds.includes(request.machineId)) return c.json({ error: "Unauthorized" }, 401);
    // Cheap rejection before entering the database pool. This proves only the
    // supplied token identity; current DB state and epoch remain authoritative.
    const suppliedIdentity = { handle: request.handle, machineId: request.machineId, runtimeSlot: request.runtimeSlot };
    if (!timingSafeTokenEquals(request.authorization.slice(7),
      buildPlatformSyncVerificationToken(suppliedIdentity, platformSecret, request.runtimeTokenEpoch))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    try {
      await db.ready;
      // Explicit read-only, repeatable snapshot for identity, policy and pending
      // usage. No row locks, financial helper calls, migration or reconciliation.
      const result = await db.kysely.transaction().setIsolationLevel("repeatable read").execute(async trx => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        await sql`SET LOCAL statement_timeout = '5000ms'`.execute(trx);
        const machine = await trx.selectFrom("user_machines as machine")
          .select(["machine.machine_id", "machine.clerk_user_id", "machine.handle", "machine.runtime_slot", "machine.runtime_token_epoch"])
          .where("machine.machine_id", "=", request.machineId).where("machine.handle", "=", request.handle)
          .where("machine.runtime_slot", "=", "primary").where("machine.status", "=", "running")
          .where("machine.provisioning_class", "=", "customer").where("machine.activation_state", "=", "authorized")
          .where("machine.deleted_at", "is", null).executeTakeFirst();
        if (!machine || machine.runtime_token_epoch !== request.runtimeTokenEpoch) return { status: "unauthorized" as const };
        const identity = { handle: machine.handle, machineId: machine.machine_id, runtimeSlot: machine.runtime_slot };
        if (!timingSafeTokenEquals(request.authorization.slice(7), buildPlatformSyncVerificationToken(identity, platformSecret, machine.runtime_token_epoch))) {
          return { status: "unauthorized" as const };
        }
        // Reuse deletion admission against this read-only snapshot. Scheduled
        // deletion also disallows new funded repair work during its grace period.
        const deletion = await getAccountDeletionAdmission({ ...db, executor: trx }, machine.clerk_user_id, deletionEnv, now());
        if (!deletion.newWorkAllowed) return { status: "deferred" as const };
        const policy = await trx.selectFrom("ai_funded_runtime_policies as runtime")
          .innerJoin("ai_funded_global_policy as global", join => join.on("global.policy_id", "=", "default"))
          .select(["runtime.expires_at", "runtime.allowed_model_ids as runtime_models", "global.allowed_model_ids as global_models"])
          .where("runtime.machine_id", "=", machine.machine_id).where("runtime.owner_id", "=", machine.clerk_user_id)
          .where("runtime.runtime_slot", "=", "primary").where("runtime.enabled", "=", true).where("global.enabled", "=", true)
          .executeTakeFirst();
        const checked = now();
        if (!policy || (policy.expires_at !== null && Date.parse(policy.expires_at) <= checked.getTime())
          || !permittedModels(policy.global_models, policy.runtime_models)) return { status: "deferred" as const };
        // Conservatively retain unknown/expired obligations as a deferral. Never
        // clear holds or infer zero usage merely to permit a Gateway restart.
        // Machine obligations survive stale owner metadata; a settled label with
        // no established cost is corrupt financial evidence, not a closed hold.
        const pending = await trx.selectFrom("ai_funded_usage_reservations").select("reservation_id")
          .where("machine_id", "=", machine.machine_id).where("runtime_slot", "=", "primary")
          .where(eb => eb.or([
            eb("status", "not in", ["settled", "released"]),
            eb.and([eb("status", "=", "settled"), eb("actual_microusd", "is", null)]),
          ]))
          .limit(1).executeTakeFirst();
        if (pending) return { status: "deferred" as const };
        const expires = Math.min(checked.getTime() + 30_000, Date.parse(config.validThrough),
          policy.expires_at === null ? Infinity : Date.parse(policy.expires_at));
        if (expires <= checked.getTime()) return { status: "deferred" as const };
        return { status: "ready" as const, response: FundedHostConfigResponseSchema.parse({
          contractVersion: 1, kind: "matrix-funded-host-config", source: "platform", sourceSha: config.sourceSha,
          issuedAt: checked.toISOString(), expiresAt: new Date(expires).toISOString(),
          identity: { ...identity, runtimeTokenEpoch: machine.runtime_token_epoch },
          configuration: { MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RELAY_URL: config.relayOrigin,
            MATRIX_FUNDED_AI_RUNTIME_TOKEN: buildPlatformRuntimeVerificationToken(identity, platformSecret, machine.runtime_token_epoch),
            MATRIX_FUNDED_AI_PLATFORM_URL: "https://app.matrix-os.com" },
        }) };
      });
      if (result.status === "unauthorized") return c.json({ error: "Unauthorized" }, 401);
      if (result.status === "deferred") return c.json({ error: "Service unavailable" }, 503);
      return c.json(result.response, 200);
    } catch (error) {
      console.error(`[funded-host-config] request failed (${error instanceof Error ? error.name : "UnknownError"})`);
      return c.json({ error: "Service unavailable" }, 503);
    }
  });
  return app;
}
