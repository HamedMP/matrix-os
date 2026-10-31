import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { canonicalChatApprovals, CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { createRealBotStateDatabase } from "./bot-state-support.js";
import { requestFixture, propose, scope } from "./routine-cli-request-support.js";
import { invocation } from "./routine-cli-source-support.js";
import { createRoutineCliActionController } from "../../../packages/gateway/src/bots/routine-action-controller.js";
import { createRoutineActionSourceRegistry } from "../../../packages/gateway/src/bots/routine-action-source-registry.js";
import { createRoutineActionPlatformClient } from "../../../packages/gateway/src/bots/routine-action-platform-client.js";
import { createRoutineActionVerificationRoutes } from "../../../packages/platform/src/routine-action-routes.js";
import { authenticatedApprovalProxyProof } from "../../../packages/platform/src/canonical-owner-approval-proxy.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter, type CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalChatRoutes } from "../../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../../packages/gateway/src/chat/service.js";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>, f: Awaited<ReturnType<typeof requestFixture>>;
let controller: ReturnType<typeof createRoutineCliActionController>, registry: ReturnType<typeof createRoutineActionSourceRegistry>, canonical: CanonicalChatOrchestrator;
afterEach(async () => { controller?.close(); registry?.close(); await canonical?.drain(); await canonical?.close(); await f?.close(); await data?.destroy(); });
it("actual admitted Chat -> routine event -> canonical persistence/card projection -> actual owner route preserves exact digest and bypasses native approval", async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL; if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required");
  data = await createRealBotStateDatabase(url); f = await requestFixture(data.db); registry = createRoutineActionSourceRegistry();
  const handle = "computer-one", secret = "fixture-platform-chat-owner-purpose", machineId = "fixture-chat-machine";
  const machine = { handle, machineId, runtimeSlot: "primary", clerkUserId: scope.ownerId, provisioningClass: "customer" as const };
  const platform = createRoutineActionVerificationRoutes({ platformSecret: secret, lookup: { resolveMachine: async () => ({ ...machine, status: "running" }) } });
  const client = createRoutineActionPlatformClient({ platformUrl: "https://platform.example.test", handle, token: buildPlatformVerificationToken(handle, secret), fetcher: async (url, init) => platform.request(new Request(url, init)) });
  controller = createRoutineCliActionController({ db: data.db, scope, agents: f.agents, registry, canAccessTarget: async () => true,
    platform: { handle, machineId, runtimeSlot: "primary", verify: client.verify } });
  const nativeApproval = vi.fn(async () => { throw new Error("Routine decision reached generic native provider"); });
  // Fixture adapter only; actual canonical admission, persisted source rows, event consumer, projection and submit route remain real.
  const provider: CanonicalChatProviderAdapter = { driverKind: "codex", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value, submitApproval: nativeApproval,
    async *start(input) {
      const events: CanonicalProviderRunEvent[] = []; let wake: (() => void) | undefined;
      const source = await controller.register({ source: { ...scope, harness: "codex", identity: { kind: "chat_run", chatId: input.chatId, runId: input.runId, route: "native" },
        generation: input.runId, actions: ["read", "propose", "control"], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() },
        signal: input.signal, readPolicy: () => ({ live: !input.signal.aborted, scope: "personal", permissionMode: "supervised", interactionMode: "default", originCeiling: "exact", revision: input.runId }),
        validateWithin: async (source, trx) => !input.signal.aborted && Boolean(await trx.selectFrom("chat_runs as r").innerJoin("chats as c", "c.id", "r.chat_id").select("r.id")
          .where("r.id", "=", source.identity.kind === "chat_run" ? source.identity.runId : "denied").where("c.owner_id", "=", source.ownerId).where("c.owner_type", "=", "personal")
          .where("r.permission_mode", "=", "supervised").where("r.interaction_mode", "=", "default").where("r.status", "in", ["accepted", "running", "waiting_for_approval"]).executeTakeFirst()),
        publish: event => { events.push(event); wake?.(); wake = undefined; } });
      const waiting = source.authorize({ operation: propose(850), invocationId: invocation(851), signal: input.signal });
      while (!events.length) await new Promise<void>(resolve => { wake = resolve; });
      yield events.shift()!; expect(await waiting).toBe(true);
      while (events.length) yield events.shift()!;
      yield { type: "run.completed", outcome: "completed" };
    } };
  const catalog = CanonicalProviderCatalogSchema.parse({ revision: "fixture-catalog", drivers: [{ kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
    instances: [{ id: "codex_default", driverKind: "codex", displayName: "Codex", availability: "available", workspaceRequirement: "project_optional", catalogRevision: "fixture-catalog",
      models: [{ id: "fixture-model", displayName: "Fixture model", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }], options: [], skills: [], commands: [], setupActions: [],
      supports: { rootChat: true, resume: false, cancellation: true, steering: "none", attachments: [], tools: [], approvals: true, userInput: false, worktrees: "none", resources: [], interactionModes: ["default"], permissionModes: ["supervised"] } }] });
  canonical = new CanonicalChatOrchestrator({ repository: f.chats, adapters: new CanonicalChatProviderRegistry([provider]), catalog: { getCatalog: async () => catalog }, routineActions: controller });
  const owner = { type: "personal" as const, ownerId: scope.ownerId }, chatId = "chat_actual_routine_source";
  await f.chats.create(owner, { id: chatId, clientRequestId: "req_routine_source_create", title: "Fixture source" });
  const admitted = await canonical.admitTurn(f.principal, owner, chatId, { clientRequestId: "req_routine_source_turn", baseRevision: 0, parts: [{ type: "text", text: "Fixture routine request" }],
    selection: { instanceId: "codex_default", model: "fixture-model" }, interactionMode: "default", permissionMode: "supervised" });
  let projected: ReturnType<typeof canonicalChatApprovals>[number] | undefined;
  for (let i = 0; i < 100 && !projected; i++) { const detail = await f.chats.exportChat(owner, chatId); projected = detail ? canonicalChatApprovals(detail).find(value => value.pending) : undefined; if (!projected) await new Promise(resolve => setTimeout(resolve, 5)); }
  expect(projected).toMatchObject({ runId: admitted.run.id, actionDigest: expect.stringMatching(/^[a-f0-9]{64}$/), allowedDecisions: ["approve", "decline", "cancel"], pending: true });
  const view = controller.get(f.principal, projected!.approvalId); expect(projected!.actionDigest).toBe(view.actionDigest);
  const app = new Hono(); app.route("/", createCanonicalChatRoutes({ service: createCanonicalChatService(f.chats, { orchestrator: canonical }), getPrincipal: () => f.principal }));
  const path = `/api/chats/${chatId}/runs/${admitted.run.id}/approvals/${projected!.approvalId}`;
  const body = { actionDigest: view.actionDigest, decision: "approve", clientRequestId: `req_${"f".repeat(32)}` };
  const request = (proof?: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(proof ? { "x-matrix-routine-action-proof": proof } : {}) }, body: JSON.stringify(body) });
  expect((await request()).status).toBe(409);
  const proof = await authenticatedApprovalProxyProof({ request: new Request(`https://app.example.test${path}`, { method: "POST", body: JSON.stringify(body) }), method: "POST", path, handle, machine, platformSecret: secret,
    identity: { handle, userId: scope.ownerId, runtimeSlot: "primary", source: "auth", sessionProvenance: "clerk-browser", sessionExpiresAt: Math.floor(Date.now() / 1000) + 120 } });
  expect((await request(proof as string)).status).toBe(200); await canonical.drain(); expect(nativeApproval).not.toHaveBeenCalled();
  const final = canonicalChatApprovals((await f.chats.exportChat(owner, chatId))!);
  expect(final).toEqual(expect.arrayContaining([expect.objectContaining({ approvalId: projected!.approvalId, actionDigest: view.actionDigest, pending: false, decision: "approve" })]));
  expect(await data.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0); expect(await data.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0);
});
