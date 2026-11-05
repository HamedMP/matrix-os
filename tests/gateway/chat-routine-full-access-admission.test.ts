import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { admitCanonicalTurn, type TurnAdmissionOptions } from "../../packages/gateway/src/chat/turn-admission.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";

const owner = { type: "personal" as const, ownerId: "owner_full_access" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const chatId = "chat_full_access";
const request = { clientRequestId: "req_full_access", baseRevision: 0,
  parts: [{ type: "text" as const, text: "Propose a routine" }],
  selection: { instanceId: "claude_code_default", model: "fixture-model" },
  interactionMode: "default" as const, permissionMode: "full_access" as const };
let repository: ChatRepository;
beforeEach(async () => {
  const database = await createTestPGlite(); repository = new ChatRepository(database.dialect); await repository.bootstrap();
  await repository.create(owner, { id: chatId, clientRequestId: "req_create_full_access", title: "Full Access" });
});

it("the production turn HTTP route carries only the proof selectors into the private admission boundary", async () => {
  const before = vi.fn(async () => undefined), deps = options(before);
  const app = createCanonicalChatRoutes({ getPrincipal: () => principal,
    service: { admitTurn: (...args: Parameters<typeof admitCanonicalTurn> extends [unknown, ...infer Rest] ? Rest : never) => admitCanonicalTurn(deps, ...args) } as never });
  const scopeId = `rcfull_${"b".repeat(32)}`;
  const response = await app.request(`/api/chats/${chatId}/turns`, { method: "POST",
    headers: { "content-type": "application/json", "x-matrix-routine-full-access-scope": scopeId,
      "x-matrix-routine-full-access-proof": "browser-http-proof" }, body: JSON.stringify(request) });
  expect(response.status).toBe(202);
  expect(before).toHaveBeenCalledWith(expect.objectContaining({ scopeId, proof: "browser-http-proof", body: request }));
  expect(JSON.stringify(await response.json())).not.toContain("browser-http-proof");
});
afterEach(async () => { await repository.kysely.destroy(); });

function options(beforeRoutineFullAccessDispatch: ReturnType<typeof vi.fn>): TurnAdmissionOptions {
  const catalog = CanonicalProviderCatalogSchema.parse({ revision: "fixture_catalog",
    drivers: [{ kind: "claude_code", displayName: "Claude", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
    instances: [{ id: "claude_code_default", driverKind: "claude_code", displayName: "Claude", availability: "available",
      workspaceRequirement: "project_optional", catalogRevision: "fixture_catalog",
      models: [{ id: "fixture-model", displayName: "Fixture", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }],
      options: [], skills: [], commands: [], setupActions: [], supports: { rootChat: true, resume: true, cancellation: true,
        steering: "same_run", attachments: [], tools: [], approvals: true, userInput: true, worktrees: "optional", resources: [],
        interactionModes: ["default"], permissionModes: ["full_access"] } }] });
  return { repository, catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([{
    driverKind: "claude_code", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
    async *start() { yield { type: "run.completed", outcome: "completed" }; },
  }]), assertOpen() {}, assertPersonalExecutionAllowed: async () => {}, reconcileActiveRuns: async () => {},
    reservePendingDispatch() {}, releasePendingDispatch() {}, atCapacity: () => false, hasStoppingExecution: () => false,
    beforeRoutineFullAccessDispatch, startDispatch: async () => {}, } as TurnAdmissionOptions;
}

it("redeems Full Access only after a new actual Run is committed, before dispatch, and never upgrades a duplicate", async () => {
  const events: string[] = [], cleanup = vi.fn();
  const before = vi.fn(async (input: { runId: string; body: unknown; scopeId: string; proof: string }) => {
    expect((await repository.exportChat(owner, chatId))?.runs[0]?.id).toBe(input.runId);
    expect(input).toMatchObject({ actorId: owner.ownerId, chatId, clientRequestId: request.clientRequestId,
      scopeId: `rcfull_${"a".repeat(32)}`, proof: "platform-browser-proof", body: request });
    events.push("redeem"); return cleanup;
  });
  const deps = options(before); deps.startDispatch = async () => { events.push("dispatch"); };
  const provenance = { routineFullAccessScope: `rcfull_${"a".repeat(32)}`, routineFullAccessProof: "platform-browser-proof" };
  const first = await admitCanonicalTurn(deps, principal, owner, chatId, request, provenance);
  expect(first.admission).toBe("accepted");
  expect(events, "Fresh browser proof never reaches the accepted Run boundary").toEqual(["redeem", "dispatch"]);
  await Promise.resolve(); expect(cleanup).toHaveBeenCalledOnce();
  expect((await admitCanonicalTurn(deps, principal, owner, chatId, request, provenance)).admission).toBe("already_accepted");
  expect(before).toHaveBeenCalledOnce();
});
