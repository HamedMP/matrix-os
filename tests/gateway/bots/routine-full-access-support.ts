import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { Kysely } from "kysely";
import type { RoutineFullAccessProof, RoutineFullAccessTuple } from "@matrix-os/contracts";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createRoutineCliTargetService } from "../../../packages/gateway/src/bots/routine-cli-targets.js";
import { createRoutineFullAccessService } from "../../../packages/gateway/src/bots/routine-full-access.js";
import { createChatRoutineSourceProducer } from "../../../packages/gateway/src/chat/routine-chat-source.js";
import type { RoutineFullAccessTurnAdmission } from "../../../packages/gateway/src/chat/turn-admission.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

export async function fullAccessFixture(database?: Awaited<ReturnType<typeof createBotStateDatabase>>,
  limits: { maxScopes?: number; maxRunLeases?: number } = {}) {
  const data = database ?? await createBotStateDatabase(), db = data.db;
  const home = await mkdtemp(join(tmpdir(), "matrix-routine-origin-")), agents = new ChatAgentStore({ homePath: home, db: db as unknown as Kysely<ChatDatabase> });
  await agents.bootstrap();
  await agents.createRecipeBot({ type: "personal", ownerId: OWNER }, { id: BOT, createHash: "a".repeat(64),
    fields: { name: "Recipe Bot", description: "", instructions: "Read", selection: { instanceId: "matrix_pi_default", model: "auto" } },
    recipeRef: { recipeId: "report", version: "1" } });
  const scope = { ownerId: OWNER, computerId: "computer_one" }, principal = { userId: OWNER, source: "jwt" as const };
  const chatId = "chat_origin", target = { botId: BOT, chatId: "chat_target", baseRevision: 0 };
  await insertChat(db, target.chatId); await insertChat(db, chatId);
  const bindings = createBotBindingsRepository(db);
  await bindings.bindDirect({ ...scope, ...target, now: new Date().toISOString() });
  const targets = createRoutineCliTargetService({ db, scope, agents, canAccessTarget: async () => true });
  await targets.remember(principal, target);
  const chats = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  let clock = Date.now(), nonce = 0, count = 0;
  // The proof transport is a named component fixture; real Platform mint/verify is a separate lane.
  const verify = vi.fn(async (tuple: RoutineFullAccessTuple, proof: string): Promise<RoutineFullAccessProof> => {
    if (proof !== "browser-proof-fixture") throw new Error("Fixture proof rejected");
    return { ...tuple, purpose: "routine_cli_full_access_origin", version: 1,
      expiresAt: clock + 60_000, nonce: (++nonce).toString(16).padStart(32, "0"), bodyDigest: "b".repeat(64) };
  });
  const service = createRoutineFullAccessService({ db, scope, targets, ...limits, now: () => clock,
    platform: { handle: "computer-one", machineId: "machine_one", runtimeSlot: "primary", verify } });
  async function consent(id = chatId) {
    const status = await service.status(principal, id), created = await service.createChallenge(principal, id, { baseRevision: status.revision });
    const challenge = created.challenge!;
    const decision = { scopeDigest: challenge.scopeDigest, decision: "approve" as const, clientRequestId: "de000000-0000-4000-8000-000000000001" };
    const approved = await service.submitDecision(principal, id, challenge.challengeId, decision, "browser-proof-fixture");
    return { created, approved, decision, challenge };
  }
  async function admission(scopeId?: string, override: Partial<RoutineFullAccessTurnAdmission> = {}, sourceChatId = chatId) {
    const chatId = sourceChatId;
    const n = ++count, record = (await chats.get({ type: "personal", ownerId: OWNER }, chatId))!, at = new Date().toISOString();
    const turnId = `cturn_origin_${n}`, runId = `run_origin_${n}`, messageId = `msg_origin_${n}`, clientRequestId = `req_origin_${n}`;
    const body = { clientRequestId, baseRevision: record.chat.revision, parts: [{ type: "text" as const, text: "Propose a routine" }],
      selection: { instanceId: "claude_code_default", model: "fixture-model" }, interactionMode: "default", permissionMode: "full_access" };
    const admitted = await chats.admitTurn({ type: "personal", ownerId: OWNER }, { chatId, baseRevision: body.baseRevision, requestHash: "a".repeat(64),
      message: { id: messageId, chatId, seq: record.chat.messageCount + 1, role: "user", state: "committed", actorId: OWNER, turnId, parts: body.parts, createdAt: at },
      turn: { id: turnId, chatId, clientRequestId, baseMessageSeq: record.chat.messageCount, inputMessageId: messageId, status: "accepted", createdAt: at, updatedAt: at },
      run: { id: runId, chatId, turnId, attempt: 1, driverKind: "claude_code", instanceId: body.selection.instanceId, selection: body.selection,
        interactionMode: body.interactionMode, permissionMode: body.permissionMode, status: "accepted", historyBoundarySeq: record.chat.messageCount,
        createdAt: at, updatedAt: at, capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: true,
          userInput: true, resume: false, cancellation: true, worktrees: "none", interactionModes: ["default"], permissionModes: ["full_access"] } } });
    const input: RoutineFullAccessTurnAdmission = { principal, owner: { type: "personal", ownerId: OWNER }, actorId: OWNER, chatId,
      turnId, runId, run: admitted.run, clientRequestId, body, scopeId, proof: "browser-proof-fixture", ...override };
    return input;
  }
  function source(input: RoutineFullAccessTurnAdmission, provider?: "claude" | "codex") {
    const controller = new AbortController();
    const actual = createChatRoutineSourceProducer({ input: { owner: input.owner, chatId: input.chatId, turnId: input.turnId, runId: input.runId,
      prompt: "Fixture", parts: input.body.parts, selection: input.body.selection, interactionMode: input.run.interactionMode,
      permissionMode: input.run.permissionMode, signal: controller.signal }, provider, computerId: scope.computerId,
      signal: controller.signal, current: () => true, publish() {}, bindFullAccess: service.bindSource });
    return { ...actual, controller };
  }
  return { data, db, agents, chats, targets, bindings, scope, principal, chatId, target, service, verify, consent, admission, source,
    advance(ms: number) { clock += ms; }, setNonce(value: number) { nonce = value; },
    async close() { service.close(); await agents.close(); await rm(home, { recursive: true, force: true }); if (!database) await data.destroy(); } };
}
