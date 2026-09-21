/**
 * S08 / T040: one owner-selected AI source per execution scope.
 *
 * Runs against a dedicated PostgreSQL server when MATRIX_TEST_POSTGRES_URL is
 * set and against the PGlite fixture otherwise. Provider eligibility is never
 * enforced: the owner's selected V3 source is used exactly as the owner's own
 * runs use it, members never bring an account, and every failure path keeps
 * the request instead of falling back to another source.
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CollaborationExecutionPolicySchema,
  CollaborationReadinessSchema,
  CollaborationRunBindingSchema,
  CollaborationRunSubmitRequestSchema,
  type AiProviderSnapshotV3,
} from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import {
  OwnerAccountEligibility,
  createOwnerSourceReadinessProbes,
  sharedHarnessForDriver,
  type OwnerProviderSnapshotSource,
} from "../../packages/gateway/src/collaboration/account-eligibility.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  COLLABORATION_EXECUTION_POLICY_MIGRATION_VERSION,
  CollaborationExecutionPolicyError,
  CollaborationExecutionPolicyRepository,
  type OrganizationAiSubmissionSource,
} from "../../packages/gateway/src/collaboration/execution-policy.js";
import { registerExecutionPolicyRoutes } from "../../packages/gateway/src/collaboration/execution-policy-routes.js";
import {
  createOrganizationPrecondition,
  type OrganizationMembershipSource,
} from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { evaluateCollaborationReadiness } from "../../packages/gateway/src/collaboration/readiness-evaluator.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import {
  CollaborationRunBindingError,
  CollaborationRunBindingRepository,
  CollaborationSharedSessionBinder,
  sharedSessionKey,
} from "../../packages/gateway/src/collaboration/run-account-binding.js";
import { SharedChatRunPreparationError } from "../../packages/gateway/src/chat/shared-execution-coordinator.js";
import { SharedRunOwnerSource } from "../../packages/gateway/src/collaboration/shared-run-owner-source.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const NOW = "2026-09-20T12:00:00.000Z";
const ORG = "org_collaboration_primary";
const PROJECT_SCOPE = collaborationIds.scope;
const PROJECT_CHAT_SCOPE = "10000000-0000-4000-8000-000000000002";
const STANDALONE_CHAT_SCOPE = "10000000-0000-4000-8000-000000000003";
const STANDALONE_OWNER = "user_collaboration_chat_owner";
const KEY = "0123456789abcdef0123456789abcdef";
const hasRealPostgres = Boolean(process.env.MATRIX_TEST_POSTGRES_URL);

const members = new Map<string, Set<string>>();
let aiSubmission: "members" | "owner_only" | "absent" | "unknown" = "members";
let counter = 0;
function uuid(): string {
  counter += 1;
  return `8${String(counter).padStart(7, "0")}-0000-4000-8000-000000000000`;
}
function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function membershipSource(now: () => Date): OrganizationMembershipSource {
  return {
    async assertMembership({ organizationId, actorId }) {
      return members.get(organizationId)?.has(actorId)
        ? { member: true, expiresAt: new Date(now().getTime() + 20_000).toISOString() }
        : { member: false };
    },
  };
}

/** Runs inside the organization AI submission lookup so tests can observe when, relative to locks, it happens. */
let aiSubmissionProbe: (() => Promise<void>) | undefined;
const organizationAiSubmission: OrganizationAiSubmissionSource = {
  async resolve() {
    await aiSubmissionProbe?.();
    return aiSubmission;
  },
};

function readiness(state: AiProviderSnapshotV3["accessSources"][number]["state"] = "ready") {
  return { state, checkedAt: NOW, staleAfter: null, action: "none" as const, safeReason: null };
}

/** Owner snapshot: a Claude subscription source and an OpenAI API-key source for Codex. */
function ownerSnapshot(overrides: Partial<AiProviderSnapshotV3> = {}): AiProviderSnapshotV3 {
  return {
    contractVersion: 3,
    revision: 4,
    refreshedAt: NOW,
    accessSources: [
      { ...readiness(), id: "owner_anthropic_profile", displayName: "Claude profile", fundingKind: "owner_account", vendor: "anthropic", accountLabel: "owner@example.com", eligibleModelIds: ["claude-opus-5"], policyVersion: "policy-1" },
      { ...readiness(), id: "src_claude_sub", displayName: "Claude subscription", fundingKind: "owner_account", vendor: "anthropic", accountLabel: "owner@example.com", eligibleModelIds: ["claude-opus-5", "claude-sonnet-5"], policyVersion: "policy-1" },
      { ...readiness(), id: "src_openai_key", displayName: "OpenAI API key", fundingKind: "owner_api_key", vendor: "openai", accountLabel: null, eligibleModelIds: ["gpt-5.6"], policyVersion: "policy-1" },
    ],
    accounts: [
      { ...readiness(), id: "acct_claude", vendor: "anthropic", authMethod: "oauth_pkce", accountLabel: "owner@example.com" },
      { ...readiness(), id: "acct_openai", vendor: "openai", authMethod: "api_key", accountLabel: null },
    ],
    drivers: [],
    instances: [
      { id: "inst_claude_profile", driverId: "claude_code", vendor: "anthropic", accountId: "acct_claude", accessSourceId: "owner_anthropic_profile", label: "Claude Code (profile)", readiness: readiness(), capabilitySnapshot: [], modelIds: ["claude-opus-5"], defaultModelId: "claude-opus-5", catalogVersion: "catalog-1" },
      { id: "inst_claude", driverId: "claude_code", vendor: "anthropic", accountId: "acct_claude", accessSourceId: "src_claude_sub", label: "Claude Code", readiness: readiness(), capabilitySnapshot: [], modelIds: ["claude-opus-5", "claude-sonnet-5"], defaultModelId: "claude-opus-5", catalogVersion: "catalog-1" },
      { id: "inst_codex", driverId: "codex", vendor: "openai", accountId: "acct_openai", accessSourceId: "src_openai_key", label: "Codex", readiness: readiness(), capabilitySnapshot: [], modelIds: ["gpt-5.6"], defaultModelId: "gpt-5.6", catalogVersion: "catalog-1" },
      { id: "inst_hermes", driverId: "hermes", vendor: "openrouter", accountId: null, accessSourceId: "src_openai_key", label: "Hermes", readiness: readiness(), capabilitySnapshot: [], modelIds: ["gpt-5.6"], defaultModelId: null, catalogVersion: "catalog-1" },
    ],
    models: [],
    active: { providerInstanceId: "inst_claude", accessSourceId: "src_claude_sub", modelId: "claude-opus-5" },
    ...overrides,
  };
}

/** The owner snapshot with one access source moved to a non-ready state (exhausted, expired, disabled...). */
function withSourceState(id: string, state: "expired" | "unavailable" | "disabled") {
  const base = ownerSnapshot();
  return ownerSnapshot({
    accessSources: base.accessSources.map((source) => source.id === id
      ? { ...source, ...readiness(state), action: state === "expired" ? "connect" as const : "retry" as const, safeReason: state === "expired" ? "auth" as const : "provider_unavailable" as const }
      : source),
  });
}

const CLAUDE = { accessSourceId: "src_claude_sub", providerInstanceId: "inst_claude" };
const CODEX = { accessSourceId: "src_openai_key", providerInstanceId: "inst_codex" };
const ROOT = { kind: "project" as const, projectId: "project_collaboration_primary" };

describe("S08 owner-selected AI source", () => {
  let fixture: CollaborationTestDatabase;
  let policies: CollaborationExecutionPolicyRepository;
  let bindings: CollaborationRunBindingRepository;
  let eligibility: OwnerAccountEligibility;
  let snapshot: AiProviderSnapshotV3;
  let clock = Date.parse(NOW);
  const now = () => new Date(clock);
  const snapshots: OwnerProviderSnapshotSource = { async getSnapshotV3() { return snapshot; } };

  beforeEach(async () => {
    clock = Date.parse(NOW);
    aiSubmission = "members";
    aiSubmissionProbe = undefined;
    snapshot = ownerSnapshot();
    members.set(ORG, new Set([collaborationActors.owner, collaborationActors.editor, collaborationActors.viewer, STANDALONE_OWNER]));
    fixture = hasRealPostgres ? await createRealCollaborationTestDatabase() : await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    eligibility = new OwnerAccountEligibility({ snapshots });
    policies = new CollaborationExecutionPolicyRepository(fixture.db, { now, organizationAiSubmission, eligibility });
    bindings = new CollaborationRunBindingRepository(fixture.db, { now, policies, eligibility });
    await seedScopes(fixture);
  });

  afterEach(async () => {
    if (fixture) await fixture.destroy();
  });

  function putRequest(source = CLAUDE, extra: Record<string, unknown> = {}) {
    return {
      clientRequestId: uuid(),
      expectedRevision: "0",
      ...source,
      submitMode: "follow_organization" as const,
      acknowledgeProviderTerms: true,
      allowedModelIds: ["claude-opus-5"],
      ...extra,
    };
  }

  async function ownerPolicy(scopeId = PROJECT_SCOPE, actorId = collaborationActors.owner, source = CLAUDE, extra: Record<string, unknown> = {}) {
    return policies.put({ scopeId, actorId, request: putRequest(source, extra), payloadHash: sha(scopeId + counter) });
  }

  describe("migration", () => {
    it("records the execution policy migration after S04's grants", async () => {
      expect(COLLABORATION_EXECUTION_POLICY_MIGRATION_VERSION).toBe(10);
      const rows = await fixture.db.selectFrom("collaboration_schema_migrations").select("version").orderBy("version").execute();
      expect(rows.map((row) => Number(row.version))).toContain(10);
    });
  });

  describe("policy selection", () => {
    it("stores one owner-selected V3 source per project scope with the effective submit mode", async () => {
      const policy = await ownerPolicy();
      expect(CollaborationExecutionPolicySchema.parse(policy)).toEqual(policy);
      expect(policy.scope).toEqual({ kind: "project", scopeId: PROJECT_SCOPE, projectId: "project_collaboration_primary" });
      expect(policy.ownerId).toBe(collaborationActors.owner);
      expect(policy.source).toEqual({ ...CLAUDE, harness: "claude_code" });
      expect(policy.organizationAiSubmission).toBe("members");
      expect(policy.effectiveSubmitMode).toBe("members");
      expect(policy.providerTermsAcknowledgedAt).toBe(NOW);
      expect(policy.revision).toBe("1");
    });

    it("lets the owner change the source with a conditional write and rejects a stale revision", async () => {
      const first = await ownerPolicy();
      const second = await policies.put({
        scopeId: PROJECT_SCOPE, actorId: collaborationActors.owner, payloadHash: sha("second"),
        request: putRequest(CODEX, { expectedRevision: first.revision, allowedModelIds: ["gpt-5.6"] }),
      });
      expect(second.source).toEqual({ ...CODEX, harness: "codex" });
      expect(second.revision).toBe("2");
      await expect(policies.put({
        scopeId: PROJECT_SCOPE, actorId: collaborationActors.owner, payloadHash: sha("stale"),
        request: putRequest(CLAUDE, { expectedRevision: first.revision }),
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it.skipIf(!hasRealPostgres)("resolves the owner's source and the organization policy outside the scope lock", async () => {
      // A second pool connection probes the scope row: NOWAIT fails with 55P03 while put() holds FOR UPDATE.
      const observed: string[] = [];
      const probe = async (label: string) => {
        try {
          await fixture.db.selectFrom("collaboration_scopes").select("id").where("id", "=", PROJECT_SCOPE).forUpdate().noWait().execute();
          observed.push(`${label}:free`);
        } catch (error: unknown) {
          observed.push(`${label}:${(error as { code?: string }).code === "55P03" ? "locked" : "error"}`);
        }
      };
      const resolveSelection = eligibility.resolveSelection.bind(eligibility);
      vi.spyOn(eligibility, "resolveSelection").mockImplementation(async (...args) => { await probe("eligibility"); return resolveSelection(...args); });
      const resolveOrganization = organizationAiSubmission.resolve;
      vi.spyOn(organizationAiSubmission, "resolve").mockImplementation(async (...args) => { await probe("organization"); return resolveOrganization(...args); });
      try {
        await expect(ownerPolicy()).resolves.toMatchObject({ revision: "1" });
        expect(observed).toEqual(["eligibility:free", "organization:free"]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("rejects the write when the scope changed while the source was being resolved", async () => {
      const resolveSelection = eligibility.resolveSelection.bind(eligibility);
      vi.spyOn(eligibility, "resolveSelection").mockImplementation(async (...args) => {
        await fixture.db.updateTable("collaboration_scopes").set({ revision: 7 }).where("id", "=", PROJECT_SCOPE).execute();
        return resolveSelection(...args);
      });
      try {
        await expect(ownerPolicy()).rejects.toMatchObject({ code: "conflict" });
        expect(await policies.resolve(PROJECT_SCOPE)).toBeNull();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("replays an identical client request and rejects a different payload under the same id", async () => {
      const request = putRequest();
      const first = await policies.put({ scopeId: PROJECT_SCOPE, actorId: collaborationActors.owner, request, payloadHash: sha("same") });
      const replay = await policies.put({ scopeId: PROJECT_SCOPE, actorId: collaborationActors.owner, request, payloadHash: sha("same") });
      expect(replay).toEqual(first);
      await expect(policies.put({
        scopeId: PROJECT_SCOPE, actorId: collaborationActors.owner, payloadHash: sha("different"),
        request: { ...request, allowedModelIds: ["claude-sonnet-5"] },
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it("only the scope owner may set the policy; a contributor is refused", async () => {
      await expect(ownerPolicy(PROJECT_SCOPE, collaborationActors.editor)).rejects.toMatchObject({ code: "forbidden" });
      expect(await policies.resolve(PROJECT_SCOPE)).toBeNull();
    });

    it("rejects a source the owner does not have, an unsupported harness and an unlisted model", async () => {
      await expect(ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, { accessSourceId: "src_missing", providerInstanceId: "inst_claude" }))
        .rejects.toMatchObject({ code: "invalid_source" });
      await expect(ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, { accessSourceId: "src_openai_key", providerInstanceId: "inst_hermes" }))
        .rejects.toMatchObject({ code: "invalid_source" });
      await expect(ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, CLAUDE, { allowedModelIds: ["gpt-5.6"] }))
        .rejects.toMatchObject({ code: "invalid_source" });
      expect(sharedHarnessForDriver("claude_code")).toBe("claude_code");
      expect(sharedHarnessForDriver("codex")).toBe("codex");
      expect(sharedHarnessForDriver("hermes")).toBeNull();
    });

    it("requires the owner's provider-terms acknowledgement before members may submit", async () => {
      await expect(ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, CLAUDE, { acknowledgeProviderTerms: false }))
        .rejects.toMatchObject({ code: "provider_terms_required" });
      const ownerOnly = await ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, CLAUDE, { acknowledgeProviderTerms: false, submitMode: "owner_only" });
      expect(ownerOnly.effectiveSubmitMode).toBe("owner_only");
      expect(ownerOnly.providerTermsAcknowledgedAt).toBeNull();
    });
  });

  describe("effective submit mode", () => {
    it.each([
      ["members", "follow_organization", "members"],
      ["members", "owner_only", "owner_only"],
      ["owner_only", "follow_organization", "owner_only"],
      ["absent", "follow_organization", "owner_only"],
      ["unknown", "follow_organization", "owner_only"],
    ] as const)("organization %s + policy %s → %s", async (org, mode, expected) => {
      aiSubmission = org;
      const policy = await ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, CLAUDE, { submitMode: mode });
      expect(policy.effectiveSubmitMode).toBe(expected);
      expect(await policies.effectiveSubmitMode(PROJECT_SCOPE)).toBe(expected);
    });

    it("re-reads organization metadata on every resolution instead of freezing it", async () => {
      await ownerPolicy();
      aiSubmission = "owner_only";
      expect(await policies.effectiveSubmitMode(PROJECT_SCOPE)).toBe("owner_only");
      expect((await policies.resolve(PROJECT_SCOPE))?.effectiveSubmitMode).toBe("owner_only");
    });

    it("is owner-only with no policy at all", async () => {
      expect(await policies.effectiveSubmitMode(PROJECT_SCOPE)).toBe("owner_only");
    });

    it("stays owner-only without the provider-terms acknowledgement even after the organization enables members", async () => {
      aiSubmission = "owner_only";
      const policy = await ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, CLAUDE, { acknowledgeProviderTerms: false });
      expect(policy.submitMode).toBe("follow_organization");
      expect(policy.providerTermsAcknowledgedAt).toBeNull();
      aiSubmission = "members";
      expect(await policies.effectiveSubmitMode(PROJECT_SCOPE)).toBe("owner_only");
      const resolved = await policies.resolve(PROJECT_SCOPE);
      expect(resolved?.effectiveSubmitMode).toBe("owner_only");
      expect(resolved?.organizationAiSubmission).toBe("owner_only");
      await expect(bindings.admit({
        runId: "run_unacked", requestId: "req_unacked", scopeId: PROJECT_CHAT_SCOPE, requestingActorId: collaborationActors.editor,
        expectedPolicyRevision: policy.revision, executionRoot: ROOT, rootFingerprint: sha("root"), audienceGeneration: "1",
      })).rejects.toMatchObject({ code: "owner_only" });
      const acknowledged = await policies.put({
        scopeId: PROJECT_SCOPE, actorId: collaborationActors.owner, payloadHash: sha("ack"),
        request: putRequest(CLAUDE, { expectedRevision: policy.revision }),
      });
      expect(acknowledged.effectiveSubmitMode).toBe("members");
      expect(acknowledged.organizationAiSubmission).toBe("members");
    });
  });

  describe("scope resolution", () => {
    it("a Chat inside a shared project has no policy of its own and returns the project's", async () => {
      const policy = await ownerPolicy();
      const resolved = await policies.resolve(PROJECT_CHAT_SCOPE);
      expect(resolved).toEqual(policy);
      await expect(ownerPolicy(PROJECT_CHAT_SCOPE)).rejects.toMatchObject({ code: "conflict" });
    });

    it("a standalone Chat carries its own policy with the Chat's owner in the owner role", async () => {
      const policy = await ownerPolicy(STANDALONE_CHAT_SCOPE, STANDALONE_OWNER);
      expect(policy.scope).toEqual({ kind: "standalone_chat", scopeId: STANDALONE_CHAT_SCOPE, chatId: "chat_collaboration_standalone" });
      expect(policy.ownerId).toBe(STANDALONE_OWNER);
      await expect(ownerPolicy(STANDALONE_CHAT_SCOPE, collaborationActors.owner)).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  describe("run bindings", () => {
    function admission(actorId: string, policyRevision: string, extra: Record<string, unknown> = {}) {
      return {
        runId: `run_${uuid()}`,
        requestId: `request_${uuid()}`,
        scopeId: PROJECT_CHAT_SCOPE,
        requestingActorId: actorId,
        expectedPolicyRevision: policyRevision,
        executionRoot: ROOT,
        rootFingerprint: sha("root"),
        audienceGeneration: "1",
        ...extra,
      };
    }

    it("pins the owner's source, payer and policy revision for every member using one source", async () => {
      const policy = await ownerPolicy();
      const first = await bindings.admit(admission(collaborationActors.editor, policy.revision));
      const second = await bindings.admit(admission(collaborationActors.viewer, policy.revision));
      for (const binding of [first, second]) {
        expect(CollaborationRunBindingSchema.parse(binding)).toEqual(binding);
        expect(binding.executingOwnerId).toBe(collaborationActors.owner);
        expect(binding.payerActorId).toBe(collaborationActors.owner);
        expect(binding.source).toEqual({ ...CLAUDE, harness: "claude_code", modelId: "claude-opus-5" });
        expect(binding.policyRevision).toBe(policy.revision);
        expect(binding.scope).toEqual({ kind: "project", scopeId: PROJECT_SCOPE, projectId: "project_collaboration_primary" });
      }
      expect(first.requestingActorId).toBe(collaborationActors.editor);
      expect(second.requestingActorId).toBe(collaborationActors.viewer);
    });

    it("refuses member submission under owner-only while the owner still submits", async () => {
      aiSubmission = "absent";
      const policy = await ownerPolicy();
      await expect(bindings.admit(admission(collaborationActors.editor, policy.revision))).rejects.toMatchObject({ code: "owner_only" });
      const owner = await bindings.admit(admission(collaborationActors.owner, policy.revision));
      expect(owner.requestingActorId).toBe(collaborationActors.owner);
    });

    it("refuses admission with no policy and never invents a source", async () => {
      await expect(bindings.admit(admission(collaborationActors.owner, "0"))).rejects.toMatchObject({ code: "no_policy" });
      expect(await bindings.list(PROJECT_CHAT_SCOPE)).toEqual([]);
    });

    it("a source change while queued invalidates the queued revision and the next admission uses the new source", async () => {
      const first = await ownerPolicy();
      const changed = await policies.put({
        scopeId: PROJECT_SCOPE, actorId: collaborationActors.owner, payloadHash: sha("codex"),
        request: putRequest(CODEX, { expectedRevision: first.revision, allowedModelIds: ["gpt-5.6"] }),
      });
      await expect(bindings.admit(admission(collaborationActors.editor, first.revision))).rejects.toMatchObject({ code: "stale_policy" });
      const binding = await bindings.admit(admission(collaborationActors.editor, changed.revision));
      expect(binding.source).toEqual({ ...CODEX, harness: "codex", modelId: "gpt-5.6" });
    });

    it("an exhausted or unavailable source pauses admission without a fallback source", async () => {
      const policy = await ownerPolicy();
      snapshot = withSourceState("src_claude_sub", "expired");
      await expect(bindings.admit(admission(collaborationActors.editor, policy.revision))).rejects.toMatchObject({ code: "source_unavailable" });
      expect(await bindings.list(PROJECT_CHAT_SCOPE)).toEqual([]);
      expect((await policies.resolve(PROJECT_SCOPE))?.source).toEqual({ ...CLAUDE, harness: "claude_code" });
    });

    it.skipIf(!hasRealPostgres)("resolves the slow AI-submission preflight before the lock and the fenced re-read under it (real Postgres)", async () => {
      const policy = await ownerPolicy();
      const observed: string[] = [];
      aiSubmissionProbe = async () => {
        // A NOWAIT lock from another pooled connection fails only while admit() holds the scope row.
        try {
          await sql`SELECT id FROM collaboration_scopes WHERE id = ${PROJECT_SCOPE} FOR UPDATE NOWAIT`.execute(fixture.db);
          observed.push("unlocked");
        } catch (error: unknown) {
          observed.push((error as { code?: string }).code === "55P03" ? "locked" : `error:${error instanceof Error ? error.name : "unknown"}`);
        }
      };
      await bindings.admit(admission(collaborationActors.editor, policy.revision));
      // The unbounded preflight never holds the scope row; only the bounded fenced re-read does.
      expect(observed).toEqual(["unlocked", "locked"]);
    });

    it("re-reads the organization submission mode under the admission fence, not only at preflight", async () => {
      const policy = await ownerPolicy();
      let lookups = 0;
      aiSubmissionProbe = async () => {
        lookups += 1;
        // The organization turns member submission off after the slow preflight and before the binding is written.
        if (lookups >= 2) aiSubmission = "owner_only";
      };
      await expect(bindings.admit(admission(collaborationActors.editor, policy.revision)))
        .rejects.toMatchObject({ code: "owner_only" });
      expect(lookups).toBeGreaterThanOrEqual(2);
      expect(await bindings.list(PROJECT_CHAT_SCOPE)).toEqual([]);
    });

    it("fails the fenced submission re-read closed and releases the scope row when the lookup stalls", async () => {
      const policy = await ownerPolicy();
      const fenced = new CollaborationRunBindingRepository(fixture.db, {
        now, policies, eligibility, authorityRecheckTimeoutMs: 25,
      });
      let release: (() => void) | undefined;
      let lookups = 0;
      aiSubmissionProbe = async () => {
        lookups += 1;
        if (lookups < 2) return;
        await new Promise<void>((resolve) => { release = resolve; });
      };
      await expect(fenced.admit(admission(collaborationActors.editor, policy.revision)))
        .rejects.toMatchObject({ code: "owner_only" });
      release?.();
      aiSubmissionProbe = undefined;
      expect(await bindings.list(PROJECT_CHAT_SCOPE)).toEqual([]);
      // The refused admission released the scope row, so the owner's own run still admits.
      expect((await bindings.admit(admission(collaborationActors.owner, policy.revision))).requestingActorId)
        .toBe(collaborationActors.owner);
    });

    it.skipIf(!hasRealPostgres)("re-validates the policy revision under the lock after the membership preflight (real Postgres)", async () => {
      const policy = await ownerPolicy();
      let changed = false;
      aiSubmissionProbe = async () => {
        if (changed) return;
        changed = true;
        await ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, CLAUDE, { expectedRevision: policy.revision });
      };
      await expect(bindings.admit(admission(collaborationActors.editor, policy.revision))).rejects.toMatchObject({ code: "stale_policy" });
    });

    it("rejects a participant account override and an unlisted model", async () => {
      const policy = await ownerPolicy();
      expect(CollaborationRunSubmitRequestSchema.safeParse({
        clientRequestId: uuid(), expectedRevision: "1", text: "hi", accessSourceId: "src_openai_key",
      }).success).toBe(false);
      await expect(bindings.admit(admission(collaborationActors.editor, policy.revision, { modelId: "gpt-5.6" })))
        .rejects.toMatchObject({ code: "model_not_allowed" });
      await expect(bindings.admit(admission(collaborationActors.editor, policy.revision, { harness: "codex" })))
        .rejects.toMatchObject({ code: "model_not_allowed" });
    });

    it("bindings are immutable: the same run cannot be re-admitted and no update path exists", async () => {
      const policy = await ownerPolicy();
      const input = admission(collaborationActors.editor, policy.revision);
      const binding = await bindings.admit(input);
      await expect(bindings.admit(input)).rejects.toMatchObject({ code: "conflict" });
      expect(await bindings.get(binding.runId)).toEqual(binding);
      expect("update" in bindings).toBe(false);
    });

    it("a standalone Chat run executes under the Chat's owner and their source", async () => {
      const policy = await ownerPolicy(STANDALONE_CHAT_SCOPE, STANDALONE_OWNER, CODEX, { allowedModelIds: ["gpt-5.6"] });
      const binding = await bindings.admit(admission(collaborationActors.editor, policy.revision, {
        scopeId: STANDALONE_CHAT_SCOPE, executionRoot: { kind: "project", projectId: "project_collaboration_other" },
      }));
      expect(binding.executingOwnerId).toBe(STANDALONE_OWNER);
      expect(binding.payerActorId).toBe(STANDALONE_OWNER);
      expect(binding.scope).toEqual({ kind: "standalone_chat", scopeId: STANDALONE_CHAT_SCOPE, chatId: "chat_collaboration_standalone" });
    });
  });

  describe("shared session binding (T044)", () => {
    it("derives one session key from owner source, harness, root and audience generation", async () => {
      const policy = await ownerPolicy();
      const base = await bindings.admit({
        runId: "run_a", requestId: "req_a", scopeId: PROJECT_CHAT_SCOPE, requestingActorId: collaborationActors.editor,
        expectedPolicyRevision: policy.revision, executionRoot: ROOT, rootFingerprint: sha("root"), audienceGeneration: "1",
      });
      const sameSession = await bindings.admit({
        runId: "run_b", requestId: "req_b", scopeId: PROJECT_CHAT_SCOPE, requestingActorId: collaborationActors.viewer,
        expectedPolicyRevision: policy.revision, executionRoot: ROOT, rootFingerprint: sha("root"), audienceGeneration: "1",
      });
      expect(sharedSessionKey(sameSession)).toBe(sharedSessionKey(base));
      expect(sameSession.sessionGeneration).toBe(base.sessionGeneration);
      const newAudience = await bindings.admit({
        runId: "run_c", requestId: "req_c", scopeId: PROJECT_CHAT_SCOPE, requestingActorId: collaborationActors.viewer,
        expectedPolicyRevision: policy.revision, executionRoot: ROOT, rootFingerprint: sha("root"), audienceGeneration: "2",
      });
      expect(sharedSessionKey(newAudience)).not.toBe(sharedSessionKey(base));
      expect(Number(newAudience.sessionGeneration)).toBeGreaterThan(Number(base.sessionGeneration));
    });

    it("after a restart a changed key allocates strictly above the persisted generation and the same key continues it", async () => {
      const policy = await ownerPolicy();
      const admit = (repo: CollaborationRunBindingRepository, runId: string, audienceGeneration: string) => repo.admit({
        runId, requestId: `req_${runId}`, scopeId: PROJECT_CHAT_SCOPE, requestingActorId: collaborationActors.editor,
        expectedPolicyRevision: policy.revision, executionRoot: ROOT, rootFingerprint: sha("root"), audienceGeneration,
      });
      const first = await admit(bindings, "run_restart_1", "1");
      expect(first.sessionGeneration).toBe("1");
      // A fresh repository has no in-memory session state: the persisted key decides.
      const restarted = new CollaborationRunBindingRepository(fixture.db, { now, policies, eligibility });
      const sameKey = await admit(restarted, "run_restart_2", "1");
      expect(sameKey.sessionGeneration).toBe("1");
      const restartedAgain = new CollaborationRunBindingRepository(fixture.db, { now, policies, eligibility });
      const changedKey = await admit(restartedAgain, "run_restart_3", "2");
      expect(Number(changedKey.sessionGeneration)).toBeGreaterThan(Number(sameKey.sessionGeneration));
      const backToOld = await admit(new CollaborationRunBindingRepository(fixture.db, { now, policies, eligibility }), "run_restart_4", "1");
      expect(Number(backToOld.sessionGeneration)).toBeGreaterThan(Number(changedKey.sessionGeneration));
    });

    it("starts a fresh continuation when the owner changes the source and never keys on the owner's private session", () => {
      const binder = new CollaborationSharedSessionBinder({ maxEntries: 2 });
      const first = binder.generationFor({ scopeId: "s1", chatId: "c1", sessionKey: "key-a" });
      expect(binder.generationFor({ scopeId: "s1", chatId: "c1", sessionKey: "key-a" })).toBe(first);
      const changed = binder.generationFor({ scopeId: "s1", chatId: "c1", sessionKey: "key-b" });
      expect(changed).toBe(first + 1);
      binder.generationFor({ scopeId: "s2", chatId: "c2", sessionKey: "key-a" });
      binder.generationFor({ scopeId: "s3", chatId: "c3", sessionKey: "key-a" });
      expect(binder.size).toBeLessThanOrEqual(2);
    });
  });

  describe("readiness probes (T042)", () => {
    const probes = () => createOwnerSourceReadinessProbes({ policies, eligibility });
    const subject = { resourceKind: "project" as const, ownerId: collaborationActors.owner, scopeId: PROJECT_SCOPE, organizationId: ORG };

    it("reports owner setup needed until a source is selected", async () => {
      const result = await probes().aiSource(subject);
      expect(result).toEqual({ configured: false });
      expect(await probes().submitMode(subject)).toBe("owner_only");
    });

    it("reports the source kind and effective submit mode once selected, through S04's evaluator", async () => {
      await ownerPolicy();
      expect(await probes().aiSource(subject)).toEqual({ configured: true, sourceKind: "owner_account" });
      expect(await probes().submitMode(subject)).toBe("members");
      const readinessResult = await evaluateCollaborationReadiness(subject, {
        ...probes(),
        hostOnline: async () => true,
        supported: async () => true,
        gitIdentity: async () => ({ configured: true, label: "Owner <owner@example.com>" }),
        forgeCredential: async () => ({ configured: true }),
        chatRootInventory: async () => ({ chatRootCount: 1, dirtyRootCount: 0, unresolved: 0 }),
      });
      expect(CollaborationReadinessSchema.parse(readinessResult).state).toBe("ready");
      expect(readinessResult.sourceKind).toBe("owner_account");
      expect(readinessResult.effectiveSubmitMode).toBe("members");
    });

    it("an unavailable source is not ready and is never swapped for another", async () => {
      await ownerPolicy();
      snapshot = withSourceState("src_claude_sub", "unavailable");
      expect(await probes().aiSource(subject)).toEqual({ configured: false });
    });
  });

  describe("shared run owner source (T044)", () => {
    const source = () => new SharedRunOwnerSource({ policies, eligibility, bindings });
    const run = (requestingActorId: string, driverKind: "codex" | "claude_code" = "claude_code") => ({
      scopeId: PROJECT_CHAT_SCOPE, chatId: collaborationIds.chat, ownerId: collaborationActors.owner, requestingActorId, driverKind,
    });

    it("refuses a scope without a policy as unavailable instead of falling back to the owner's default source", async () => {
      await expect(source().prepare(run(collaborationActors.owner))).rejects.toMatchObject({ requestState: "unavailable" });
      await expect(source().prepare(run(collaborationActors.editor))).rejects.toMatchObject({ requestState: "unavailable" });
    });

    it("reports admission missing without a policy, paused while the source is unavailable and ready otherwise", async () => {
      const scope = { scopeId: PROJECT_CHAT_SCOPE, ownerId: collaborationActors.owner };
      expect(await source().admission(scope)).toBe("missing");
      await ownerPolicy();
      expect(await source().admission(scope)).toBe("ready");
      snapshot = withSourceState("src_claude_sub", "unavailable");
      expect(await source().admission(scope)).toBe("paused");
      expect(await source().admission({ ...scope, ownerId: collaborationActors.editor })).toBe("missing");
    });

    it("maps the owner's Claude source to the kernel access source and pins the policy revision", async () => {
      const policy = await ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, { accessSourceId: "owner_anthropic_profile", providerInstanceId: "inst_claude_profile" });
      const decision = await source().prepare(run(collaborationActors.editor));
      expect(decision).toEqual({
        policyRevision: policy.revision,
        harness: "claude_code",
        providerInstanceId: "inst_claude_profile",
        accessSourceId: "owner_anthropic_profile",
        allowedModelIds: ["claude-opus-5"],
        effectiveSubmitMode: "members",
      });
    });

    it("gives Codex no kernel access source and refuses a run whose harness differs from the policy", async () => {
      await ownerPolicy(PROJECT_SCOPE, collaborationActors.owner, CODEX, { allowedModelIds: ["gpt-5.6"] });
      const decision = await source().prepare(run(collaborationActors.editor, "codex"));
      expect(decision?.accessSourceId).toBeNull();
      expect(decision?.harness).toBe("codex");
      await expect(source().prepare(run(collaborationActors.editor, "claude_code")))
        .rejects.toMatchObject({ requestState: "unavailable" });
    });

    it("refuses a member under owner-only as unauthorized and an unavailable source as unavailable, never falling back", async () => {
      aiSubmission = "absent";
      await ownerPolicy();
      await expect(source().prepare(run(collaborationActors.editor))).rejects.toBeInstanceOf(SharedChatRunPreparationError);
      await expect(source().prepare(run(collaborationActors.editor))).rejects.toMatchObject({ requestState: "unauthorized" });
      expect(await source().prepare(run(collaborationActors.owner))).toMatchObject({ effectiveSubmitMode: "owner_only" });
      snapshot = withSourceState("src_claude_sub", "expired");
      await expect(source().prepare(run(collaborationActors.owner))).rejects.toMatchObject({ requestState: "unavailable" });
    });
  });

  describe("execution policy routes", () => {
    let app: Hono;
    let signer: CollaborationProofSigner;
    let nonce = 0;

    beforeEach(() => {
      const repository = new CollaborationRepository(fixture.db, { now });
      const precondition = createOrganizationPrecondition({ source: membershipSource(now), now });
      const authority = new CollaborationAuthority(repository, { now, organizationPrecondition: precondition });
      signer = new CollaborationProofSigner({
        activeKeyId: "collaboration-key-1", keys: { "collaboration-key-1": KEY }, now,
        createNonce: () => (++nonce).toString(16).padStart(32, "0"),
      });
      app = new Hono();
      registerExecutionPolicyRoutes(app, {
        verifier: new CollaborationActorProofVerifier({ runtimeId: collaborationIds.runtime, keys: { "collaboration-key-1": KEY }, now, authority }),
        authority,
        repository,
        executionPolicies: policies,
      });
    });

    async function signed(actorId: string, ownerId: string, method: "GET" | "PUT", body?: unknown, scopeId = PROJECT_SCOPE) {
      const path = `/api/collaboration/scopes/${scopeId}/execution-policy`;
      const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
      const proof = signer.signHttp({ actorId, ownerId, runtimeId: collaborationIds.runtime, scopeId, method, path, query: "", body: bytes });
      return app.request(path, {
        method,
        headers: { "content-type": "application/json", "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url") },
        ...(body === undefined ? {} : { body: new TextDecoder().decode(bytes) }),
      });
    }

    it("the owner sets and reads the policy; a member reads it but cannot change it", async () => {
      const put = await signed(collaborationActors.owner, collaborationActors.owner, "PUT", putRequest());
      expect(put.status).toBe(200);
      const policy = CollaborationExecutionPolicySchema.parse(await put.json());
      expect(policy.source.harness).toBe("claude_code");
      const get = await signed(collaborationActors.editor, collaborationActors.owner, "GET");
      expect(get.status).toBe(200);
      expect(await get.json()).toEqual(policy);
      const memberPut = await signed(collaborationActors.editor, collaborationActors.owner, "PUT", putRequest(CLAUDE, { expectedRevision: policy.revision }));
      expect(memberPut.status).toBe(403);
      expect(await memberPut.json()).toEqual({ error: "Collaboration unavailable", code: "forbidden" });
    });

    it("an outsider with a valid proof is denied by the organization precondition and a bad body is rejected", async () => {
      const outsider = await signed(collaborationActors.outsider, collaborationActors.owner, "GET");
      expect(outsider.status).toBe(404);
      const invalid = await signed(collaborationActors.owner, collaborationActors.owner, "PUT", { ...putRequest(), accessSourceId: "" });
      expect(invalid.status).toBe(400);
      const unknownSource = await signed(collaborationActors.owner, collaborationActors.owner, "PUT", putRequest({ accessSourceId: "src_missing", providerInstanceId: "inst_claude" }));
      expect(unknownSource.status).toBe(409);
      expect(await unknownSource.json()).toEqual({ error: "Collaboration state changed", code: "invalid_source" });
    });

    it("no policy reads as not found without leaking provider details", async () => {
      const get = await signed(collaborationActors.owner, collaborationActors.owner, "GET");
      expect(get.status).toBe(404);
      expect(await get.json()).toEqual({ error: "Collaboration state changed", code: "not_found" });
    });
  });
});

async function seedScopes(fixture: CollaborationTestDatabase): Promise<void> {
  const scope = (input: { id: string; owner: string; kind: "project" | "chat"; resourceId: string; parent: string | null; mode: "direct" | "inherited" }) => ({
    id: input.id,
    owner_type: "personal" as const,
    owner_id: input.owner,
    organization_id: ORG,
    kind: input.kind,
    resource_id: input.resourceId,
    parent_scope_id: input.parent,
    membership_mode: input.mode,
    lifecycle: "shared" as const,
    revision: 1,
    auth_epoch: 1,
    authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1,
    execution_generation: null,
    execution_eligibility: null,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  });
  await fixture.db.insertInto("collaboration_scopes").values([
    scope({ id: PROJECT_SCOPE, owner: collaborationActors.owner, kind: "project", resourceId: "project_collaboration_primary", parent: null, mode: "direct" }),
    scope({ id: PROJECT_CHAT_SCOPE, owner: collaborationActors.owner, kind: "chat", resourceId: collaborationIds.chat, parent: PROJECT_SCOPE, mode: "inherited" }),
    scope({ id: STANDALONE_CHAT_SCOPE, owner: STANDALONE_OWNER, kind: "chat", resourceId: "chat_collaboration_standalone", parent: null, mode: "direct" }),
  ]).execute();
  const member = (scopeId: string, actorId: string, role: "owner" | "editor" | "viewer") => ({
    scope_id: scopeId, actor_id: actorId, role, status: "accepted" as const, organization_id: ORG, invitation_id: null,
    invited_by: collaborationActors.owner, accepted_at: NOW, expires_at: null, revision: 1, joined_at: NOW, updated_at: NOW,
  });
  await fixture.db.insertInto("collaboration_members").values([
    member(PROJECT_SCOPE, collaborationActors.owner, "owner"),
    member(PROJECT_SCOPE, collaborationActors.editor, "editor"),
    member(PROJECT_SCOPE, collaborationActors.viewer, "viewer"),
    member(STANDALONE_CHAT_SCOPE, STANDALONE_OWNER, "owner"),
    member(STANDALONE_CHAT_SCOPE, collaborationActors.editor, "editor"),
  ]).execute();
}

describe("S08 organization AI submission adapter point", () => {
  it("delegates to the S03 membership client seam with the owner as actor and fails closed on errors", async () => {
    const { organizationAiSubmissionFromMembershipClient } = await import(
      "../../packages/gateway/src/collaboration/execution-policy.js"
    );
    const calls: Array<{ organizationId: string; actorId: string }> = [];
    const source = organizationAiSubmissionFromMembershipClient({
      async organizationAiSubmission(input) {
        calls.push(input);
        if (input.organizationId === "org_broken") throw new Error("boom");
        return "members";
      },
    });
    expect(await source.resolve("org_ok", "user_owner")).toBe("members");
    expect(await source.resolve("org_broken", "user_owner")).toBe("unknown");
    expect(calls).toEqual([{ organizationId: "org_ok", actorId: "user_owner" }, { organizationId: "org_broken", actorId: "user_owner" }]);
  });
});
