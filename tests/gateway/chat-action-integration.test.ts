import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ActionRepository } from "../../packages/gateway/src/chat/action-repository.js";
import { createCanonicalActionAuthority } from "../../packages/gateway/src/chat/action-authority.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
const owner = { type: "personal" as const, ownerId: "owner_action_integration" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const selection = { instanceId: "codex_fake", model: "fake_model" };
const executionPolicy = { revision: "actions_fake_v1", actionMode: "canonical_actions" as const, workspaceScope: "apps", tools: ["matrix_apply_app_files"], delegation: false };
const session = { sessionId: "vsession_actions", memoryMode: "ordinary" as const, permissionMode: "supervised", executionPolicy };
let repository: ChatRepository;
let orchestrator: CanonicalChatOrchestrator;
beforeEach(async () => { const pg = await KyselyPGlite.create(); repository = new ChatRepository(pg.dialect); await repository.bootstrap(); });
afterEach(async () => { if (orchestrator) await orchestrator.close(); await repository.kysely.destroy(); });
describe("fake canonical model/action composition, without voice-owned approvals", () => {
  for (const source of ["typed", "voice"] as const) it(`${source} final executes only after canonical approval through submitApproval`, async () => {
    const chatId = `chat_action_${source}`;
    await repository.create(owner, { id: chatId, clientRequestId: `req_create_${source}`, title: "Fake canonical action" });
    let effects = 0;
    const eventTypes: string[] = [];
    const actionRepository = new ActionRepository(repository.kysely);
    const actions = createCanonicalActionAuthority({
      repository: actionRepository, qualifyPolicy: async () => executionPolicy,
      tools: [{ toolId: executionPolicy.tools[0]!, description: "fake bounded file effect", inputSchema: {}, schemaRevision: "files_fake_v1", effect: "files", approval: true, reconciliation: true, cancellation: "before_dispatch", normalize: (args) => args,
        execute: async () => { effects++; return { app: "notes", committed: true }; }, reconcile: async () => ({ confirmed: effects === 1, result: { app: "notes", committed: true } }) }],
      onEvent: async (identity, event) => {
        await orchestrator.projectActionEvent(identity, event); eventTypes.push(event.type);
        if (event.type === "approval.requested") {
          expect(effects).toBe(0);
          expect((await actionRepository.get(identity)).state).toBe("waiting_for_approval");
          await orchestrator.submitApproval(owner, chatId, identity.runId, identity.actionId, { clientRequestId: `req_approve_${source}`, decision: "approve", argumentDigest: event.argumentDigest });
        }
      },
    });
    const fakeAdapter: CanonicalChatProviderAdapter = {
      driverKind: "codex", stateSchemaVersion: 1, parseState: (value) => value, serializeState: (value) => value,
      qualifyPolicy: async () => executionPolicy,
      start: async function* (input) {
        expect(input.runPolicy?.executionPolicy).toEqual(executionPolicy); expect(input.actions).toBe(actions);
        const result = await input.actions!.invoke({ owner: input.owner, chatId: input.chatId, runId: input.runId, actionId: `action_${source}`, toolId: executionPolicy.tools[0]!, arguments: { app: "notes" }, executionPolicy: input.runPolicy!.executionPolicy!, signal: input.signal });
        expect(result).toEqual({ app: "notes", committed: true });
        yield { type: "run.completed", outcome: "completed" };
      },
    };
    const catalog = CanonicalProviderCatalogSchema.parse({ revision: "catalog_fake_v1", drivers: [{ kind: "codex", displayName: "Fake Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }], instances: [{ id: selection.instanceId, driverKind: "codex", displayName: "Fake Codex", availability: "available", workspaceRequirement: "project_optional", catalogRevision: "catalog_fake_v1", models: [{ id: selection.model, displayName: "Fake model", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }], options: [], skills: [], commands: [], setupActions: [], supports: { rootChat: true, resume: false, cancellation: "run", steering: "none", attachments: [], tools: [], approvals: true, approvalBinding: "argument_digest", userInput: false, worktrees: "optional", resources: [], interactionModes: ["default"], permissionModes: ["supervised"] } }] });
    orchestrator = new CanonicalChatOrchestrator({ repository, actions, adapters: new CanonicalChatProviderRegistry([fakeAdapter]), catalog: { getCatalog: async () => catalog }, voiceSessionPolicy: { policyForChat: () => session } });
    const admitted = await orchestrator.admitTurn(principal, owner, chatId, { clientRequestId: `req_turn_${source}`, baseRevision: 0, parts: [{ type: "text", text: "Create notes" }], selection, interactionMode: "default", permissionMode: "supervised", runPolicy: { memoryMode: "ordinary", source, nativeCheckpointPolicy: "reusable" } });
    await orchestrator.drain();
    expect(effects).toBe(1);
    expect(eventTypes).toEqual(["approval.requested", "approval.resolved", "tool.progress", "tool.progress", "tool.output"]);
    expect((await actionRepository.get({ owner, chatId, runId: admitted.run.id, actionId: `action_${source}` })).state).toBe("succeeded");
    const stored = await repository.kysely.selectFrom("chat_run_events").select("event").where("run_id", "=", admitted.run.id).execute();
    expect(stored.some((row) => (row.event as { type: string }).type === "approval.requested")).toBe(true);
    expect(stored.some((row) => (row.event as { type: string }).type === "tool.output")).toBe(true);
  });
});
