import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { CollaborationAuthorizationError } from "../../packages/gateway/src/collaboration/authority.js";
import { SharedChatRunPreparationError } from "../../packages/gateway/src/chat/shared-execution-coordinator.js";
import { collaborationExecutionEligibility } from "./collaboration-test-support.js";
import {
  createSharedAiApprovalReconciler,
  createSharedAiCancellationDispatcher,
  createSharedChatSandboxManifest,
  recoverSharedAiQueue,
  resolveClaudeProviderReadiness,
  resolveSharedProviderReadiness,
  sharedDispatchFenceMatches,
  sharedProviderIdentityFor,
} from "../../packages/gateway/src/collaboration/shared-ai-runtime.js";

describe("shared provider identity", () => {
  it("binds Claude to the owner's kernel access source and refuses a non-kernel source instead of falling back", () => {
    expect(sharedProviderIdentityFor("claude_code", { accessSourceId: "owner_anthropic_profile" }))
      .toEqual({ driverKind: "claude_code", instanceId: "claude_shared", accessSourceId: "owner_anthropic_profile" });
    expect(sharedProviderIdentityFor("codex", { accessSourceId: null }))
      .toEqual({ driverKind: "codex", instanceId: "codex_default" });
    expect(() => sharedProviderIdentityFor("claude_code", { accessSourceId: null })).toThrow(SharedChatRunPreparationError);
  });
});

describe("shared Chat sandbox admission", () => {
  const scopeId = "10000000-0000-4000-8000-000000000001";
  const owner = { type: "personal" as const, ownerId: "user_owner" };
  const rootRef = { kind: "project" as const, projectId: "project_demo" };
  const fingerprint = "a".repeat(64);
  const run = { id: "run_demo", turnId: "turn_demo", executionRoot: rootRef, executionRootFingerprint: fingerprint };
  const capability = { available: true as const, sandbox: { workloads: ["chat_ai" as const] } };

  it("mounts the authoritative resolved root for the requesting actor and scope", async () => {
    const resolve = vi.fn(async () => ({ ref: rootRef, fingerprint, primaryWorkspaceRoot: "/home/matrix/home/projects/demo", projectSlug: "demo" }));
    await expect(createSharedChatSandboxManifest({
      run, scopeId, actorId: "user_editor", capability, executionRoots: { resolve }, owner,
      homePath: "/home/matrix/home",
    })).resolves.toEqual({
      version: 1, scopeHandle: "scope_10000000000040008000000000000001", actorId: "user_editor",
      worktree: { hostPath: "/home/matrix/home/projects/demo", mode: "rw", fingerprint },
      network: "broker_only",
    });
    expect(resolve).toHaveBeenCalledWith(owner, rootRef);
  });

  it("fails closed before runtime creation without a canonical root or with stale root provenance", async () => {
    const resolve = vi.fn(async () => ({ ref: rootRef, fingerprint, primaryWorkspaceRoot: "/home/matrix/home/projects/demo", projectSlug: "demo" }));
    const input = { run, scopeId, actorId: "user_editor", capability, executionRoots: { resolve }, owner, homePath: "/home/matrix/home" };
    await expect(createSharedChatSandboxManifest({ ...input, run: { ...run, executionRoot: null } }))
      .rejects.toMatchObject({ requestState: "unavailable" });
    expect(resolve).not.toHaveBeenCalled();
    await expect(createSharedChatSandboxManifest({ ...input, run: { ...run, executionRootFingerprint: "b".repeat(64) } }))
      .rejects.toMatchObject({ requestState: "unavailable" });
    await expect(createSharedChatSandboxManifest({ ...input, run: { ...run, executionRootFingerprint: null } }))
      .rejects.toMatchObject({ requestState: "unavailable" });
    await expect(createSharedChatSandboxManifest({ ...input, capability: { available: true as const } }))
      .rejects.toMatchObject({ requestState: "unavailable" });
    resolve.mockResolvedValueOnce({ ref: rootRef, fingerprint, primaryWorkspaceRoot: "/home/matrix/home", projectSlug: "demo" });
    await expect(createSharedChatSandboxManifest(input)).rejects.toMatchObject({ requestState: "unavailable" });
  });
});

describe("shared AI Provider readiness", () => {
  const selection = { instanceId: "claude_code_default", model: "opus" };
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
  const catalogWith = (instance: Record<string, unknown>, model: Record<string, unknown> = {}) => ({
    getCatalog: vi.fn(async () => CanonicalProviderCatalogSchema.parse({
      revision: "readiness_catalog",
      drivers: [
        { kind: "claude_code", displayName: "Claude", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
        { kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
      ],
      instances: [{
        id: "claude_code_default", driverKind: "claude_code", displayName: "Claude", availability: "available",
        workspaceRequirement: "project_optional", catalogRevision: "readiness_catalog",
        models: [{ id: "opus", displayName: "Opus", availability: "available", capabilities: [],
          supportsVision: false, supportsToolUse: false, ...model }],
        options: [], skills: [], commands: [], setupActions: [],
        supports: {
          rootChat: true, resume: true, cancellation: true, steering: "same_run", attachments: [], tools: [],
          approvals: false, userInput: false, worktrees: "optional", resources: [],
          interactionModes: ["default"], permissionModes: ["supervised"],
        },
        ...instance,
      }],
    })),
  });

  it("reports the Matrix-included route ready without probing owner credentials", async () => {
    const listProviders = vi.fn(async () => [claudeSummary("auth_required", "expired")]);
    const providerCatalog = catalogWith({ availability: "auth_required", unavailabilityReason: "authentication_required" });
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("matrix_included", { matrixIncluded: "ready" }),
      codingProviders: { listProviders },
      providerCatalog,
    }, "user_owner", selection)).resolves.toBe("ready");
    expect(listProviders).not.toHaveBeenCalled();
    expect(providerCatalog.getCatalog).not.toHaveBeenCalled();
  });

  it.each([
    { route: "owner_anthropic_key", states: { ownerApiKey: "unverified" } },
    { route: "owner_anthropic_profile", states: { ownerProfile: "unverified" } },
  ] as const)("verifies the $route route through the trusted provider catalog", async ({ route, states }) => {
    const listProviders = vi.fn(async () => [claudeSummary("auth_required", "expired")]);
    const available = catalogWith({});
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources(route, states),
      codingProviders: { listProviders },
      providerCatalog: available,
    }, "user_owner", selection)).resolves.toBe("ready");
    expect(available.getCatalog).toHaveBeenCalledWith({ userId: "user_owner", source: "jwt" });
    expect(listProviders).not.toHaveBeenCalled();

    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources(route, states),
      providerCatalog: catalogWith({ availability: "auth_required", unavailabilityReason: "authentication_required" }),
    }, "user_owner", selection)).resolves.toBe("reconnect_required");
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources(route, states),
      providerCatalog: catalogWith({ availability: "unavailable", unavailabilityReason: "runtime_unavailable" }),
    }, "user_owner", selection)).resolves.toBe("unavailable");
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources(route, states),
      providerCatalog: catalogWith({ id: "codex_default", driverKind: "codex" }),
    }, "user_owner", selection)).resolves.toBe("unavailable");
  });

  it("requires the bound model and shared-run requirements, not only a healthy Instance", async () => {
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_key", { ownerApiKey: "unverified" }),
      providerCatalog: catalogWith({}, { availability: "unavailable" }),
    }, "user_owner", selection)).resolves.toBe("unavailable");
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_key", { ownerApiKey: "unverified" }),
      providerCatalog: catalogWith({}, { id: "sonnet" }),
    }, "user_owner", selection)).resolves.toBe("unavailable");
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_profile", { ownerProfile: "unverified" }),
      providerCatalog: catalogWith({ supports: {
        rootChat: true, resume: true, cancellation: true, steering: "same_run", attachments: [], tools: [],
        approvals: false, userInput: false, worktrees: "optional", resources: [],
        interactionModes: ["default"], permissionModes: ["autonomous"],
      } }),
    }, "user_owner", selection)).resolves.toBe("unavailable");
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_profile", { ownerProfile: "unverified" }),
      providerCatalog: catalogWith({}, { availability: "unavailable" }),
    }, "user_owner", { ...selection, model: "sonnet" })).resolves.toBe("unavailable");
  });

  it("never treats unverified owner credential material as ready on its own", async () => {
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_key", { ownerApiKey: "unverified" }),
    }, "user_owner", selection)).resolves.toBe("unavailable");
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_key", { ownerApiKey: "unverified" }),
      providerCatalog: catalogWith({}),
    }, "user_owner", null)).resolves.toBe("unavailable");
  });

  it.each([
    { summary: claudeSummary("available", "authenticated"), expected: "ready" },
    { summary: claudeSummary("auth_required", "expired"), expected: "reconnect_required" },
    { summary: claudeSummary("unavailable", "unknown"), expected: "unavailable" },
  ] as const)("falls back to the Claude login state for the profile route without a catalog ($expected)", async ({ summary, expected }) => {
    const listProviders = vi.fn(async () => [summary]);
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_profile", { ownerProfile: "unverified" }),
      codingProviders: { listProviders },
    }, "user_owner", selection)).resolves.toBe(expected);
    expect(listProviders).toHaveBeenCalledWith({ userId: "user_owner", source: "jwt" });
  });

  it("fails closed when the selected access source is not usable", async () => {
    const listProviders = vi.fn(async () => [claudeSummary("available", "authenticated")]);
    const providerCatalog = catalogWith({});
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("matrix_included", { matrixIncluded: "disabled" }),
      codingProviders: { listProviders },
      providerCatalog,
    }, "user_owner", selection)).resolves.toBe("unavailable");
    await expect(resolveClaudeProviderReadiness({
      resolveCredentialSources: async () => sources("owner_anthropic_profile", { ownerProfile: "invalid" }),
      codingProviders: { listProviders },
      providerCatalog,
    }, "user_owner", selection)).resolves.toBe("unavailable");
    expect(listProviders).not.toHaveBeenCalled();
    expect(providerCatalog.getCatalog).not.toHaveBeenCalled();
  });
});

describe("shared AI readiness routing by immutable binding", () => {
  const codexSelection = { instanceId: "codex_default", model: "gpt-5.6-sol" };
  const codexCatalog = (instance: Record<string, unknown> = {}) => ({
    getCatalog: vi.fn(async () => CanonicalProviderCatalogSchema.parse({
      revision: "codex_catalog",
      drivers: [
        { kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
        { kind: "claude_code", displayName: "Claude", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
      ],
      instances: [{
        id: "codex_default", driverKind: "codex", displayName: "Codex", availability: "available",
        workspaceRequirement: "project_optional", catalogRevision: "codex_catalog",
        models: [{ id: "gpt-5.6-sol", displayName: "Sol", availability: "available", capabilities: [],
          supportsVision: false, supportsToolUse: false }],
        options: [], skills: [], commands: [], setupActions: [],
        supports: {
          rootChat: true, resume: true, cancellation: true, steering: "same_run", attachments: [], tools: [],
          approvals: false, userInput: false, worktrees: "optional", resources: [],
          interactionModes: ["default"], permissionModes: ["supervised"],
        },
        ...instance,
      }],
    })),
  });
  const claudeSources = () => vi.fn(async () => ({
    selectedMode: "platform" as const,
    selectedAccessSourceId: "matrix_included" as const,
    matrixIncluded: { state: "ready" as const },
    ownerApiKey: { state: "setup_required" as const },
    ownerProfile: { state: "setup_required" as const },
  }));

  it("verifies a bound Codex Chat through the catalog without touching Claude credential routes", async () => {
    const providerCatalog = codexCatalog();
    const resolveCredentialSources = claudeSources();
    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
      providerCatalog,
    }, "user_owner", codexSelection, "codex")).resolves.toBe("ready");
    expect(providerCatalog.getCatalog).toHaveBeenCalledWith({ userId: "user_owner", source: "jwt" });
    expect(resolveCredentialSources).not.toHaveBeenCalled();
  });

  it("fails a bound Codex Chat closed as generic unavailability, never Claude reconnect guidance", async () => {
    const resolveCredentialSources = claudeSources();
    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
      providerCatalog: codexCatalog({
        availability: "auth_required", unavailabilityReason: "authentication_required",
      }),
    }, "user_owner", codexSelection, "codex")).resolves.toBe("unavailable");
    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
      providerCatalog: codexCatalog({ driverKind: "claude_code" }),
    }, "user_owner", codexSelection, "codex")).resolves.toBe("unavailable");
    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
    }, "user_owner", codexSelection, "codex")).resolves.toBe("unavailable");
    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
      providerCatalog: codexCatalog(),
    }, "user_owner", null, "codex")).resolves.toBe("unavailable");
    expect(resolveCredentialSources).not.toHaveBeenCalled();
  });

  it("follows the bound Claude driver even when its Instance id collides with the Codex id", async () => {
    const providerCatalog = codexCatalog({ driverKind: "claude_code" });
    const resolveCredentialSources = claudeSources();
    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
      providerCatalog,
    }, "user_owner", codexSelection, "claude_code")).resolves.toBe("ready");
    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
      providerCatalog,
    }, "user_owner", { instanceId: "claude_code_default", model: "opus" }, "claude_code")).resolves.toBe("ready");
    expect(resolveCredentialSources).toHaveBeenCalledTimes(2);
    expect(providerCatalog.getCatalog).not.toHaveBeenCalled();
  });

  it("classifies an unbound Chat's candidate selection through the catalog once", async () => {
    const codex = codexCatalog();
    const resolveCredentialSources = claudeSources();
    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
      providerCatalog: codex,
    }, "user_owner", codexSelection, null)).resolves.toBe("ready");
    expect(codex.getCatalog).toHaveBeenCalledTimes(1);
    expect(resolveCredentialSources).not.toHaveBeenCalled();

    const claude = codexCatalog({ id: "claude_code_default", driverKind: "claude_code" });
    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
      providerCatalog: claude,
    }, "user_owner", { instanceId: "claude_code_default", model: "gpt-5.6-sol" }, null)).resolves.toBe("ready");
    expect(claude.getCatalog).toHaveBeenCalledTimes(1);
    expect(resolveCredentialSources).toHaveBeenCalledTimes(1);

    await expect(resolveSharedProviderReadiness({
      resolveCredentialSources,
    }, "user_owner", codexSelection, null)).resolves.toBe("ready");
    expect(resolveCredentialSources).toHaveBeenCalledTimes(2);
  });
});

describe("shared AI dispatch fence", () => {
  const expected = {
    ownerId: "user_owner",
    chatId: "chat_shared",
    executionGeneration: 7,
    executionEligibility: collaborationExecutionEligibility({ adapters: ["codex"] }),
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
  it("wakes nothing when there is no queued work", async () => {
    const dispatch = vi.fn();
    const reconcilePendingApprovals = vi.fn(async () => undefined);

    await recoverSharedAiQueue({
      reconcilePendingApprovals,
      listQueued: vi.fn(async () => []),
      dispatch,
    });

    expect(reconcilePendingApprovals).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("wakes each queued scope once without consulting any rollout policy", async () => {
    const dispatch = vi.fn(async () => undefined);

    await recoverSharedAiQueue({
      reconcilePendingApprovals: vi.fn(async () => undefined),
      listQueued: vi.fn(async () => [
        { scopeId: "scope-1", chatId: "chat-1" },
        { scopeId: "scope-1", chatId: "chat-1" },
        { scopeId: "scope-2", chatId: "chat-2" },
      ]),
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith("scope-1", "chat-1");
    expect(dispatch).toHaveBeenCalledWith("scope-2", "chat-2");
  });
});
