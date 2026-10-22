import { createHash } from "node:crypto";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, type SharedBrowserAction } from "@matrix-os/contracts";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
import { createSharedBrowserBroker, type SharedBrowserBinding } from "../../packages/gateway/src/shared-browser/broker.js";

const owner = { type: "personal" as const, ownerId: "owner_browser_approval" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const action: SharedBrowserAction = { action: "tab_new", url: "https://example.com" };
const actionDigest = createHash("sha256").update(`matrix-browser-action:v1\0${JSON.stringify(action)}`).digest("hex");
const approvalId = "browser_approval_exact_action";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const catalog = CanonicalProviderCatalogSchema.parse({
  revision: "browser_approval_catalog", drivers: [{ kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
  instances: [{ id: "codex_browser", driverKind: "codex", displayName: "Codex", availability: "available", workspaceRequirement: "project_optional",
    catalogRevision: "browser_approval_catalog", models: [{ id: "fixture-model", displayName: "Fixture", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }],
    options: [], skills: [], commands: [], setupActions: [], supports: { rootChat: true, resume: false, cancellation: true, steering: "none",
      attachments: ["file"], tools: [], approvals: true, userInput: false, worktrees: "none", resources: [], interactionModes: ["default"], permissionModes: ["supervised"] } }],
});

/** Proposed broker lease policy. Kept test-local until implementation is unlocked.
 * The real pre-fix broker ignores this third argument, so the test detects actual
 * driver dispatch before approval rather than failing on an unavailable import.
 */
interface SupervisedLeasePolicy {
  mode: "supervised";
  authorizeAction(request: { binding: SharedBrowserBinding; action: SharedBrowserAction; signal: AbortSignal }): Promise<void>;
}
type OpenSupervisedRun = (binding: SharedBrowserBinding, signal: AbortSignal, policy: SupervisedLeasePolicy) => ReturnType<ReturnType<typeof createSharedBrowserBroker>["openRun"]>;

describe("supervised browser approval at the execution boundary", () => {
  it("holds a real capability action until the canonical owner approves this exact pending call", async () => {
    const pglite = await KyselyPGlite.create();
    const repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    const driver = { execute: vi.fn(async () => ({ success: true, title: "Example Domain" })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
    const broker = createSharedBrowserBroker({ ownerId: owner.ownerId, driver, setHumanControl: async () => {} });
    const asked = deferred<void>(), decided = deferred<void>();
    const observed: Array<{ binding: SharedBrowserBinding; action: SharedBrowserAction }> = [];
    let currentBinding: SharedBrowserBinding | undefined;
    let decisionConsumed = false;
    const provider: CanonicalChatProviderAdapter<{ sessionId: string }> = {
      driverKind: "codex", stateSchemaVersion: 1,
      parseState: value => value as { sessionId: string }, serializeState: value => value,
      async *start(input) {
        currentBinding = { ownerId: input.owner.ownerId, chatId: input.chatId, runId: input.runId, harness: "codex" };
        const lease = (broker.openRun as OpenSupervisedRun)(currentBinding, input.signal, {
          mode: "supervised",
          async authorizeAction(request) {
            observed.push({ binding: request.binding, action: request.action });
            asked.resolve();
            await decided.promise;
            request.signal.throwIfAborted();
          },
        });
        try {
          yield { type: "state.updated", state: { sessionId: "browser_native_fixture" } };
          const capabilityBinding = broker.resolveCapability(lease.token)!;
          const executing = broker.execute(capabilityBinding, action, input.signal);
          // This invokes the real broker from the capability binding used by the
          // agent-action route; there is no UI-only execution substitute.
          const phase = await Promise.race([asked.promise.then(() => "approval"), executing.then(() => "dispatched")]);
          if (phase === "approval") {
            yield { type: "approval.requested", approvalId, title: "Open a browser tab", safeDescription: "Open https://example.com in Matrix Browser.",
              risk: "medium", allowedDecisions: ["approve", "decline", "cancel"], actionDigest };
            await executing;
            yield { type: "approval.resolved", approvalId, decision: "approve" };
          }
          yield { type: "run.completed", outcome: "completed" };
        } finally { await lease.close(); }
      },
      async submitApproval(input) {
        if (decisionConsumed || input.owner.type !== owner.type || input.owner.ownerId !== currentBinding?.ownerId
          || input.chatId !== currentBinding.chatId || input.runId !== currentBinding.runId || input.approvalId !== approvalId
          || input.decision !== "approve") throw new Error("Exact browser approval unavailable");
        decisionConsumed = true;
        decided.resolve();
      },
    };
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([provider]) });
    try {
      await repository.create(owner, { id: "chat_browser_approval", clientRequestId: "req_browser_create", title: "Browser permission" });
      const admitted = await orchestrator.admitTurn(principal, owner, "chat_browser_approval", {
        clientRequestId: "req_browser_turn", baseRevision: 0, parts: [{ type: "text", text: "Open example.com in Matrix Browser." }],
        selection: { instanceId: "codex_browser", model: "fixture-model" }, permissionMode: "supervised", interactionMode: "default",
      });
      await vi.waitFor(async () => {
        const detail = await repository.exportChat(owner, "chat_browser_approval");
        expect(detail?.activities.some(event => event.type === "approval.requested") || driver.execute.mock.calls.length > 0).toBe(true);
      });
      expect(driver.execute, "A supervised capability must not reach Chrome before an explicit owner decision").not.toHaveBeenCalled();
      const pending = await repository.getPendingApproval(owner, { chatId: "chat_browser_approval", runId: admitted.run.id, approvalId });
      expect(pending).toMatchObject({ approvalId, actionDigest });
      expect(observed).toEqual([{ binding: { ownerId: owner.ownerId, chatId: "chat_browser_approval", runId: admitted.run.id, harness: "codex" }, action }]);

      const service = createCanonicalChatService(repository, { orchestrator });
      const app = new Hono().route("/", createCanonicalChatRoutes({ service, getPrincipal: () => principal }));
      const path = `/api/chats/chat_browser_approval/runs/${admitted.run.id}/approvals/${approvalId}`;
      const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId: "req_browser_allow_once", decision: "approve", actionDigest }) });
      expect(response.status).toBe(200);
      await orchestrator.drain();
      expect(driver.execute).toHaveBeenCalledExactlyOnceWith(action, expect.any(AbortSignal));
      const replay = await app.request(path, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId: "req_browser_replay", decision: "approve", actionDigest }) });
      expect(replay.status).not.toBe(200);
      expect(driver.execute).toHaveBeenCalledOnce();
    } finally {
      decided.resolve();
      await orchestrator.drain();
      await broker.close();
      await repository.kysely.destroy();
    }
  });
});
