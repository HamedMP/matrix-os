import { createHash } from "node:crypto";
import { FundedAiGlobalPolicySchema, IsoTimestampSchema, MANAGED_WORKERS_AI_MODEL_IDS } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";
import { withAccountDeletionOwnerLock } from "./account-deletion/admission.js";
import type { PlatformDB } from "./db.js";
import { parseModels, utcMonthStart } from "./ai-funded-metering-helpers.js";

const PreviewIdentitySchema = z.object({
  ownerId: z.string().min(1).max(256),
  machineId: z.string().min(1).max(160),
  runtimeSlot: z.string().min(1).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  expectedRuntimeTokenEpoch: z.number().int().min(1).max(2_147_483_647),
}).strict();

const ORDINARY_MODELS = ["anthropic/claude-sonnet-5", ...MANAGED_WORKERS_AI_MODEL_IDS];
export const BOUNDED_PREVIEW_PROVISIONING_CLASSES = ["preview", "private-preview"] as const;

export function isBoundedPreviewProvisioningClass(
  value: string,
): value is typeof BOUNDED_PREVIEW_PROVISIONING_CLASSES[number] {
  return (BOUNDED_PREVIEW_PROVISIONING_CLASSES as readonly string[]).includes(value);
}

export type PreviewRuntimeAccessConfig = { enabled: false } | {
  enabled: true;
  runtimeSecret: string;
  ttlMs: number;
  aiBudgetMicrousd: number;
  aiRequestLimit: number;
  speechRequestLimit: number;
  maxConcurrency: 1;
};

function bounded(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("Preview runtime access is misconfigured");
  }
  return value;
}

export function loadPreviewRuntimeAccessConfig(env: NodeJS.ProcessEnv): PreviewRuntimeAccessConfig {
  if (env.MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED !== "true") return { enabled: false };
  const runtimeSecret = env.MATRIX_PREVIEW_RUNTIME_SECRET ?? "";
  if (runtimeSecret.length < 32 || runtimeSecret === env.PLATFORM_SECRET) {
    throw new Error("Preview runtime access is misconfigured");
  }
  const maxConcurrency = bounded(env.MATRIX_PREVIEW_MAX_CONCURRENCY, 1, 1, 1) as 1;
  return {
    enabled: true,
    runtimeSecret,
    ttlMs: bounded(env.MATRIX_PREVIEW_RUNTIME_TTL_MS, 6 * 60 * 60_000, 15 * 60_000, 24 * 60 * 60_000),
    aiBudgetMicrousd: bounded(env.MATRIX_PREVIEW_AI_BUDGET_MICROUSD, 1_000_000, 1, 5_000_000),
    aiRequestLimit: bounded(env.MATRIX_PREVIEW_AI_REQUEST_LIMIT, 25, 1, 100),
    speechRequestLimit: bounded(env.MATRIX_PREVIEW_SPEECH_REQUEST_LIMIT, 25, 1, 100),
    maxConcurrency,
  };
}

export interface PreviewRuntimeAccessSummary {
  identity: { ownerId: string; machineId: string; runtimeSlot: string; runtimeTokenEpoch: number };
  ai: { budgetMicrousd: number; requestLimit: number; requestsUsed: number; requestsRemaining: number };
  speech: { requestLimit: number; requestsUsed: number; requestsRemaining: number };
  maxConcurrency: 1;
  expiresAt: string;
}

export function previewAllocationSummary(row: {
  machine_id: string; owner_id: string; runtime_slot: string; runtime_token_epoch: number;
  ai_budget_microusd: number; ai_request_limit: number; ai_requests_used: number;
  speech_request_limit: number; speech_requests_used: number; max_concurrency: number; expires_at: string;
}): PreviewRuntimeAccessSummary {
  return {
    identity: { ownerId: row.owner_id, machineId: row.machine_id, runtimeSlot: row.runtime_slot,
      runtimeTokenEpoch: row.runtime_token_epoch },
    ai: { budgetMicrousd: Number(row.ai_budget_microusd), requestLimit: row.ai_request_limit,
      requestsUsed: row.ai_requests_used, requestsRemaining: row.ai_request_limit - row.ai_requests_used },
    speech: { requestLimit: row.speech_request_limit, requestsUsed: row.speech_requests_used,
      requestsRemaining: row.speech_request_limit - row.speech_requests_used },
    maxConcurrency: 1,
    expiresAt: row.expires_at,
  };
}

/** One allocation belongs to one immutable machine generation. Replays read the
 * counters and never extend expiry, reset usage, or grant more credit. */
export async function initializePreviewRuntimeAccess(options: {
  db: PlatformDB;
  repository: Pick<AiFundedPolicyRepository, "grantCreditInTransaction">;
  config: PreviewRuntimeAccessConfig;
  request: z.input<typeof PreviewIdentitySchema>;
  now?: () => Date;
}): Promise<PreviewRuntimeAccessSummary> {
  if (!options.config.enabled) throw new Error("Preview runtime access is unavailable");
  const config = options.config;
  const request = PreviewIdentitySchema.parse(options.request);
  const clock = options.now ?? (() => new Date());
  const at = IsoTimestampSchema.parse(clock().toISOString());
  const expiresAt = new Date(Date.parse(at) + config.ttlMs).toISOString();
  return options.db.transaction(async trx => {
    // Keep the global account-deletion lock ahead of machine/policy row locks,
    // matching funded admission and avoiding a machine -> owner lock inversion.
    await withAccountDeletionOwnerLock(trx, request.ownerId, async (_locked, admission) => {
      if (!admission.newWorkAllowed) throw new Error("Preview runtime is ineligible");
    });
    const machine = await trx.executor.selectFrom("user_machines").select([
      "machine_id", "clerk_user_id", "runtime_slot", "runtime_token_epoch", "provisioning_class",
      "status", "activation_state", "deleted_at",
    ]).where("machine_id", "=", request.machineId).forUpdate().executeTakeFirst();
    if (!machine || machine.clerk_user_id !== request.ownerId || machine.runtime_slot !== request.runtimeSlot
      || machine.runtime_token_epoch !== request.expectedRuntimeTokenEpoch
      || !isBoundedPreviewProvisioningClass(machine.provisioning_class)
      || machine.status !== "running" || machine.activation_state !== "authorized" || machine.deleted_at !== null) {
      throw new Error("Preview runtime is ineligible");
    }
    const existing = await trx.executor.selectFrom("preview_runtime_allocations").selectAll()
      .where("machine_id", "=", request.machineId).forUpdate().executeTakeFirst();
    if (existing) {
      if (existing.owner_id !== request.ownerId || existing.runtime_slot !== request.runtimeSlot
        || existing.runtime_token_epoch !== request.expectedRuntimeTokenEpoch) {
        throw new Error("Preview runtime allocation identity mismatch");
      }
      return previewAllocationSummary(existing);
    }
    const globalRow = await trx.executor.selectFrom("ai_funded_global_policy").selectAll()
      .where("policy_id", "=", "default").forUpdate().executeTakeFirstOrThrow();
    const global = FundedAiGlobalPolicySchema.parse({ enabled: globalRow.enabled, revision: globalRow.revision,
      allowedModelIds: JSON.parse(globalRow.allowed_model_ids) as unknown, updatedAt: globalRow.updated_at });
    const allowedModels = ORDINARY_MODELS.filter(model => global.allowedModelIds.includes(model));
    if (!global.enabled || allowedModels.length === 0) throw new Error("Preview runtime access is unavailable");
    const conflicting = await trx.executor.selectFrom("ai_funded_runtime_policies").selectAll()
      .where("machine_id", "=", request.machineId).forUpdate().executeTakeFirst();
    if (conflicting) throw new Error("Preview runtime already has a funded policy");
    await trx.executor.insertInto("ai_funded_runtime_policies").values({
      machine_id: request.machineId, owner_id: request.ownerId, runtime_slot: request.runtimeSlot,
      enabled: true, allowed_model_ids: JSON.stringify(allowedModels),
      monthly_budget_microusd: config.aiBudgetMicrousd, expires_at: expiresAt,
      next_issue_at: "1970-01-01T00:00:00.000Z", revision: 1, created_at: at, updated_at: at,
    }).execute();
    await trx.executor.insertInto("ai_funded_runtime_balances").values({
      machine_id: request.machineId, owner_id: request.ownerId, runtime_slot: request.runtimeSlot,
      credit_balance_microusd: 0, promotional_balance_microusd: 0, addon_balance_microusd: 0,
      reserved_microusd: 0, funding_shortfall_microusd: 0, month_period_start: utcMonthStart(new Date(at)),
      month_spent_microusd: 0, month_reserved_microusd: 0, updated_at: at,
    }).execute();
    const inserted = await trx.executor.insertInto("preview_runtime_allocations").values({
      machine_id: request.machineId, owner_id: request.ownerId, runtime_slot: request.runtimeSlot,
      runtime_token_epoch: request.expectedRuntimeTokenEpoch,
      ai_budget_microusd: config.aiBudgetMicrousd,
      ai_request_limit: config.aiRequestLimit, ai_requests_used: 0,
      speech_request_limit: config.speechRequestLimit, speech_requests_used: 0,
      max_concurrency: config.maxConcurrency, expires_at: expiresAt, created_at: at, updated_at: at,
    }).returningAll().executeTakeFirstOrThrow();
    const digest = createHash("sha256").update(`${request.machineId}\0${request.expectedRuntimeTokenEpoch}`).digest("hex").slice(0, 32);
    await options.repository.grantCreditInTransaction(trx, {
      entryId: `preview-runtime:${digest}`,
      identity: { ownerId: request.ownerId, machineId: request.machineId, runtimeSlot: request.runtimeSlot },
      kind: "promotional_grant",
      amountMicrousd: config.aiBudgetMicrousd,
      sourceReference: "preview-runtime-access",
      expiresAt,
    }, at);
    return previewAllocationSummary(inserted);
  });
}

export async function readActivePreviewRuntimeAccess(db: PlatformDB, identity: {
  ownerId: string; machineId: string; runtimeSlot: string;
}, at = new Date()): Promise<PreviewRuntimeAccessSummary | null> {
  const row = await db.executor.selectFrom("preview_runtime_allocations as allocation")
    .innerJoin("user_machines as machine", "machine.machine_id", "allocation.machine_id")
    .selectAll("allocation")
    .where("allocation.machine_id", "=", identity.machineId)
    .where("allocation.owner_id", "=", identity.ownerId)
    .where("allocation.runtime_slot", "=", identity.runtimeSlot)
    .whereRef("allocation.runtime_token_epoch", "=", "machine.runtime_token_epoch")
    .where("machine.provisioning_class", "in", BOUNDED_PREVIEW_PROVISIONING_CLASSES)
    .where("machine.status", "=", "running")
    .where("machine.activation_state", "=", "authorized")
    .where("machine.deleted_at", "is", null)
    .where("allocation.expires_at", ">", at.toISOString())
    .executeTakeFirst();
  return row ? previewAllocationSummary(row) : null;
}
