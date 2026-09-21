/**
 * S08 / T041, T043: one owner-selected execution policy per execution scope.
 *
 * An execution scope is a project scope or a standalone Chat scope. A Chat
 * shared inside a project has no policy of its own and resolves to the
 * project's. The scope owner is the only actor who may set the policy; for a
 * standalone Chat that owner takes every role the spec gives the project
 * owner. The effective submit mode is organization metadata AND policy, both
 * fail-closed to owner-only, and it is re-read on every resolution rather
 * than frozen into the row. Migration 10 also creates the immutable run
 * binding table consumed by run-account-binding.ts.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import {
  CollaborationExecutionPolicyPutRequestSchema,
  CollaborationExecutionPolicySchema,
  resolveCollaborationEffectiveSubmitMode,
  type CollaborationEffectiveSubmitMode,
  type CollaborationExecutionPolicy,
  type CollaborationExecutionPolicyPutRequest,
  type CollaborationExecutionScopeRef,
  type CollaborationOrganizationAiSubmission,
  type CollaborationSharedHarness,
  type CollaborationSubmitMode,
} from "@matrix-os/contracts";
import type { OwnerAccountEligibility } from "./account-eligibility.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import {
  appendMutationRecords,
  CollaborationRepositoryError,
  jsonb,
  OPERATION_RETENTION_MS,
  parseJson,
  readOperationReplay,
  requireAcceptedOwner,
  toIso,
  writeOperation,
  type ScopeRow,
} from "./repository-shared.js";

export const COLLABORATION_EXECUTION_POLICY_MIGRATION_VERSION = 10;
const OPERATION_KIND = "execution_policy";

export async function migrateExecutionPoliciesV10(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_execution_policies (
      scope_id UUID PRIMARY KEY REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'standalone_chat')),
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      access_source_id TEXT NOT NULL CHECK (char_length(access_source_id) BETWEEN 1 AND 128),
      provider_instance_id TEXT NOT NULL CHECK (char_length(provider_instance_id) BETWEEN 1 AND 128),
      harness TEXT NOT NULL CHECK (harness IN ('codex', 'claude_code')),
      submit_mode TEXT NOT NULL CHECK (submit_mode IN ('follow_organization', 'owner_only')),
      provider_terms_acknowledged_at TIMESTAMPTZ,
      allowed_model_ids JSONB NOT NULL,
      concurrency INTEGER CHECK (concurrency IS NULL OR concurrency BETWEEN 1 AND 8),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_run_bindings (
      run_id TEXT PRIMARY KEY CHECK (char_length(run_id) BETWEEN 1 AND 160),
      request_id TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 160),
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      execution_scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      execution_scope_kind TEXT NOT NULL CHECK (execution_scope_kind IN ('project', 'standalone_chat')),
      execution_resource_id TEXT NOT NULL CHECK (char_length(execution_resource_id) BETWEEN 1 AND 160),
      requesting_actor_id TEXT NOT NULL CHECK (char_length(requesting_actor_id) BETWEEN 1 AND 128),
      executing_owner_id TEXT NOT NULL CHECK (char_length(executing_owner_id) BETWEEN 1 AND 128),
      payer_actor_id TEXT NOT NULL CHECK (char_length(payer_actor_id) BETWEEN 1 AND 128),
      access_source_id TEXT NOT NULL CHECK (char_length(access_source_id) BETWEEN 1 AND 128),
      provider_instance_id TEXT NOT NULL CHECK (char_length(provider_instance_id) BETWEEN 1 AND 128),
      harness TEXT NOT NULL CHECK (harness IN ('codex', 'claude_code')),
      model_id TEXT NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 200),
      policy_revision BIGINT NOT NULL CHECK (policy_revision > 0),
      audience_generation BIGINT NOT NULL CHECK (audience_generation >= 0),
      execution_root JSONB NOT NULL,
      root_fingerprint TEXT NOT NULL CHECK (root_fingerprint ~ '^[a-f0-9]{64}$'),
      session_generation BIGINT NOT NULL CHECK (session_generation > 0),
      admitted_at TIMESTAMPTZ NOT NULL
    )
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_run_bindings_scope
    ON collaboration_run_bindings(scope_id, admitted_at)
  `.execute(trx);
  await sql`
    INSERT INTO collaboration_schema_migrations (version)
    VALUES (${COLLABORATION_EXECUTION_POLICY_MIGRATION_VERSION})
    ON CONFLICT (version) DO NOTHING
  `.execute(trx);
}

export type CollaborationExecutionPolicyErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "invalid_source"
  | "provider_terms_required"
  | "unavailable";

export class CollaborationExecutionPolicyError extends Error {
  constructor(public readonly code: CollaborationExecutionPolicyErrorCode, message: string) {
    super(message);
    this.name = "CollaborationExecutionPolicyError";
  }
}

export interface OrganizationAiSubmissionSource {
  /** Current `collaboration.aiSubmission` projection for the organization; `unknown` when it cannot be read. */
  resolve(organizationId: string): Promise<CollaborationOrganizationAiSubmission>;
}

/** Fail-closed default until a projection is registered: every organization reads as `unknown`. */
export const unknownOrganizationAiSubmission: OrganizationAiSubmissionSource = {
  async resolve() { return "unknown"; },
};

export interface ExecutionScopeResolution {
  ref: CollaborationExecutionScopeRef;
  scope: ScopeRow;
}

type Executor = Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>;

async function loadScope(db: Executor, scopeId: string, lock: boolean): Promise<ScopeRow | null> {
  let query = db.selectFrom("collaboration_scopes").selectAll()
    .where("id", "=", scopeId)
    .where("deleted_at", "is", null)
    .where("lifecycle", "!=", "deleted");
  if (lock) query = query.forUpdate();
  return (await query.executeTakeFirst()) ?? null;
}

/**
 * Resolves the execution scope for any collaboration scope: a project is its
 * own execution scope, a Chat with a parent project resolves to that project,
 * a Chat without one is a standalone Chat. Terminals have no execution scope.
 */
export async function resolveExecutionScope(
  db: Executor,
  scopeId: string,
  options: { lock?: boolean } = {},
): Promise<ExecutionScopeResolution | null> {
  const scope = await loadScope(db, scopeId, options.lock === true);
  if (!scope) return null;
  if (scope.kind === "project") {
    return { ref: { kind: "project", scopeId: scope.id, projectId: scope.resource_id }, scope };
  }
  if (scope.kind !== "chat") return null;
  if (scope.parent_scope_id === null) {
    return { ref: { kind: "standalone_chat", scopeId: scope.id, chatId: scope.resource_id }, scope };
  }
  const parent = await loadScope(db, scope.parent_scope_id, options.lock === true);
  if (!parent || parent.kind !== "project") return null;
  return { ref: { kind: "project", scopeId: parent.id, projectId: parent.resource_id }, scope: parent };
}

interface PolicyRow {
  scope_id: string;
  scope_kind: "project" | "standalone_chat";
  owner_id: string;
  access_source_id: string;
  provider_instance_id: string;
  harness: CollaborationSharedHarness;
  submit_mode: CollaborationSubmitMode;
  provider_terms_acknowledged_at: Date | string | null;
  allowed_model_ids: unknown;
  concurrency: number | null;
  revision: number | string;
  updated_at: Date | string;
}

export class CollaborationExecutionPolicyRepository {
  private readonly db: Kysely<OwnerCollaborationDatabase>;
  private readonly now: () => Date;
  private readonly organizationAiSubmission: OrganizationAiSubmissionSource;
  private readonly eligibility: OwnerAccountEligibility;

  constructor(db: Kysely<OwnerCollaborationDatabase>, options: {
    now?: () => Date;
    organizationAiSubmission?: OrganizationAiSubmissionSource;
    eligibility: OwnerAccountEligibility;
  }) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.organizationAiSubmission = options.organizationAiSubmission ?? unknownOrganizationAiSubmission;
    this.eligibility = options.eligibility;
  }

  /** The policy governing a scope, or null when its execution scope has none. */
  async resolve(scopeId: string): Promise<CollaborationExecutionPolicy | null> {
    const resolution = await resolveExecutionScope(this.db, scopeId);
    if (!resolution) return null;
    const row = await this.db.selectFrom("collaboration_execution_policies").selectAll()
      .where("scope_id", "=", resolution.ref.scopeId).executeTakeFirst();
    if (!row) return null;
    return this.project(row, resolution);
  }

  /** Fail-closed: no policy, no organization context or an unreadable projection all read as owner-only. */
  async effectiveSubmitMode(scopeId: string): Promise<CollaborationEffectiveSubmitMode> {
    const policy = await this.resolve(scopeId);
    return policy?.effectiveSubmitMode ?? "owner_only";
  }

  async put(input: {
    scopeId: string;
    actorId: string;
    request: CollaborationExecutionPolicyPutRequest;
    payloadHash: string;
  }): Promise<CollaborationExecutionPolicy> {
    const request = CollaborationExecutionPolicyPutRequestSchema.parse(input.request);
    const nowIso = this.now().toISOString();
    return this.db.transaction().execute(async (trx) => {
      const resolution = await resolveExecutionScope(trx, input.scopeId, { lock: true });
      if (!resolution) throw new CollaborationExecutionPolicyError("not_found", "Execution scope not found");
      if (resolution.ref.scopeId !== input.scopeId) {
        throw new CollaborationExecutionPolicyError("conflict", "A Chat inside a project uses the project's policy");
      }
      const { scope, ref } = resolution;
      try {
        await requireAcceptedOwner(trx, scope.id, input.actorId);
      } catch (error: unknown) {
        if (error instanceof CollaborationRepositoryError) {
          throw new CollaborationExecutionPolicyError("forbidden", "Only the scope owner sets the execution policy");
        }
        throw error;
      }
      const replayKey = {
        scopeId: scope.id, actorId: input.actorId, clientRequestId: request.clientRequestId, payloadHash: input.payloadHash,
      };
      const replay = await readOperationReplay<CollaborationExecutionPolicy>(trx, replayKey, OPERATION_KIND);
      if (replay) return CollaborationExecutionPolicySchema.parse(replay);

      const resolved = await this.eligibility.resolveSelection(scope.owner_id, request);
      if (!resolved.ok) throw new CollaborationExecutionPolicyError("invalid_source", "Selected source is not available to the owner");
      if (request.allowedModelIds.some((modelId) => !resolved.modelIds.includes(modelId))) {
        throw new CollaborationExecutionPolicyError("invalid_source", "Model is not served by the selected source");
      }
      const organizationAiSubmission = await this.readOrganizationAiSubmission(scope.organization_id);
      const effective = resolveCollaborationEffectiveSubmitMode({ organizationAiSubmission, submitMode: request.submitMode });
      if (effective === "members" && !request.acknowledgeProviderTerms) {
        throw new CollaborationExecutionPolicyError("provider_terms_required", "Member submission needs the provider-terms acknowledgement");
      }

      const existing = await trx.selectFrom("collaboration_execution_policies").selectAll()
        .where("scope_id", "=", scope.id).forUpdate().executeTakeFirst();
      const expectedRevision = Number(request.expectedRevision);
      const currentRevision = existing ? Number(existing.revision) : 0;
      if (expectedRevision !== currentRevision) {
        throw new CollaborationExecutionPolicyError("conflict", "Execution policy revision changed");
      }
      const nextRevision = currentRevision + 1;
      const values = {
        scope_kind: ref.kind,
        owner_id: scope.owner_id,
        access_source_id: resolved.source.accessSourceId,
        provider_instance_id: resolved.source.providerInstanceId,
        harness: resolved.source.harness,
        submit_mode: request.submitMode,
        provider_terms_acknowledged_at: request.acknowledgeProviderTerms ? nowIso : null,
        allowed_model_ids: jsonb(request.allowedModelIds),
        concurrency: request.concurrency ?? null,
        revision: nextRevision,
        updated_at: nowIso,
      };
      if (existing) {
        const updated = await trx.updateTable("collaboration_execution_policies").set(values)
          .where("scope_id", "=", scope.id).where("revision", "=", currentRevision)
          .returning("revision").executeTakeFirst();
        if (!updated) throw new CollaborationExecutionPolicyError("conflict", "Execution policy revision changed");
      } else {
        await trx.insertInto("collaboration_execution_policies")
          .values({ scope_id: scope.id, created_at: nowIso, ...values }).execute();
      }
      const row = await trx.selectFrom("collaboration_execution_policies").selectAll()
        .where("scope_id", "=", scope.id).executeTakeFirstOrThrow();
      const policy = await this.project(row, resolution, organizationAiSubmission);
      await appendMutationRecords(trx, {
        scope, actorId: input.actorId, action: "execution_policy_updated", recipients: [],
        discoveryState: "accepted", publishDirectory: false, now: nowIso,
      });
      await writeOperation(
        trx,
        { ...replayKey, expectedRevision },
        OPERATION_KIND,
        scope,
        policy,
        nowIso,
        new Date(this.now().getTime() + OPERATION_RETENTION_MS).toISOString(),
      );
      return policy;
    });
  }

  /** Live organization metadata; null context or a failed lookup reads as `unknown` (owner-only). */
  async organizationAiSubmissionFor(organizationId: string | null): Promise<CollaborationOrganizationAiSubmission> {
    return this.readOrganizationAiSubmission(organizationId);
  }

  private async readOrganizationAiSubmission(organizationId: string | null): Promise<CollaborationOrganizationAiSubmission> {
    if (organizationId === null) return "unknown";
    try {
      return await this.organizationAiSubmission.resolve(organizationId);
    } catch (error: unknown) {
      console.warn("[collaboration] organization AI submission lookup failed",
        error instanceof Error ? error.name : "UnknownError");
      return "unknown";
    }
  }

  private async project(
    row: PolicyRow,
    resolution: ExecutionScopeResolution,
    organizationAiSubmission?: CollaborationOrganizationAiSubmission,
  ): Promise<CollaborationExecutionPolicy> {
    const aiSubmission = organizationAiSubmission
      ?? await this.readOrganizationAiSubmission(resolution.scope.organization_id);
    return CollaborationExecutionPolicySchema.parse({
      scope: resolution.ref,
      ownerId: row.owner_id,
      source: { accessSourceId: row.access_source_id, providerInstanceId: row.provider_instance_id, harness: row.harness },
      submitMode: row.submit_mode,
      organizationAiSubmission: aiSubmission,
      effectiveSubmitMode: resolveCollaborationEffectiveSubmitMode({ organizationAiSubmission: aiSubmission, submitMode: row.submit_mode }),
      providerTermsAcknowledgedAt: row.provider_terms_acknowledged_at === null ? null : toIso(row.provider_terms_acknowledged_at),
      allowedModelIds: parseJson<string[]>(row.allowed_model_ids),
      ...(row.concurrency === null ? {} : { concurrency: row.concurrency }),
      revision: String(row.revision),
      updatedAt: toIso(row.updated_at),
    });
  }
}
