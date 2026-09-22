/**
 * S08 / T041, T044: immutable run bindings and shared session generations.
 *
 * Every shared run pins the requesting actor, the executing owner (who is
 * also the payer in V1), the owner-selected source/harness/model, the policy
 * revision it was admitted under, the audience generation, the execution root
 * and its fingerprint. The binding carries no status; status lives on the
 * canonical run. A stale policy revision, an owner-only scope for a member,
 * an unavailable source or a model outside the policy refuses admission and
 * keeps the request; nothing ever falls back to another source.
 *
 * The shared session generation derives from owner source, harness, root and
 * audience generation only, never from the owner's private provider session,
 * so a changed source, root or audience starts a fresh continuation.
 */
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import {
  CanonicalChatExecutionRootRefSchema,
  CollaborationRunBindingSchema,
  CollaborationSharedHarnessSchema,
  type CanonicalChatExecutionRootRef,
  type CollaborationExecutionScopeRef,
  type CollaborationOrganizationAiSubmission,
  type CollaborationRunBinding,
} from "@matrix-os/contracts";
import type { OwnerAccountEligibility } from "./account-eligibility.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import {
  effectiveSubmitModeWithAcknowledgement,
  resolveExecutionScope,
  type CollaborationExecutionPolicyRepository,
} from "./execution-policy.js";
import { jsonb, parseJson, toIso } from "./repository-shared.js";

export type CollaborationRunBindingErrorCode =
  | "not_found"
  | "no_policy"
  | "stale_policy"
  | "owner_only"
  | "source_unavailable"
  | "model_not_allowed"
  | "conflict"
  | "unavailable";

export class CollaborationRunBindingError extends Error {
  constructor(public readonly code: CollaborationRunBindingErrorCode, message: string) {
    super(message);
    this.name = "CollaborationRunBindingError";
  }
}

const AdmissionSchema = z.object({
  runId: z.string().min(1).max(160),
  requestId: z.string().min(1).max(160),
  scopeId: z.string().uuid(),
  requestingActorId: z.string().min(1).max(128),
  expectedPolicyRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  /** Null for a standalone Chat that has no execution root (S09). */
  executionRoot: CanonicalChatExecutionRootRefSchema.nullable(),
  rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  audienceGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  harness: CollaborationSharedHarnessSchema.optional(),
  modelId: z.string().min(1).max(200).optional(),
}).strict();

export type CollaborationRunAdmission = z.infer<typeof AdmissionSchema>;

/** Stable digest of everything a shared provider session is bound to. */
export function sharedSessionKey(input: {
  source: { accessSourceId: string; providerInstanceId: string; harness: string };
  executionRoot: CanonicalChatExecutionRootRef | null;
  rootFingerprint: string;
  audienceGeneration: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    accessSourceId: input.source.accessSourceId,
    providerInstanceId: input.source.providerInstanceId,
    harness: input.source.harness,
    executionRoot: input.executionRoot,
    rootFingerprint: input.rootFingerprint,
    audienceGeneration: input.audienceGeneration,
  })).digest("hex");
}

const DEFAULT_MAX_SESSION_ENTRIES = 1_024;
/**
 * How long the fenced organization submission re-read may take while the scope
 * row is locked. The slow preflight lookup stays outside the lock; this one
 * runs under it, so it is bounded and an unresolved answer reads as `unknown`,
 * which is owner-only.
 */
const DEFAULT_AUTHORITY_RECHECK_TIMEOUT_MS = 1_000;

/**
 * Tracks one session generation per (execution scope, Chat). The generation
 * only moves forward: a different session key means a fresh authorized
 * continuation. Bounded with insertion-order eviction.
 */
export class CollaborationSharedSessionBinder {
  private readonly entries = new Map<string, { sessionKey: string; generation: number }>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_SESSION_ENTRIES;
  }

  get size(): number {
    return this.entries.size;
  }

  generationFor(input: { scopeId: string; chatId: string; sessionKey: string; floor?: number }): number {
    const key = `${input.scopeId}:${input.chatId}`;
    const current = this.entries.get(key);
    const floor = Math.max(input.floor ?? 0, current?.generation ?? 0);
    const generation = current?.sessionKey === input.sessionKey ? Math.max(current.generation, floor) : floor + 1;
    this.entries.delete(key);
    this.entries.set(key, { sessionKey: input.sessionKey, generation });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return generation;
  }
}

interface BindingRow {
  run_id: string;
  request_id: string;
  scope_id: string;
  execution_scope_id: string;
  execution_scope_kind: "project" | "standalone_chat";
  execution_resource_id: string;
  requesting_actor_id: string;
  executing_owner_id: string;
  payer_actor_id: string;
  access_source_id: string;
  provider_instance_id: string;
  harness: "codex" | "claude_code";
  model_id: string;
  policy_revision: number | string;
  audience_generation: number | string;
  execution_root: unknown;
  root_fingerprint: string;
  session_key: string;
  session_generation: number | string;
  admitted_at: Date | string;
}

function scopeRef(row: BindingRow): CollaborationExecutionScopeRef {
  return row.execution_scope_kind === "project"
    ? { kind: "project", scopeId: row.execution_scope_id, projectId: row.execution_resource_id }
    : { kind: "standalone_chat", scopeId: row.execution_scope_id, chatId: row.execution_resource_id };
}

function toBinding(row: BindingRow): CollaborationRunBinding {
  return CollaborationRunBindingSchema.parse({
    runId: row.run_id,
    requestId: row.request_id,
    scope: scopeRef(row),
    requestingActorId: row.requesting_actor_id,
    executingOwnerId: row.executing_owner_id,
    payerActorId: row.payer_actor_id,
    source: {
      accessSourceId: row.access_source_id,
      providerInstanceId: row.provider_instance_id,
      harness: row.harness,
      modelId: row.model_id,
    },
    policyRevision: String(row.policy_revision),
    audienceGeneration: String(row.audience_generation),
    executionRoot: parseJson<CanonicalChatExecutionRootRef>(row.execution_root),
    rootFingerprint: row.root_fingerprint,
    sessionGeneration: String(row.session_generation),
    admittedAt: toIso(row.admitted_at),
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

export class CollaborationRunBindingRepository {
  private readonly db: Kysely<OwnerCollaborationDatabase>;
  private readonly now: () => Date;
  private readonly policies: CollaborationExecutionPolicyRepository;
  private readonly eligibility: OwnerAccountEligibility;
  private readonly sessions: CollaborationSharedSessionBinder;
  private readonly authorityRecheckTimeoutMs: number;

  constructor(db: Kysely<OwnerCollaborationDatabase>, options: {
    now?: () => Date;
    policies: CollaborationExecutionPolicyRepository;
    eligibility: OwnerAccountEligibility;
    sessions?: CollaborationSharedSessionBinder;
    authorityRecheckTimeoutMs?: number;
  }) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.policies = options.policies;
    this.eligibility = options.eligibility;
    this.sessions = options.sessions ?? new CollaborationSharedSessionBinder();
    this.authorityRecheckTimeoutMs = Math.min(
      Math.max(options.authorityRecheckTimeoutMs ?? DEFAULT_AUTHORITY_RECHECK_TIMEOUT_MS, 10),
      5_000,
    );
  }

  async admit(rawInput: CollaborationRunAdmission): Promise<CollaborationRunBinding> {
    const input = AdmissionSchema.parse(rawInput);
    const nowIso = this.now().toISOString();
    // Preflight outside any lock: the organization AI-submission lookup and the
    // owner's snapshot read can take seconds and must never hold the scope row.
    // The transaction below re-reads the scope and policy under the lock, and
    // re-reads the organization submission mode under a hard bound, so nothing
    // this preflight saw can admit a binding after it moved.
    const preflight = await resolveExecutionScope(this.db, input.scopeId);
    if (!preflight) throw new CollaborationRunBindingError("not_found", "Execution scope not found");
    const preflightPolicy = await this.db.selectFrom("collaboration_execution_policies").selectAll()
      .where("scope_id", "=", preflight.ref.scopeId).executeTakeFirst();
    if (!preflightPolicy) throw new CollaborationRunBindingError("no_policy", "The owner has not selected an AI source");
    if (String(preflightPolicy.revision) !== input.expectedPolicyRevision) {
      throw new CollaborationRunBindingError("stale_policy", "The owner changed the execution policy");
    }
    const ownerId = preflightPolicy.owner_id;
    if (input.requestingActorId !== ownerId) {
      const effective = await this.effectiveSubmitMode({
        organizationId: preflight.scope.organization_id,
        ownerId,
        submitMode: preflightPolicy.submit_mode,
        providerTermsAcknowledged: preflightPolicy.provider_terms_acknowledged_at !== null,
      });
      if (effective !== "members") {
        throw new CollaborationRunBindingError("owner_only", "Only the owner may submit AI work on this scope");
      }
    }
    const resolved = await this.eligibility.resolveSelection(ownerId, {
      accessSourceId: preflightPolicy.access_source_id,
      providerInstanceId: preflightPolicy.provider_instance_id,
    });
    if (!resolved.ok || !resolved.available || resolved.source.harness !== preflightPolicy.harness) {
      throw new CollaborationRunBindingError("source_unavailable", "The owner's selected source is unavailable");
    }
    return this.db.transaction().execute(async (trx) => {
      const resolution = await resolveExecutionScope(trx, input.scopeId, { lock: true });
      if (!resolution) throw new CollaborationRunBindingError("not_found", "Execution scope not found");
      if (resolution.ref.scopeId !== preflight.ref.scopeId
        || Number(resolution.scope.revision) !== Number(preflight.scope.revision)
        || resolution.scope.organization_id !== preflight.scope.organization_id) {
        throw new CollaborationRunBindingError("stale_policy", "The execution scope changed during admission");
      }
      const policyRow = await trx.selectFrom("collaboration_execution_policies").selectAll()
        .where("scope_id", "=", resolution.ref.scopeId)
        .where("revision", "=", Number(input.expectedPolicyRevision))
        .forShare().executeTakeFirst();
      if (!policyRow) {
        throw new CollaborationRunBindingError("stale_policy", "The owner changed the execution policy");
      }
      if (policyRow.owner_id !== ownerId
        || policyRow.submit_mode !== preflightPolicy.submit_mode
        || (policyRow.provider_terms_acknowledged_at === null) !== (preflightPolicy.provider_terms_acknowledged_at === null)
        || policyRow.access_source_id !== preflightPolicy.access_source_id
        || policyRow.provider_instance_id !== preflightPolicy.provider_instance_id
        || policyRow.harness !== preflightPolicy.harness) {
        throw new CollaborationRunBindingError("stale_policy", "The owner changed the execution policy");
      }
      if (input.requestingActorId !== ownerId) {
        // The organization's submission mode is external state with no revision in this
        // database, so the locked policy row cannot prove it still allows member submission.
        // Re-read it here, under the admission fence, and refuse a binding the organization
        // no longer authorizes. The read is bounded so a slow platform round trip can never
        // hold the scope row, and it fails closed. This narrows the window to the remainder
        // of this transaction; an authority revoked after the commit is still S05's job.
        const fenced = await this.effectiveSubmitMode({
          organizationId: resolution.scope.organization_id,
          ownerId,
          submitMode: policyRow.submit_mode,
          providerTermsAcknowledged: policyRow.provider_terms_acknowledged_at !== null,
          bounded: true,
        });
        if (fenced !== "members") {
          throw new CollaborationRunBindingError("owner_only", "Only the owner may submit AI work on this scope");
        }
      }
      if (input.harness !== undefined && input.harness !== policyRow.harness) {
        throw new CollaborationRunBindingError("model_not_allowed", "The requested harness is not the owner's selection");
      }
      const allowed = parseJson<string[]>(policyRow.allowed_model_ids).filter((modelId) => resolved.modelIds.includes(modelId));
      const modelId = input.modelId ?? allowed[0];
      if (modelId === undefined || !allowed.includes(modelId)) {
        throw new CollaborationRunBindingError("model_not_allowed", "The requested model is not allowed by the owner");
      }
      const existing = await trx.selectFrom("collaboration_run_bindings").select("run_id")
        .where("run_id", "=", input.runId).executeTakeFirst();
      if (existing) throw new CollaborationRunBindingError("conflict", "Run already admitted");
      const source = { ...resolved.source, modelId };
      const sessionKey = sharedSessionKey({
        source, executionRoot: input.executionRoot, rootFingerprint: input.rootFingerprint, audienceGeneration: input.audienceGeneration,
      });
      // The generation is derived from the persisted latest binding, so a restart or
      // cache eviction can never reuse a generation for a changed key: the same key
      // continues the latest generation, any other key allocates strictly above it.
      const latest = await trx.selectFrom("collaboration_run_bindings").select(["session_generation", "session_key"])
        .where("scope_id", "=", input.scopeId).orderBy("session_generation", "desc").limit(1).executeTakeFirst();
      const sessionGeneration = latest === undefined
        ? 1
        : latest.session_key === sessionKey ? Number(latest.session_generation) : Number(latest.session_generation) + 1;
      this.sessions.generationFor({ scopeId: resolution.ref.scopeId, chatId: input.scopeId, sessionKey, floor: sessionGeneration - 1 });
      try {
        await trx.insertInto("collaboration_run_bindings").values({
          run_id: input.runId,
          request_id: input.requestId,
          scope_id: input.scopeId,
          execution_scope_id: resolution.ref.scopeId,
          execution_scope_kind: resolution.ref.kind,
          execution_resource_id: resolution.ref.kind === "project" ? resolution.ref.projectId : resolution.ref.chatId,
          requesting_actor_id: input.requestingActorId,
          executing_owner_id: ownerId,
          payer_actor_id: ownerId,
          access_source_id: source.accessSourceId,
          provider_instance_id: source.providerInstanceId,
          harness: source.harness,
          model_id: modelId,
          policy_revision: Number(policyRow.revision),
          audience_generation: Number(input.audienceGeneration),
          execution_root: jsonb(input.executionRoot),
          root_fingerprint: input.rootFingerprint,
          session_key: sessionKey,
          session_generation: sessionGeneration,
          admitted_at: nowIso,
        }).execute();
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw new CollaborationRunBindingError("conflict", "Run already admitted");
        throw error;
      }
      const row = await trx.selectFrom("collaboration_run_bindings").selectAll()
        .where("run_id", "=", input.runId).executeTakeFirstOrThrow();
      return toBinding(row);
    });
  }

  async get(runId: string): Promise<CollaborationRunBinding | null> {
    const row = await this.db.selectFrom("collaboration_run_bindings").selectAll()
      .where("run_id", "=", runId).executeTakeFirst();
    return row ? toBinding(row) : null;
  }

  async list(scopeId: string): Promise<CollaborationRunBinding[]> {
    const rows = await this.db.selectFrom("collaboration_run_bindings").selectAll()
      .where("scope_id", "=", scopeId).orderBy("admitted_at").orderBy("run_id").limit(200).execute();
    return rows.map(toBinding);
  }

  private async effectiveSubmitMode(input: {
    organizationId: string | null;
    ownerId: string;
    submitMode: "follow_organization" | "owner_only";
    providerTermsAcknowledged: boolean;
    /** Set while the scope row is locked: the lookup may not outlast the fence. */
    bounded?: boolean;
  }): Promise<"members" | "owner_only"> {
    const lookup = this.policies.organizationAiSubmissionFor(input.organizationId, input.ownerId);
    const organizationAiSubmission = input.bounded === true
      ? await this.boundedAiSubmission(lookup)
      : await lookup;
    return effectiveSubmitModeWithAcknowledgement({ organizationAiSubmission, ...input });
  }

  /** An unresolved or failed lookup reads as `unknown`, which resolves to owner-only. */
  private async boundedAiSubmission(
    lookup: Promise<CollaborationOrganizationAiSubmission>,
  ): Promise<CollaborationOrganizationAiSubmission> {
    const settled = lookup.catch((error: unknown) => {
      console.warn("[collaboration] fenced organization AI submission lookup failed",
        error instanceof Error ? error.name : "UnknownError");
      return "unknown" as const;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        settled,
        new Promise<CollaborationOrganizationAiSubmission>((resolve) => {
          timer = setTimeout(() => resolve("unknown"), this.authorityRecheckTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
