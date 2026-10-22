import { FUNDED_AI_AUDIENCE, FUNDED_AI_SCOPE, JEV_MODEL_ID, FundedAiRuntimeCredentialIssueResponseSchema,
  type FundedAiIdentity, type FundedAiRequestClass, type FundedAiRuntimeCredentialIssueResponse } from '@matrix-os/contracts';
import { sql } from 'kysely';
import type { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import { AiFundedPolicyError } from './ai-funded-policy-errors.js';
const TOKEN_PATTERN = /^sk-matrix-funded-([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})\.([A-Za-z0-9_-]{43})$/;
/** Legacy/Jev extraction only: original CTE, class fallback, policy/error and response semantics unchanged. */
export function createFundedCredentialIssuer(options: { db: PlatformDB; now: () => Date; tokenIdFactory: () => string;
  tokenSecretFactory: () => string; credentialTtlMs: number; issueCooldownMs: number; policyFreshnessMs: number;
  hashCredential: (value: string) => string; identitySchema: z.ZodType<FundedAiIdentity>;
  parseModels: (value: string) => string[]; intersectModels: (left: string[], right: string[]) => string[] }) {
  const { now, tokenIdFactory, tokenSecretFactory, credentialTtlMs, issueCooldownMs, policyFreshnessMs,
    hashCredential, parseModels, intersectModels } = options; const IdentitySchema = options.identitySchema;
  async function issueCredential(
    identityInput: FundedAiIdentity,
    probe = false,
    classInput?: { requestClass?: FundedAiRequestClass },
  ): Promise<FundedAiRuntimeCredentialIssueResponse> {
    const requestClass: FundedAiRequestClass = classInput?.requestClass ?? "interactive";
    // Each class has its own cooldown so a background lease never delays an interactive one.
    const cooldownColumn = requestClass === "background" ? "next_background_issue_at" : "next_issue_at";
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
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(global_policy.allowed_model_ids::jsonb) global_model(value)
            JOIN jsonb_array_elements_text(runtime.allowed_model_ids::jsonb) runtime_model(value)
              ON runtime_model.value = global_model.value
          )
      ), leased AS (
        ${probe ? sql`
          SELECT eligible.* FROM eligible
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(eligible.global_models::jsonb) model(value) WHERE model.value = ${JEV_MODEL_ID})
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(eligible.runtime_models::jsonb) model(value) WHERE model.value = ${JEV_MODEL_ID})
        ` : sql`
        UPDATE ai_funded_runtime_policies runtime
        SET ${sql.ref(cooldownColumn)} = ${nextIssueAt}
        FROM eligible
        WHERE runtime.machine_id = eligible.machine_id
          AND ${sql.ref(`runtime.${cooldownColumn}`)} <= ${checkedAt}
        RETURNING eligible.global_revision, eligible.runtime_revision,
          eligible.global_models, eligible.runtime_models, eligible.monthly_budget_microusd
        `}
      ), inserted AS (
        INSERT INTO ai_runtime_credentials (
          token_id, token_hash, owner_id, machine_id, runtime_slot,
          audience, scope, issued_at, expires_at, revoked_at, request_class
        )
        SELECT ${tokenId}, ${hashCredential(credential)}, ${identity.ownerId}, ${identity.machineId},
          ${identity.runtimeSlot}, ${FUNDED_AI_AUDIENCE}, ${FUNDED_AI_SCOPE}, ${checkedAt}, ${expiresAt}, NULL, ${requestClass}
        FROM leased
        RETURNING token_id
      )
      SELECT leased.*, inserted.token_id FROM leased CROSS JOIN inserted
    `.execute(options.db.executor);
    const row = issued.rows[0];
    if (!row) {
      const policy = await options.db.executor.selectFrom("ai_funded_runtime_policies as runtime")
        .innerJoin("ai_funded_global_policy as global_policy", (join) => join.onRef("global_policy.policy_id", "=", "global_policy.policy_id"))
        .select(["runtime.next_issue_at", "runtime.next_background_issue_at", "runtime.enabled as runtime_enabled", "runtime.expires_at",
          "global_policy.enabled as global_enabled"])
        .where("runtime.machine_id", "=", identity.machineId).where("runtime.owner_id", "=", identity.ownerId)
        .where("runtime.runtime_slot", "=", identity.runtimeSlot).where("global_policy.policy_id", "=", "default")
        .executeTakeFirst();
      if (policy && policy.global_enabled && policy.runtime_enabled
        && (policy.expires_at === null || Date.parse(policy.expires_at) > checked.getTime())
        && (requestClass === "background" ? policy.next_background_issue_at : policy.next_issue_at) > checkedAt) {
        throw new AiFundedPolicyError("rate_limited");
      }
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
      // Echo only an explicitly requested class; legacy gateways parse this response strictly.
      ...(classInput?.requestClass ? { requestClass } : {}),
    });
  }

  return issueCredential;
}
