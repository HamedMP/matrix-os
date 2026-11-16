import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import { CollaborationChatExecutionAdapter } from "../../packages/gateway/src/collaboration/chat-execution-adapter.js";
import { createSharedProviderAuthorityResolver } from "../../packages/gateway/src/collaboration/shared-provider-authority.js";
import type { SharedRunOwnerSourceDecision } from "../../packages/gateway/src/collaboration/shared-run-owner-source.js";
import type { AuthorizedCollaborationContext } from "../../packages/gateway/src/collaboration/authority.js";
import type { ChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { collaborationActors, collaborationExecutionEligibility, collaborationIds } from "./collaboration-test-support.js";

const context: AuthorizedCollaborationContext = {
  actorId: collaborationActors.editor, ownerId: collaborationActors.owner,
  scopeId: collaborationIds.scope, membershipScopeId: "10000000-0000-4000-8000-000000000002",
  resourceKind: "chat", resourceId: collaborationIds.chat, role: "editor", authEpoch: 1,
  authorityRuntimeId: collaborationIds.runtime, authorityGeneration: 1, capability: "read",
};
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function fixture(driver: "codex" | "claude_code", probeMs = 0) {
  const selection = { instanceId: `${driver}_default`, model: driver === "codex" ? "gpt-6.1-sol" : "opus" };
  let enabled = true;
  const decision: SharedRunOwnerSourceDecision = {
    authorityKind: "provider_settings_active", policyRevision: "10", settingsRevision: "10",
    routeGeneration: "a".repeat(64), harness: driver, providerInstanceId: "owner_source_instance",
    providerAccessSourceId: driver === "codex" ? "owner_openai_profile" : "owner_claude_profile",
    accessSourceId: driver === "codex" ? null : "owner_claude_profile",
    allowedModelIds: [selection.model], modelId: selection.model, effectiveSubmitMode: "members",
  };
  const authority = vi.fn(async () => {
    await wait(probeMs);
    if (!enabled) throw new Error("Owner disabled the selected source");
    return decision;
  });
  const getCatalog = vi.fn<ChatProviderCatalogService["getCatalog"]>(async (_principal, selected) => {
    // Full discovery probes unrelated providers. An exact selection only observes its own catalog.
    await wait(probeMs ? selected ? 1000 : 4000 : 0);
    return CanonicalProviderCatalogSchema.parse({
      revision: "native_catalog", drivers: [{ kind: driver, displayName: driver, adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
      instances: [{
        id: selection.instanceId, driverKind: driver, displayName: driver, availability: "available",
        workspaceRequirement: "project_optional", catalogRevision: "native_catalog",
        models: [{ id: selection.model, displayName: selection.model, availability: "available", capabilities: ["tools"],
          supportsVision: false, supportsToolUse: true }],
        options: [], skills: [], commands: [], setupActions: [],
        supports: { rootChat: true, resume: true, cancellation: true, steering: "same_run", attachments: [],
          tools: [], approvals: true, userInput: true, worktrees: "optional", resources: [],
          interactionModes: ["default"], permissionModes: ["supervised"] },
      }],
    });
  });
  const resolveCanonicalProviderAuthority = createSharedProviderAuthorityResolver({
    ownerSource: { authority }, providerCatalog: { getCatalog },
    eligibility: collaborationExecutionEligibility({ adapters: ["claude-code", "codex"] }),
  });
  const options: ConstructorParameters<typeof CollaborationChatExecutionAdapter>[0] = {
    repository: {
      getSharedAiCapability: async () => ({ status: "owner_binding_required", effectiveSelection: selection }),
      listSharedQueuedTurns: async () => [], listSharedPendingApprovals: async () => [],
      enqueueSharedQueuedTurn: vi.fn(),
    },
    commands: { cancel: vi.fn(), retry: vi.fn(), decideApproval: vi.fn() },
    resolveParticipant: vi.fn(), resolveEligibility: vi.fn(), resolveResourceRevision: async () => 9,
    requestDispatch: vi.fn(), resolveCanonicalProviderAuthority,
    resolveOwnerSourceAdmission: async () => { await authority(); return "ready"; },
  };
  return { selection, authority, getCatalog, options, disable: () => { enabled = false; } };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("existing project Chat availability through the relay", () => {
  it.each(["codex", "claude_code"] as const)("enables %s within the unchanged relay deadline", async driver => {
    vi.useFakeTimers();
    // Exercise the actual relay deadline with a deterministic clock, including cancellation.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const f = fixture(driver, 4000);
    const adapter = new CollaborationChatExecutionAdapter(f.options);
    const home = new Hono().get(`/api/collaboration/scopes/${context.scopeId}/chat/requests`, async c =>
      c.json({ requests: [], ...await adapter.capability(context, []), resourceRevision: "9" }));
    const relay = new CollaborationRelay({
      resolveScopeHome: async () => ({ runtimeId: "owner", origin: "https://owner.example" }),
      resolveInvitationHome: async () => null, resolveRuntimeHome: async () => null, resolveSessionHome: async () => null,
      fetchImpl: async (url, init) => Promise.race([
        home.request(String(url), init),
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })),
      ]),
    });
    const response = relay.forward({ actorId: context.actorId, method: "GET", query: "", headers: new Headers(), body: null,
      path: `/api/collaboration/scopes/${context.scopeId}/chat/requests` });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await response;
    await vi.runAllTimersAsync();
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ capability: { status: "available", effectiveSelection: f.selection } });
    expect(f.authority).toHaveBeenCalledOnce();
    expect(f.getCatalog).toHaveBeenCalledWith({ userId: context.ownerId, source: "jwt" }, f.selection);
    relay.close();
  });

  it("rechecks owner authority on the next availability read", async () => {
    const f = fixture("codex");
    const adapter = new CollaborationChatExecutionAdapter(f.options);
    await expect(adapter.capability(context, [])).resolves.toMatchObject({ capability: { status: "available" } });
    f.disable();
    await expect(adapter.capability(context, [])).resolves.toMatchObject({ capability: { status: "unavailable" } });
  });

  it("keeps inherited AI unavailable without a canonical authority resolver", async () => {
    const f = fixture("claude_code");
    await expect(new CollaborationChatExecutionAdapter({ ...f.options, resolveCanonicalProviderAuthority: undefined })
      .capability(context, [])).resolves.toMatchObject({ capability: { status: "unavailable" } });
  });
});
