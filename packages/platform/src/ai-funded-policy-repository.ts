import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  FUNDED_AI_AUDIENCE,
  FUNDED_AI_SCOPE,
  FundedAiGlobalPolicySchema,
  FundedAiRuntimeCredentialIssueResponseSchema,
  IsoTimestampSchema,
  type FundedAiGlobalPolicy,
  type FundedAiIdentity,
  type FundedAiRuntimeCredentialIssueResponse,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { sql } from "kysely";
import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { createAiFundedMeteringRepository } from "./ai-funded-metering-repository.js";

export { AiFundedPolicyError, type AiFundedPolicyErrorCode } from "./ai-funded-policy-errors.js";

const ModelIdsSchema = z.array(z.string().min(3).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/))
  .max(64).refine((values) => new Set(values).size === values.length);
const IdentitySchema = z.object({
  ownerId: z.string().min(1).max(160),
  machineId: z.string().min(1).max(160),
  runtimeSlot: z.string().min(1).max(80),
}).strict();
const GlobalPolicyUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  enabled: z.boolean(),
  allowedModelIds: ModelIdsSchema,
}).strict();
const RuntimePolicyUpdateSchema = z.object({
  identity: IdentitySchema,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  enabled: z.boolean(),
  allowedModelIds: ModelIdsSchema,
  monthlyBudgetMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: IsoTimestampSchema.nullable(),
}).strict();
const TOKEN_PATTERN = /^sk-matrix-funded-([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})\.([A-Za-z0-9_-]{43})$/;

export interface AiFundedPolicyRepositoryOptions {
  db: PlatformDB;
  credentialHashSecret: string;
  now?: () => Date;
  tokenIdFactory?: () => string;
  tokenSecretFactory?: () => string;
  credentialTtlMs?: number;
  issueCooldownMs?: number;
  policyFreshnessMs?: number;
  reservationTtlMs?: number;
  inFlightTtlMs?: number;
  reservationIdFactory?: () => string;
}

export type SetRuntimePolicyInput = z.infer<typeof RuntimePolicyUpdateSchema>;

function parseModels(value: string): string[] {
  try {
    return ModelIdsSchema.parse(JSON.parse(value));
  } catch (error: unknown) {
    const category = error instanceof SyntaxError
      ? "syntax_error"
      : error instanceof z.ZodError
        ? "schema_error"
        : "unexpected_error";
    console.error(`[ai-funded-policy] invalid stored model configuration (${category})`);
    throw new Error("Invalid funded AI policy model configuration", { cause: error });
  }
}

function intersectModels(globalModels: string[], runtimeModels: string[]): string[] {
  const runtimeSet = new Set(runtimeModels);
  return globalModels.filter((model) => runtimeSet.has(model));
}

function utcMonthStart(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

export function createAiFundedPolicyRepository(options: AiFundedPolicyRepositoryOptions) {
  if (options.credentialHashSecret.length < 32) {
    throw new Error("Funded AI credential hash secret must be at least 32 characters");
  }
  const now = options.now ?? (() => new Date());
  const tokenIdFactory = options.tokenIdFactory ?? randomUUID;
  const tokenSecretFactory = options.tokenSecretFactory ?? (() => randomBytes(32).toString("base64url"));
  const credentialTtlMs = options.credentialTtlMs ?? 15 * 60_000;
  const issueCooldownMs = options.issueCooldownMs ?? 30_000;
  const policyFreshnessMs = options.policyFreshnessMs ?? 60_000;
  const reservationTtlMs = options.reservationTtlMs ?? 5 * 60_000;
  const inFlightTtlMs = options.inFlightTtlMs ?? 30 * 60_000;
  if (credentialTtlMs < 60_000 || credentialTtlMs > 60 * 60_000) throw new Error("Invalid credential TTL");
  if (issueCooldownMs < 1_000 || issueCooldownMs > credentialTtlMs) throw new Error("Invalid issue cooldown");
  if (policyFreshnessMs < 1_000 || policyFreshnessMs > 5 * 60_000) throw new Error("Invalid policy freshness");
  if (reservationTtlMs < 30_000 || reservationTtlMs > 15 * 60_000) throw new Error("Invalid reservation TTL");
  if (inFlightTtlMs < 60_000 || inFlightTtlMs > 60 * 60_000) throw new Error("Invalid in-flight TTL");

  const hashCredential = (credential: string) => createHmac("sha256", options.credentialHashSecret)
    .update(credential).digest("hex");

  async function getGlobalPolicy(): Promise<FundedAiGlobalPolicy> {
    await options.db.ready;
    const row = await options.db.executor.selectFrom("ai_funded_global_policy")
      .selectAll().where("policy_id", "=", "default").executeTakeFirstOrThrow();
    return FundedAiGlobalPolicySchema.parse({
      enabled: row.enabled,
      revision: row.revision,
      allowedModelIds: parseModels(row.allowed_model_ids),
      updatedAt: row.updated_at,
    });
  }

  async function getRuntimePolicy(identityInput: FundedAiIdentity) {
    const identity = IdentitySchema.parse(identityInput);
    await options.db.ready;
    const row = await options.db.executor.selectFrom("ai_funded_runtime_policies as runtime")
      .innerJoin("user_machines as machine", "machine.machine_id", "runtime.machine_id")
      .select([
        "runtime.enabled",
        "runtime.revision",
        "runtime.allowed_model_ids",
        "runtime.monthly_budget_microusd",
        "runtime.expires_at",
        "runtime.updated_at",
      ])
      .where("runtime.machine_id", "=", identity.machineId)
      .where("runtime.owner_id", "=", identity.ownerId)
      .where("runtime.runtime_slot", "=", identity.runtimeSlot)
      .where("machine.clerk_user_id", "=", identity.ownerId)
      .where("machine.runtime_slot", "=", identity.runtimeSlot)
      .where("machine.status", "=", "running")
      .where("machine.activation_state", "=", "authorized")
      .where("machine.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw new AiFundedPolicyError("identity_mismatch");
    return {
      identity,
      enabled: row.enabled,
      revision: row.revision,
      allowedModelIds: parseModels(row.allowed_model_ids),
      monthlyBudgetMicrousd: Number(row.monthly_budget_microusd),
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    };
  }

  async function updateGlobalPolicy(input: {
    expectedRevision: number;
    enabled: boolean;
    allowedModelIds: string[];
  }): Promise<FundedAiGlobalPolicy> {
    const parsed = GlobalPolicyUpdateSchema.parse(input);
    const allowedModelIds = parsed.allowedModelIds;
    const updatedAt = now().toISOString();
    await options.db.ready;
    const row = await options.db.executor.updateTable("ai_funded_global_policy").set({
      enabled: parsed.enabled,
      allowed_model_ids: JSON.stringify(allowedModelIds),
      revision: parsed.expectedRevision + 1,
      updated_at: updatedAt,
    }).where("policy_id", "=", "default").where("revision", "=", parsed.expectedRevision)
      .returningAll().executeTakeFirst();
    if (!row) throw new AiFundedPolicyError("revision_conflict");
    return FundedAiGlobalPolicySchema.parse({
      enabled: row.enabled,
      revision: row.revision,
      allowedModelIds,
      updatedAt: row.updated_at,
    });
  }

  async function setRuntimePolicy(input: SetRuntimePolicyInput) {
    const parsed = RuntimePolicyUpdateSchema.parse(input);
    const identity = parsed.identity;
    const allowedModelIds = parsed.allowedModelIds;
    const policyTime = now();
    const at = policyTime.toISOString();
    return options.db.transaction(async (trx) => {
      const machine = await trx.executor.selectFrom("user_machines").select([
        "machine_id", "clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at",
      ]).where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirst();
      if (!machine || machine.clerk_user_id !== identity.ownerId || machine.runtime_slot !== identity.runtimeSlot
        || machine.status !== "running" || machine.activation_state !== "authorized" || machine.deleted_at !== null) {
        throw new AiFundedPolicyError("identity_mismatch");
      }
      await trx.executor.insertInto("ai_funded_runtime_policies").values({
        machine_id: identity.machineId,
        owner_id: identity.ownerId,
        runtime_slot: identity.runtimeSlot,
        enabled: false,
        allowed_model_ids: "[]",
        monthly_budget_microusd: 0,
        expires_at: null,
        next_issue_at: "1970-01-01T00:00:00.000Z",
        revision: 0,
        created_at: at,
        updated_at: at,
      }).onConflict((conflict) => conflict.column("machine_id").doNothing()).execute();
      await trx.executor.insertInto("ai_funded_runtime_balances").values({
        machine_id: identity.machineId,
        owner_id: identity.ownerId,
        runtime_slot: identity.runtimeSlot,
        credit_balance_microusd: 0,
        promotional_balance_microusd: 0,
        addon_balance_microusd: 0,
        reserved_microusd: 0,
        month_period_start: utcMonthStart(policyTime),
        month_spent_microusd: 0,
        month_reserved_microusd: 0,
        updated_at: at,
      }).onConflict((conflict) => conflict.column("machine_id").doNothing()).execute();
      const row = await trx.executor.updateTable("ai_funded_runtime_policies").set({
        enabled: parsed.enabled,
        allowed_model_ids: JSON.stringify(allowedModelIds),
        monthly_budget_microusd: parsed.monthlyBudgetMicrousd,
        expires_at: parsed.expiresAt,
        revision: parsed.expectedRevision + 1,
        updated_at: at,
      }).where("machine_id", "=", identity.machineId).where("owner_id", "=", identity.ownerId)
        .where("runtime_slot", "=", identity.runtimeSlot).where("revision", "=", parsed.expectedRevision)
        .returningAll().executeTakeFirst();
      if (!row) throw new AiFundedPolicyError("revision_conflict");
      return {
        identity,
        enabled: row.enabled,
        revision: row.revision,
        allowedModelIds,
        monthlyBudgetMicrousd: Number(row.monthly_budget_microusd),
        expiresAt: row.expires_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async function issueRuntimeCredential(identityInput: FundedAiIdentity): Promise<FundedAiRuntimeCredentialIssueResponse> {
    const identity = IdentitySchema.parse(identityInput);
    await options.db.ready;
    const checked = now();
    const checkedAt = checked.toISOString();
    const nextIssueAt = new Date(checked.getTime() + issueCooldownMs).toISOString();
    const expiresAt = new Date(checked.getTime() + credentialTtlMs).toISOString();
    const tokenId = tokenIdFactory();
    const secret = tokenSecretFactory();
    const credential = `sk-matrix-funded-${tokenId}.${secret}`;
    if (!TOKEN_PATTERN.test(credential)) throw new Error("Credential generator returned invalid material");
    type IssuedRow = {
      global_revision: number;
      runtime_revision: number;
      global_models: string;
      runtime_models: string;
      monthly_budget_microusd: number;
      token_id: string;
    };
    const issued = await sql<IssuedRow>`
      WITH eligible AS (
        SELECT
          runtime.machine_id,
          runtime.revision AS runtime_revision,
          runtime.allowed_model_ids AS runtime_models,
          runtime.monthly_budget_microusd,
          global_policy.revision AS global_revision,
          global_policy.allowed_model_ids AS global_models
        FROM ai_funded_runtime_policies runtime
        JOIN user_machines machine ON machine.machine_id = runtime.machine_id
        JOIN ai_funded_global_policy global_policy ON global_policy.policy_id = 'default'
        WHERE runtime.machine_id = ${identity.machineId}
          AND runtime.owner_id = ${identity.ownerId}
          AND runtime.runtime_slot = ${identity.runtimeSlot}
          AND machine.clerk_user_id = ${identity.ownerId}
          AND machine.runtime_slot = ${identity.runtimeSlot}
          AND machine.status = 'running'
          AND machine.activation_state = 'authorized'
          AND machine.deleted_at IS NULL
          AND runtime.enabled = TRUE
          AND global_policy.enabled = TRUE
          AND (runtime.expires_at IS NULL OR runtime.expires_at > ${checkedAt})
          AND NOT EXISTS (
            SELECT 1
            FROM ai_funded_credit_ledger ledger
            JOIN ai_funded_runtime_balances balance
              ON balance.machine_id = ledger.machine_id
              AND balance.owner_id = ledger.owner_id
              AND balance.runtime_slot = ledger.runtime_slot
            WHERE ledger.owner_id = runtime.owner_id
              AND ledger.machine_id = runtime.machine_id
              AND ledger.runtime_slot = runtime.runtime_slot
              AND ledger.kind = 'promotional_grant'
              AND ledger.expires_at IS NOT NULL
              AND ledger.expires_at <= ${checkedAt}
              AND balance.promotional_balance_microusd > 0
          )
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(global_policy.allowed_model_ids::jsonb) global_model(value)
            JOIN jsonb_array_elements_text(runtime.allowed_model_ids::jsonb) runtime_model(value)
              ON runtime_model.value = global_model.value
          )
      ), leased AS (
        UPDATE ai_funded_runtime_policies runtime
        SET next_issue_at = ${nextIssueAt}
        FROM eligible
        WHERE runtime.machine_id = eligible.machine_id
          AND runtime.next_issue_at <= ${checkedAt}
        RETURNING eligible.global_revision, eligible.runtime_revision,
          eligible.global_models, eligible.runtime_models, eligible.monthly_budget_microusd
      ), inserted AS (
        INSERT INTO ai_runtime_credentials (
          token_id, token_hash, owner_id, machine_id, runtime_slot,
          audience, scope, issued_at, expires_at, revoked_at
        )
        SELECT ${tokenId}, ${hashCredential(credential)}, ${identity.ownerId}, ${identity.machineId},
          ${identity.runtimeSlot}, ${FUNDED_AI_AUDIENCE}, ${FUNDED_AI_SCOPE}, ${checkedAt}, ${expiresAt}, NULL
        FROM leased
        RETURNING token_id
      )
      SELECT leased.*, inserted.token_id FROM leased CROSS JOIN inserted
    `.execute(options.db.executor);
    const row = issued.rows[0];
    if (!row) {
      const policy = await options.db.executor.selectFrom("ai_funded_runtime_policies as runtime")
        .innerJoin("ai_funded_global_policy as global_policy", (join) => join.onRef("global_policy.policy_id", "=", "global_policy.policy_id"))
        .select(["runtime.next_issue_at", "runtime.enabled as runtime_enabled", "runtime.expires_at",
          "global_policy.enabled as global_enabled"])
        .where("runtime.machine_id", "=", identity.machineId).where("runtime.owner_id", "=", identity.ownerId)
        .where("runtime.runtime_slot", "=", identity.runtimeSlot).where("global_policy.policy_id", "=", "default")
        .executeTakeFirst();
      if (policy && policy.global_enabled && policy.runtime_enabled
        && (policy.expires_at === null || Date.parse(policy.expires_at) > checked.getTime())
        && policy.next_issue_at > checkedAt) throw new AiFundedPolicyError("rate_limited");
      throw new AiFundedPolicyError(policy ? "access_disabled" : "identity_mismatch");
    }
    const allowedModelIds = intersectModels(parseModels(row.global_models), parseModels(row.runtime_models));
    return FundedAiRuntimeCredentialIssueResponseSchema.parse({
      contractVersion: 1,
      credential: { token: credential, tokenId: row.token_id, audience: FUNDED_AI_AUDIENCE, scope: FUNDED_AI_SCOPE, issuedAt: checkedAt, expiresAt },
      identity,
      policy: {
        enabled: true,
        globalRevision: row.global_revision,
        runtimeRevision: row.runtime_revision,
        allowedModelIds,
        monthlyBudgetMicrousd: Number(row.monthly_budget_microusd),
        checkedAt,
        staleAfter: new Date(checked.getTime() + policyFreshnessMs).toISOString(),
      },
    });
  }

  async function revokeRuntimeCredential(input: { tokenId: string; identity: FundedAiIdentity }): Promise<boolean> {
    const identity = IdentitySchema.parse(input.identity);
    await options.db.ready;
    const result = await options.db.executor.updateTable("ai_runtime_credentials").set({ revoked_at: now().toISOString() })
      .where("token_id", "=", input.tokenId).where("owner_id", "=", identity.ownerId)
      .where("machine_id", "=", identity.machineId).where("runtime_slot", "=", identity.runtimeSlot)
      .where("revoked_at", "is", null).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  const metering = createAiFundedMeteringRepository({
    db: options.db,
    credentialHashSecret: options.credentialHashSecret,
    now,
    policyFreshnessMs,
    reservationTtlMs,
    inFlightTtlMs,
    reservationIdFactory: options.reservationIdFactory,
  });
  return {
    getGlobalPolicy,
    getRuntimePolicy,
    updateGlobalPolicy,
    setRuntimePolicy,
    issueRuntimeCredential,
    revokeRuntimeCredential,
    ...metering,
  };
}

export type AiFundedPolicyRepository = ReturnType<typeof createAiFundedPolicyRepository>;
