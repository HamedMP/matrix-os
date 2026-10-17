import { createBrowserGrantRoutes } from "../../packages/gateway/src/chat/browser-grant-routes.js";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
import { createSharedBrowserBroker } from "../../packages/gateway/src/shared-browser/broker.js";
import { openNativeSharedBrowserRun } from "../../packages/gateway/src/chat/native-shared-browser-run.js";
import { BrowserApprovalRepository } from "../../packages/gateway/src/chat/browser-approval-repository.js";
import { createBrowserApprovalControl } from "../../packages/gateway/src/chat/browser-approval-control.js";
import { mintBrowserApprovalProof, verifyBrowserDecisionProof, verifyBrowserRevokeProof } from "../../packages/platform/src/browser-chat-approval-proof.js";

/** PostgreSQL-compatible functional path; concurrent transaction acceptance is
 * separately required on the real disposable PostgreSQL CI service. */
it.each(["codex", "claude_code"] as const)("binds %s's supervised browser call to canonical owner intent and consumes its real metadata once", async harness => {
  const owner = { type: "personal" as const, ownerId: "owner_browser" };
  const principal = { userId: owner.ownerId, source: "jwt" as const };
  const secret = "synthetic-platform-only-test-secret", handle = "pv-browser-test";
  const pglite = await KyselyPGlite.create();
  const repository = new ChatRepository(pglite.dialect); await repository.bootstrap();
  const authority = new BrowserApprovalRepository(repository.kysely, { boundedConnectionAcquisition: true,
    verifyDecision: async (tuple, proof) => { const verified = verifyBrowserDecisionProof(proof, tuple, secret); if (!verified) throw new Error("Approval unavailable"); return verified; },
    verifyRevoke: async (tuple, proof) => { const verified = verifyBrowserRevokeProof(proof, tuple, secret); if (!verified) throw new Error("Approval unavailable"); return verified; },
  });
  const control = createBrowserApprovalControl({ authority, handle, runtimeSlot: handle, ownerId: owner.ownerId });
  const driver = { execute: vi.fn(async () => ({ success: true, observationId: "fresh", title: "Example Domain" })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
  const broker = createSharedBrowserBroker({ ownerId: owner.ownerId, driver, setHumanControl: async () => {}, authorizeAction: control.authorizeAction });
  const catalog = CanonicalProviderCatalogSchema.parse({ revision: "browser_catalog",
    drivers: [{ kind: harness, displayName: harness, adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
    instances: [{ id: "browser_fixture", driverKind: harness, displayName: harness, availability: "available", workspaceRequirement: "project_optional",
      catalogRevision: "browser_catalog", models: [{ id: "fixture-model", displayName: "Fixture", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }],
      options: [], skills: [], commands: [], setupActions: [], supports: { rootChat: true, resume: false, cancellation: true, steering: "none",
        attachments: ["file"], tools: [], approvals: true, userInput: false, worktrees: "none", resources: [], interactionModes: ["default"], permissionModes: ["supervised"] } }],
  });
  const adapter: CanonicalChatProviderAdapter<{ sessionId: string }> = { driverKind: harness, stateSchemaVersion: 1,
    parseState: value => value as { sessionId: string }, serializeState: value => value,
    async *start(input) {
      const lease = openNativeSharedBrowserRun({ broker, gatewayPort: 4000, harness }, input)!;
      try {
        yield { type: "state.updated", state: { sessionId: "browser_fixture" } };
        await broker.execute(broker.resolveCapability(lease.token)!, { action: "tab_new", url: "https://example.com" }, input.signal);
        // The remembered owner grant must be consumed for this fresh action too.
        await broker.execute(broker.resolveCapability(lease.token)!, { action: "snapshot" }, input.signal);
        yield { type: "run.completed", outcome: "completed" };
      } finally { await lease.close(); }
    },
  };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([adapter]), browserApprovals: control });
  try {
    await repository.create(owner, { id: "chat_browser", clientRequestId: "req_create", title: "Browser permission" });
    const admitted = await orchestrator.admitTurn(principal, owner, "chat_browser", { clientRequestId: "req_turn", baseRevision: 0,
      parts: [{ type: "text", text: "Open example.com in Matrix Browser." }], selection: { instanceId: "browser_fixture", model: "fixture-model" }, permissionMode: "supervised", interactionMode: "default" });
    let pending: Awaited<ReturnType<typeof repository.getPendingApproval>>;
    await vi.waitFor(async () => {
      const detail = await repository.exportChat(owner, "chat_browser");
      const event = detail?.activities.find(event => event.type === "approval.requested");
      expect(event?.type).toBe("approval.requested");
      pending = event?.type === "approval.requested" ? event : null;
    });
    expect(driver.execute).not.toHaveBeenCalled();
    const lifecycle = pending!.browserApproval!;
    const body = { clientRequestId: "req_allow_chat", decision: "approve", actionDigest: pending!.actionDigest,
      browserApproval: { kind: "shared_chrome", decision: "allow_in_chat", leaseEpoch: lifecycle.leaseEpoch, challengeRevision: lifecycle.challengeRevision, scopeVersion: 1 } };
    const path = `/api/chats/chat_browser/runs/${admitted.run.id}/approvals/${pending!.approvalId}`;
    const app = new Hono().route("/", createCanonicalChatRoutes({ service: createCanonicalChatService(repository, { orchestrator }), getPrincipal: () => principal }));
    const fake = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-matrix-browser-approval-proof": "machine-marker" }, body: JSON.stringify(body) });
    expect(fake.status).not.toBe(200); expect(driver.execute).not.toHaveBeenCalled();
    const proof = mintBrowserApprovalProof({ method: "POST", path, secret, body: JSON.stringify(body),
      identity: { handle, runtimeSlot: handle, source: "auth", userId: owner.ownerId, sessionProvenance: "clerk-browser" } })!;
    expect(proof).toEqual(expect.any(String));
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-matrix-browser-approval-proof": proof }, body: JSON.stringify(body) });
    expect(response.status).toBe(200); await orchestrator.drain();
    expect(driver.execute.mock.calls).toHaveLength(2);
    expect(await authority.activeGrant(owner.ownerId, "chat_browser")).toMatchObject({ state: "active", revision: 1 });
    const detail = await repository.exportChat(owner, "chat_browser");
    expect(detail!.activities.filter(event => event.type === "approval.requested")).toHaveLength(1);
    expect(detail!.activities.some(event => event.type === "approval.resolved" && event.browserApproval?.resolution === "allowed_in_chat")).toBe(true);
    const grantApp = createBrowserGrantRoutes({ control, getPrincipal: () => principal });
    const granted = await (await grantApp.request("/api/chats/chat_browser/browser-grants")).json() as { grant: { id: string; revision: number } };
    const revokePath = `/api/chats/chat_browser/browser-grants/${granted.grant.id}`;
    const revokeBody = JSON.stringify({ clientRequestId: "req_undo", baseRevision: granted.grant.revision });
    expect((await grantApp.request(revokePath, { method: "DELETE", headers: { "content-type": "application/json" }, body: revokeBody })).status).toBe(403);
    const undoProof = mintBrowserApprovalProof({ method: "DELETE", path: revokePath, secret, body: revokeBody,
      identity: { handle, runtimeSlot: handle, source: "auth", userId: owner.ownerId, sessionProvenance: "clerk-browser" } })!;
    const undone = await grantApp.request(revokePath, { method: "DELETE", headers: { "content-type": "application/json", "x-matrix-browser-approval-proof": undoProof }, body: revokeBody });
    expect(undone.status).toBe(200);
    expect(await authority.activeGrant(owner.ownerId, "chat_browser")).toBeNull();
  } finally { await control.close(); await broker.close(); await orchestrator.drain(); await authority.close(); await repository.kysely.destroy(); }
});
