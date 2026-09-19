import { describe, expect, it, vi } from "vitest";
import { CollaborationAuthorizationError } from "../../packages/gateway/src/collaboration/authority.js";
import {
  createSharedAiApprovalReconciler,
  createSharedAiCancellationDispatcher,
  recoverSharedAiQueue,
  resolveClaudeProviderReadiness,
  sharedDispatchFenceMatches,
} from "../../packages/gateway/src/collaboration/shared-ai-runtime.js";

describe("shared AI Provider readiness", () => {
  const claudeSummary = (availability: "available" | "auth_required" | "unavailable",
    authStatus: "authenticated" | "expired" | "unknown") => ({
    id: "claude",
    displayName: "Claude Code",
    kind: "claude" as const,
    availability,
    installStatus: "installed" as const,
    authStatus,
    supportedModes: ["default" as const],
    defaultMode: "default" as const,
    setupActions: [],
  });
  const sources = (
    selectedAccessSourceId: "matrix_included" | "owner_anthropic_key" | "owner_anthropic_profile",
    states: Partial<Record<"matrixIncluded" | "ownerApiKey" | "ownerProfile",
      "ready" | "setup_required" | "unverified" | "invalid" | "unavailable" | "disabled">> = {},
  ) => ({
    selectedMode: selectedAccessSourceId === "owner_anthropic_key" ? "api_key" as const
      : selectedAccessSourceId === "owner_anthropic_profile" ? "claude_login" as const : "platform" as const,
    selectedAccessSourceId,
    matrixIncluded: { state: states.matrixIncluded ?? "disabled" as const },
    ownerApiKey: { state: states.ownerApiKey ?? "setup_required" as const },
    ownerProfile: { state: states.ownerProfile ?? "setup_required" as const },
  });

  it("reports the Matrix-included route ready even when the local Claude login needs auth", async () => {
    const listProviders = vi.fn(async () => [claudeSummary("auth_required", "expired")]);
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("matrix_included", { matrixIncluded: "ready" }),
      codingProviders: { listProviders },
    }, "user_owner")).resolves.toBe("ready");
    expect(listProviders).not.toHaveBeenCalled();
  });

  it("reports the owner API key route ready without consulting the Claude login", async () => {
    const listProviders = vi.fn(async () => [claudeSummary("auth_required", "expired")]);
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_key", { ownerApiKey: "unverified" }),
      codingProviders: { listProviders },
    }, "user_owner")).resolves.toBe("ready");
    expect(listProviders).not.toHaveBeenCalled();
  });

  it.each([
    { summary: claudeSummary("available", "authenticated"), expected: "ready" },
    { summary: claudeSummary("auth_required", "expired"), expected: "reconnect_required" },
    { summary: claudeSummary("unavailable", "unknown"), expected: "unavailable" },
  ] as const)("maps the owner Claude profile route from the login state ($expected)", async ({ summary, expected }) => {
    const listProviders = vi.fn(async () => [summary]);
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_profile", { ownerProfile: "unverified" }),
      codingProviders: { listProviders },
    }, "user_owner")).resolves.toBe(expected);
    expect(listProviders).toHaveBeenCalledWith({ userId: "user_owner", source: "jwt" });
  });

  it("fails closed when the selected access source is not usable", async () => {
    const listProviders = vi.fn(async () => [claudeSummary("available", "authenticated")]);
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("matrix_included", { matrixIncluded: "disabled" }),
      codingProviders: { listProviders },
    }, "user_owner")).resolves.toBe("unavailable");
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_profile", { ownerProfile: "invalid" }),
      codingProviders: { listProviders },
    }, "user_owner")).resolves.toBe("unavailable");
    expect(listProviders).not.toHaveBeenCalled();
  });
});

describe("shared AI dispatch fence", () => {
  const expected = {
    ownerId: "user_owner",
    chatId: "chat_shared",
    executionGeneration: 7,
    executionEligibility: {
      profileId: "scope-runtime-chat-v1",
      profileVersion: 2,
      profileDigest: "a".repeat(64),
      adapters: [{ adapterId: "codex" as const, harnessVersion: "0.154.0" }],
    },
    driverKind: "codex" as const,
    selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
  };
  const current = {
    owner_id: "user_owner",
    resource_id: "chat_shared",
    execution_generation: 7,
    execution_eligibility: expected.executionEligibility,
    lifecycle: "active",
    bound_driver_kind: "codex",
    bound_instance_id: "codex_default",
    current_selection: expected.selection,
  };

  it("requires current owner, generation, eligibility, provider, and model at dispatch", () => {
    expect(sharedDispatchFenceMatches(current, expected)).toBe(true);
    expect(sharedDispatchFenceMatches({ ...current, execution_generation: 8 }, expected)).toBe(false);
    expect(sharedDispatchFenceMatches({
      ...current,
      current_selection: { instanceId: "codex_default", model: "gpt-5.6-terra" },
    }, expected)).toBe(false);
    expect(sharedDispatchFenceMatches({ ...current, bound_instance_id: "claude_shared" }, expected))
      .toBe(false);
  });
});
describe("shared AI runtime cancellation", () => {
  it("reauthorizes the actor immediately before stopping the external run", async () => {
    const policy = { getM2: vi.fn(async () => ({
      milestone: "m2" as const,
      mode: "enabled" as const,
      cohort: [],
      issuedAt: "2026-09-10T00:00:00.000Z",
      expiresAt: "2026-09-10T01:00:00.000Z",
      keyId: "key-1",
      signature: "signature",
    })) };
    const authorize = vi.fn()
      .mockResolvedValueOnce({
        scopeId: "10000000-0000-4000-8000-000000000001",
        actorId: "user_editor",
        ownerId: "user_owner",
        resourceKind: "chat",
        resourceId: "chat_shared",
      })
      .mockRejectedValueOnce(new CollaborationAuthorizationError("not_found", "revoked"));
    const cancelSharedRun = vi.fn(async () => undefined);
    const dispatch = createSharedAiCancellationDispatcher({
      policy,
      authority: { authorize },
      orchestrator: { cancelSharedRun },
    });
    const input = {
      scopeId: "10000000-0000-4000-8000-000000000001",
      chatId: "chat_shared",
      runId: "run_shared",
      requestId: "qturn_shared",
      clientRequestId: "50000000-0000-4000-8000-000000000001",
      actorId: "user_editor",
    };
    await expect(dispatch(input)).resolves.toBeUndefined();
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: input.scopeId,
      actorId: input.actorId,
      action: "control_execution",
    }));
    expect(cancelSharedRun).toHaveBeenCalledWith(
      { type: "personal", ownerId: "user_owner" },
      input.scopeId,
      input.chatId,
      input.runId,
    );
    await expect(dispatch(input)).rejects.toMatchObject({ code: "not_found" });
    expect(cancelSharedRun).toHaveBeenCalledTimes(1);
  });
  it("interrupts and terminally reconciles an approval with an unknown outcome", async () => {
    const cancelSharedRun = vi.fn(async () => { throw new Error("runtime disconnected"); });
    const reconcileActiveRuns = vi.fn(async () => 1);
    const reconcile = createSharedAiApprovalReconciler({
      resolveOwnerId: vi.fn(async () => "user_owner"),
      readRunStatus: vi.fn(async () => "failed" as const),
      orchestrator: { cancelSharedRun, reconcileActiveRuns },
    });
    await expect(reconcile({
      commandId: "10000000-0000-4000-8000-000000000009",
      scopeId: "10000000-0000-4000-8000-000000000001",
      chatId: "chat_shared",
      runId: "run_shared",
      approvalId: "approval_shared",
      decision: "approve",
    })).resolves.toBe("failed");
    expect(cancelSharedRun).toHaveBeenCalledOnce();
    expect(reconcileActiveRuns).toHaveBeenCalledWith({ type: "personal", ownerId: "user_owner" });
  });
});

describe("shared AI queue recovery", () => {
  it("does not fetch rollout policy when there is no queued work", async () => {
    const getPolicy = vi.fn();
    const dispatch = vi.fn();
    const reconcilePendingApprovals = vi.fn(async () => undefined);

    await recoverSharedAiQueue({
      reconcilePendingApprovals,
      listQueued: vi.fn(async () => []),
      getPolicy,
      dispatch,
    });

    expect(reconcilePendingApprovals).toHaveBeenCalledOnce();
    expect(getPolicy).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("checks policy once and wakes each queued scope once", async () => {
    const dispatch = vi.fn(async () => undefined);
    const getPolicy = vi.fn(async () => ({ mode: "enabled" as const }));

    await recoverSharedAiQueue({
      reconcilePendingApprovals: vi.fn(async () => undefined),
      listQueued: vi.fn(async () => [
        { scopeId: "scope-1", chatId: "chat-1" },
        { scopeId: "scope-1", chatId: "chat-1" },
        { scopeId: "scope-2", chatId: "chat-2" },
      ]),
      getPolicy,
      dispatch,
    });

    expect(getPolicy).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith("scope-1", "chat-1");
    expect(dispatch).toHaveBeenCalledWith("scope-2", "chat-2");
  });
});
