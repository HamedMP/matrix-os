import {
  COLLABORATION_RUN_CONTROL_ACTORS,
  CollaborationEffectiveSubmitModeSchema,
  CollaborationExecutionPolicyPutRequestSchema,
  CollaborationExecutionPolicySchema,
  CollaborationExecutionScopeRefSchema,
  CollaborationGitActionRequestSchema,
  CollaborationGitBranchSchema,
  CollaborationGitOperationSchema,
  CollaborationRunBindingSchema,
  CollaborationRunCancelRequestSchema,
  CollaborationRunQueueSchema,
  CollaborationRunRetryRequestSchema,
  CollaborationRunSchema,
  CollaborationRunStatusSchema,
  CollaborationRunSubmitRequestSchema,
  CollaborationSubmitModeSchema,
  CollaborationToolApprovalDecisionRequestSchema,
  collaborationRunControlPermitted,
  isCollaborationGitBranchName,
  resolveCollaborationEffectiveSubmitMode,
} from "@matrix-os/contracts";
import { isValidGitBranchName } from "../../packages/gateway/src/project-manager.js";
import { describe, expect, it } from "vitest";

const scopeId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";
const now = "2026-09-20T12:00:00.000Z";
const digest = "c".repeat(64);
const sha = "0123456789abcdef0123456789abcdef01234567";

const projectScope = { kind: "project", scopeId, projectId: "proj_release" };
const chatScope = { kind: "standalone_chat", scopeId, chatId: "chat_release" };

const policy = {
  scope: projectScope,
  ownerId: "user_owner",
  source: { accessSourceId: "src_owner_claude", providerInstanceId: "inst_claude", harness: "claude_code" },
  submitMode: "follow_organization",
  organizationAiSubmission: "members",
  effectiveSubmitMode: "members",
  providerTermsAcknowledgedAt: now,
  allowedModelIds: ["claude-opus-5"],
  revision: "2",
  updatedAt: now,
};

describe("collaboration execution contracts (S02 T012/T013)", () => {
  it("resolves the effective submit mode fail-closed from organization metadata and project policy", () => {
    expect(CollaborationSubmitModeSchema.options).toEqual(["follow_organization", "owner_only"]);
    expect(CollaborationEffectiveSubmitModeSchema.options).toEqual(["members", "owner_only"]);
    expect(resolveCollaborationEffectiveSubmitMode({ organizationAiSubmission: "members", submitMode: "follow_organization" })).toBe("members");
    expect(resolveCollaborationEffectiveSubmitMode({ organizationAiSubmission: "members", submitMode: "owner_only" })).toBe("owner_only");
    expect(resolveCollaborationEffectiveSubmitMode({ organizationAiSubmission: "owner_only", submitMode: "follow_organization" })).toBe("owner_only");
    expect(resolveCollaborationEffectiveSubmitMode({ organizationAiSubmission: "absent", submitMode: "follow_organization" })).toBe("owner_only");
    expect(resolveCollaborationEffectiveSubmitMode({ organizationAiSubmission: "unknown", submitMode: "follow_organization" })).toBe("owner_only");
  });

  it("stores one owner-selected V3 source per execution scope, project or standalone Chat", () => {
    expect(CollaborationExecutionScopeRefSchema.parse(projectScope)).toEqual(projectScope);
    expect(CollaborationExecutionScopeRefSchema.parse(chatScope)).toEqual(chatScope);
    expect(CollaborationExecutionScopeRefSchema.safeParse({ kind: "project_chat", scopeId, chatId: "chat_x" }).success).toBe(false);
    expect(CollaborationExecutionPolicySchema.parse(policy)).toEqual(policy);
    expect(CollaborationExecutionPolicySchema.parse({ ...policy, scope: chatScope }).scope).toEqual(chatScope);
    expect(CollaborationExecutionPolicySchema.safeParse({ ...policy, effectiveSubmitMode: "members", submitMode: "owner_only" }).success).toBe(false);
    expect(CollaborationExecutionPolicySchema.safeParse({ ...policy, effectiveSubmitMode: "members", organizationAiSubmission: "absent" }).success).toBe(false);
    expect(CollaborationExecutionPolicySchema.safeParse({ ...policy, providerTermsAcknowledgedAt: null, effectiveSubmitMode: "members" }).success).toBe(false);
    expect(CollaborationExecutionPolicySchema.parse({ ...policy, providerTermsAcknowledgedAt: null, effectiveSubmitMode: "owner_only", submitMode: "owner_only" }).effectiveSubmitMode).toBe("owner_only");
    expect(CollaborationExecutionPolicySchema.safeParse({ ...policy, source: { ...policy.source, harness: "hermes" } }).success).toBe(false);
    expect(CollaborationExecutionPolicySchema.safeParse({ ...policy, fallbackSource: { accessSourceId: "src_2" } }).success).toBe(false);
    expect(CollaborationExecutionPolicySchema.safeParse({ ...policy, participantSources: [] }).success).toBe(false);
    expect(CollaborationExecutionPolicySchema.safeParse({ ...policy, sponsorPayerId: "org_x" }).success).toBe(false);
    const put = { clientRequestId: requestId, expectedRevision: "2", accessSourceId: "src_owner_claude", providerInstanceId: "inst_claude", submitMode: "owner_only", acknowledgeProviderTerms: true, allowedModelIds: ["claude-opus-5"] };
    expect(CollaborationExecutionPolicyPutRequestSchema.parse(put)).toEqual(put);
    expect(CollaborationExecutionPolicyPutRequestSchema.safeParse({ ...put, ownerId: "user_other" }).success).toBe(false);
    expect(CollaborationExecutionPolicyPutRequestSchema.safeParse({ ...put, effectiveSubmitMode: "members" }).success).toBe(false);
  });

  it("lets a run request choose only allowed harness, model, root and request id, never an account", () => {
    const submit = { clientRequestId: requestId, expectedRevision: "9", text: "Ship the release notes", harness: "codex", modelId: "gpt-5.6", executionRoot: { kind: "project", projectId: "proj_release" } };
    expect(CollaborationRunSubmitRequestSchema.parse(submit)).toEqual(submit);
    expect(CollaborationRunSubmitRequestSchema.parse({ clientRequestId: requestId, expectedRevision: "9", text: "hi" })).toMatchObject({ text: "hi" });
    for (const forged of [
      { accountId: "acct_1" },
      { accessSourceId: "src_other" },
      { providerInstanceId: "inst_other" },
      { payerId: "user_other" },
      { apiKey: "sk-abc" },
      { harness: "hermes" },
      { executionRoot: { kind: "path", path: "/home/matrix" } },
      { actorId: "user_owner" },
      { text: "" },
      { text: "x".repeat(65_537) },
    ]) {
      expect(CollaborationRunSubmitRequestSchema.safeParse({ ...submit, ...forged }).success).toBe(false);
    }
  });

  it("pins an immutable run binding with no status field", () => {
    const binding = {
      runId: "run_1",
      requestId: "req_1",
      scope: projectScope,
      requestingActorId: "user_2abc",
      executingOwnerId: "user_owner",
      payerActorId: "user_owner",
      source: { accessSourceId: "src_owner_claude", providerInstanceId: "inst_claude", harness: "claude_code", modelId: "claude-opus-5" },
      policyRevision: "2",
      audienceGeneration: "4",
      executionRoot: { kind: "project", projectId: "proj_release" },
      rootFingerprint: digest,
      sessionGeneration: "1",
      admittedAt: now,
    };
    expect(CollaborationRunBindingSchema.parse(binding)).toEqual(binding);
    expect(CollaborationRunBindingSchema.safeParse({ ...binding, status: "running" }).success).toBe(false);
    expect(CollaborationRunBindingSchema.safeParse({ ...binding, state: "interrupted" }).success).toBe(false);
    expect(CollaborationRunBindingSchema.safeParse({ ...binding, payerActorId: "user_2abc" }).success).toBe(false);
    expect(CollaborationRunBindingSchema.safeParse({ ...binding, rootFingerprint: "abc" }).success).toBe(false);
  });

  it("keeps interrupted and the deciding actors on the canonical run", () => {
    expect(CollaborationRunStatusSchema.options).toContain("interrupted");
    const run = { runId: "run_1", requestId: "req_1", scopeId, requestingActorId: "user_2abc", status: "running", updatedAt: now };
    expect(CollaborationRunSchema.parse(run)).toEqual(run);
    const interrupted = { ...run, status: "interrupted", interruptedReason: "scope_runtime_crash" };
    expect(CollaborationRunSchema.parse(interrupted)).toEqual(interrupted);
    expect(CollaborationRunSchema.safeParse({ ...run, status: "interrupted" }).success).toBe(false);
    expect(CollaborationRunSchema.safeParse({ ...run, interruptedReason: "scope_runtime_crash" }).success).toBe(false);
    const cancelled = { ...run, scopeOwnerId: "user_owner", status: "cancelled", decidedBy: { actorId: "user_owner", relation: "scope_owner" } };
    expect(CollaborationRunSchema.parse(cancelled)).toEqual(cancelled);
    expect(CollaborationRunSchema.parse({ ...cancelled, decidedBy: { actorId: "user_2abc", relation: "requester" } }).decidedBy.relation).toBe("requester");
    expect(CollaborationRunSchema.safeParse({ ...cancelled, decidedBy: { actorId: "user_x", relation: "contributor" } }).success).toBe(false);
    expect(CollaborationRunSchema.safeParse({ ...cancelled, decidedBy: { actorId: "user_owner", relation: "requester" } }).success).toBe(false);
    expect(CollaborationRunSchema.safeParse({ ...cancelled, decidedBy: { actorId: "user_mallory", relation: "scope_owner" } }).success).toBe(false);
    expect(CollaborationRunSchema.safeParse({ ...cancelled, decidedBy: { actorId: "user_2abc", relation: "scope_owner" } }).success).toBe(false);
    expect(CollaborationRunSchema.safeParse({ ...run, status: "cancelled", decidedBy: { actorId: "user_2abc", relation: "scope_owner" } }).success).toBe(false);
    const { scopeOwnerId: _owner, ...ownerWithoutIdentity } = cancelled;
    expect(CollaborationRunSchema.safeParse(ownerWithoutIdentity).success).toBe(false);
    expect(CollaborationRunSchema.safeParse({ ...ownerWithoutIdentity, decidedBy: { actorId: "user_mallory", relation: "scope_owner" } }).success).toBe(false);
    expect(CollaborationRunSchema.parse({ ...ownerWithoutIdentity, decidedBy: { actorId: "user_2abc", relation: "requester" } }).decidedBy.relation).toBe("requester");
    const ownerRequested = { ...run, requestingActorId: "user_owner", scopeOwnerId: "user_owner", status: "cancelled", decidedBy: { actorId: "user_owner", relation: "scope_owner" } };
    expect(CollaborationRunSchema.parse(ownerRequested).decidedBy.relation).toBe("scope_owner");
    expect(CollaborationRunSchema.safeParse({ ...run, status: "cancelled" }).success).toBe(false);
    expect(CollaborationRunSchema.safeParse({ ...run, providerError: "anthropic 529" }).success).toBe(false);
  });

  it("restricts cancel and tool approval to requester or scope owner and retry to the requester", () => {
    expect(COLLABORATION_RUN_CONTROL_ACTORS).toEqual({
      cancel: ["requester", "scope_owner"],
      tool_approval: ["requester", "scope_owner"],
      retry: ["requester"],
    });
    expect(collaborationRunControlPermitted("cancel", "scope_owner")).toBe(true);
    expect(collaborationRunControlPermitted("cancel", "contributor")).toBe(false);
    expect(collaborationRunControlPermitted("cancel", "viewer")).toBe(false);
    expect(collaborationRunControlPermitted("tool_approval", "requester")).toBe(true);
    expect(collaborationRunControlPermitted("tool_approval", "contributor")).toBe(false);
    expect(collaborationRunControlPermitted("retry", "requester")).toBe(true);
    expect(collaborationRunControlPermitted("retry", "scope_owner")).toBe(false);
    const control = { clientRequestId: requestId, expectedRevision: "9" };
    expect(CollaborationRunCancelRequestSchema.parse(control)).toEqual(control);
    expect(CollaborationRunRetryRequestSchema.parse(control)).toEqual(control);
    expect(CollaborationRunCancelRequestSchema.safeParse({ ...control, onBehalfOf: "user_2abc" }).success).toBe(false);
    expect(CollaborationRunRetryRequestSchema.safeParse({ ...control, actorId: "user_owner" }).success).toBe(false);
    const decision = { ...control, runId: "run_1", decision: "approve" };
    expect(CollaborationToolApprovalDecisionRequestSchema.parse(decision)).toEqual(decision);
    expect(CollaborationToolApprovalDecisionRequestSchema.safeParse({ ...decision, approvalId: "appr_1" }).success).toBe(false);
    expect(CollaborationToolApprovalDecisionRequestSchema.safeParse({ ...control, decision: "approve" }).success).toBe(false);
    expect(CollaborationToolApprovalDecisionRequestSchema.safeParse({ ...decision, decision: "approve_all_forever" }).success).toBe(false);
    expect(CollaborationToolApprovalDecisionRequestSchema.safeParse({ ...decision, decidedBy: "user_owner" }).success).toBe(false);
  });

  it("serializes one active run per Chat with fresh-membership re-admission flags", () => {
    const queue = {
      scopeId,
      chatId: "chat_release",
      active: { runId: "run_1", requestId: "req_1", scopeId, requestingActorId: "user_2abc", status: "running", updatedAt: now },
      queued: [{ requestId: "req_2", requestingActorId: "user_3def", acceptedAt: now, membershipEvidenceFresh: true }],
      revision: "9",
    };
    expect(CollaborationRunQueueSchema.parse(queue)).toEqual(queue);
    expect(CollaborationRunQueueSchema.parse({ ...queue, active: null }).active).toBeNull();
    expect(CollaborationRunQueueSchema.safeParse({ ...queue, active: [queue.active, queue.active] }).success).toBe(false);
    expect(CollaborationRunQueueSchema.safeParse({ ...queue, queued: Array.from({ length: 101 }, () => queue.queued[0]) }).success).toBe(false);
  });

  it("freezes the Git action union without approval, force or remote-change fields", () => {
    const base = { clientRequestId: requestId, expectedRevision: "9", payloadHash: digest };
    expect(CollaborationGitActionRequestSchema.parse({ ...base, type: "status" })).toMatchObject({ type: "status" });
    expect(CollaborationGitActionRequestSchema.parse({ ...base, type: "diff", baseRef: "main" })).toMatchObject({ type: "diff" });
    const commit = { ...base, type: "commit", message: "feat: ship", expectedHeadSha: sha };
    expect(CollaborationGitActionRequestSchema.parse(commit)).toEqual(commit);
    const push = { ...base, type: "push", branch: "feature/release", expectedHeadSha: sha };
    expect(CollaborationGitActionRequestSchema.parse(push)).toEqual(push);
    const pr = { ...base, type: "pr", title: "Ship release", body: "Notes", baseBranch: "main", headBranch: "feature/release", expectedHeadSha: sha };
    expect(CollaborationGitActionRequestSchema.parse(pr)).toEqual(pr);
    for (const forged of [
      { ...push, force: true },
      { ...push, approvedBy: "user_owner" },
      { ...push, approvalId: "appr_1" },
      { ...push, remote: "git@evil:repo.git" },
      { ...push, branch: "-oProxyCommand=evil" },
      { ...push, branch: "refs/heads/../main" },
      { ...base, type: "merge", branch: "main" },
      { ...base, type: "force_push", branch: "main" },
      { ...base, type: "set_remote", url: "https://evil" },
      { ...commit, authorName: "Mallory" },
      { ...commit, coAuthors: ["x"] },
      { ...pr, baseBranch: "main; rm -rf /" },
      { ...pr, expectedHeadSha: "abc" },
    ]) {
      expect(CollaborationGitActionRequestSchema.safeParse(forged).success).toBe(false);
    }
  });

  it("validates branch names exactly like the gateway's git-check-ref-format rules", () => {
    const corpus = [
      "main", "feature/release", "release-1.2", "a/b/c", "fix_x", "v1.0.0",
      ".hidden", "feature/.draft", "release.", "feature/", "/main", "-flag", "a..b", "a//b", "a@{b", "@",
      "x.lock", "x.lock/y", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "refs/heads/main", "x".repeat(201), "",
    ];
    for (const candidate of corpus) {
      expect([candidate, isCollaborationGitBranchName(candidate)]).toEqual([candidate, isValidGitBranchName(candidate) && !candidate.startsWith("refs/")]);
      expect(CollaborationGitBranchSchema.safeParse(candidate).success).toBe(isCollaborationGitBranchName(candidate));
    }
    for (const bad of [".hidden", "feature/.draft", "release.", "x.lock", "feature/", "-oProxyCommand=evil", "refs/heads/main"]) {
      expect(CollaborationGitBranchSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("audits Git operations under the owner identity with the requesting member and reconciling state", () => {
    const operation = {
      id: "gitop_1",
      scopeId,
      type: "push",
      state: "completed",
      requestingActorId: "user_2abc",
      runId: "run_1",
      ownerIdentityLabel: "Release Bot (service identity)",
      commitSha: sha,
      remoteBranch: "feature/release",
      createdAt: now,
      updatedAt: now,
    };
    expect(CollaborationGitOperationSchema.parse(operation)).toEqual(operation);
    expect(CollaborationGitOperationSchema.parse({ ...operation, type: "pr", state: "unknown", prUrl: "https://github.com/acme/repo/pull/12" }).state).toBe("unknown");
    expect(CollaborationGitOperationSchema.safeParse({ ...operation, prUrl: "http://github.com/acme/repo/pull/12" }).success).toBe(false);
    expect(CollaborationGitOperationSchema.safeParse({ ...operation, forgeToken: "ghp_abcdefghijklmnopqrstuv" }).success).toBe(false);
    expect(CollaborationGitOperationSchema.safeParse({ ...operation, ownerIdentityLabel: "ghp_abcdefghijklmnopqrstuvwxyz" }).success).toBe(false);
    expect(CollaborationGitOperationSchema.safeParse({ ...operation, approval: { by: "user_owner" } }).success).toBe(false);
    expect(CollaborationGitOperationSchema.safeParse({ ...operation, state: "approved" }).success).toBe(false);
  });
});
