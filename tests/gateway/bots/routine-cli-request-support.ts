import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Kysely } from "kysely";
import type { RoutineCliOperation, BotRoutineProposal } from "../../../packages/contracts/src/bots/index.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createRoutineCliSourceService } from "../../../packages/gateway/src/bots/routine-cli-source.js";
import { createRoutineCliTargetService } from "../../../packages/gateway/src/bots/routine-cli-targets.js";
import { createRoutineCliRequestService, type RoutineCliRequestDependencies, type RoutineCliMutationAdmission } from "../../../packages/gateway/src/bots/routine-cli-requests.js";
import { BOT, NOW, OWNER, at, insertChat } from "./bot-state-support.js";
import { SOURCE_SCOPE as scope, context, invocation } from "./routine-cli-source-support.js";
export const TARGET_A = { botId: BOT, chatId: "chat_target_a" }, TARGET_B = { botId: "bot_abcdefgh", chatId: "chat_target_b" };
export const proposal: BotRoutineProposal = { name: "Daily report", prompt: "private prompt", schedule: { kind: "interval", everyMs: 60_000 }, selection: { instanceId: "matrix_chatgpt_plan", model: "private-model" }, authorizedEffects: ["read"] };
export const propose = (n = 100): RoutineCliOperation => ({ operation: "propose", requestId: invocation(n), proposal });
export const routineId = (n: number) => `rt_${n.toString(16).padStart(24, "0")}`;
export async function requestFixture(db: Kysely<OwnerBotDatabase>, options: { actualSourceOnly?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "routine-cli-requests-"));
  const chats = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agents = new ChatAgentStore({ homePath: home, db: chats.kysely }); await agents.bootstrap();
  for (const target of [TARGET_A, TARGET_B]) {
    await insertChat(db, target.chatId);
    await agents.createRecipeBot({ type: "personal", ownerId: OWNER }, { id: target.botId, createHash: target.botId === BOT ? "a".repeat(64) : "b".repeat(64),
      fields: { name: "Report", description: "", instructions: "Read", selection: { instanceId: "matrix_pi_default", model: "auto" } }, recipeRef: { recipeId: "report", version: "1" } });
    await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, ...target, now: NOW });
  }
  const state = { clock: NOW, live: true, operationAllowed: true, targetAllowed: true };
  const sources = createRoutineCliSourceService({ db, scope, now: () => new Date(state.clock), validateLifecycle: async () => state.live, authorizeOperation: async () => state.operationAllowed });
  const targets = createRoutineCliTargetService({ db, scope, agents, now: () => new Date(state.clock), revalidateSource: sources.revalidateSource, canAccessTarget: async () => true });
  const principal = { userId: OWNER, source: "jwt" as const };
  await targets.remember(principal, { ...TARGET_A, baseRevision: 0 });
  // Actual native-source lanes must mint through their canonical adapter, never pre-seed a source.
  const source: Awaited<ReturnType<typeof sources.register>> | "" = options.actualSourceOnly ? "" : await sources.register(context()); let nextInvocation = 1;
  // Explicit atomic ledger fixture port, NOT real canonical proposal/control admission.
  const admitMutation: RoutineCliMutationAdmission = async ({ transaction, target }) => {
    const task = await createBotTasksRepository(transaction.db).create({ ownerId: OWNER, botId: target.botId, chatId: target.chatId, now: state.clock }, transaction.db);
    await transaction.publish(target.chatId, "bot.task.updated", { taskId: task.taskId, status: task.status });
    return { disposition: "queued" };
  };
  const transact = createBotStateTransactions(chats);
  const service = (overrides: Partial<RoutineCliRequestDependencies> = {}) => createRoutineCliRequestService({ db, scope, sources, targets, transact,
    now: () => new Date(state.clock), authorizeTarget: async () => state.targetAllowed, admitMutation, ...overrides });
  const token = async (operation: RoutineCliOperation, registered: typeof source = source) => {
    if (!registered) throw new Error("Actual canonical native source required");
    return (await sources.issue(registered, { invocationId: invocation(nextInvocation++), operation })).takeToken();
  };
  return { home, db, state, chats, agents, sources, targets, source, principal, transact, service, token, admitMutation,
    execute: async (operation: RoutineCliOperation, overrides: Partial<RoutineCliRequestDependencies> = {}) => service(overrides).execute({ token: await token(operation), operation }),
    switchDefault: async () => { const current = await targets.getStoredPreference(principal); await targets.remember(principal, { ...TARGET_B, baseRevision: current.revision }); },
    close: async () => { await agents.close(); await chats.release(); await rm(home, { recursive: true, force: true }); },
  };
}
export async function insertRoutine(db: Kysely<OwnerBotDatabase>, n: number, fields: { botId?: string; chatId?: string; status?: "active" | "paused" | "archived"; createdAt?: string } = {}) {
  const id = routineId(n);
  await db.insertInto("bot_routines").values({ routine_id: id, owner_id: OWNER, bot_id: fields.botId ?? BOT, chat_id: fields.chatId ?? TARGET_A.chatId,
    proposal, approved_source: { accountId: "private-account", computerId: scope.computerId, grantRevision: 1, definitionRevision: 1 }, approval_id: null,
    status: fields.status ?? "active", next_fire_at: at(60_000), revision: 1, created_at: fields.createdAt ?? NOW, updated_at: NOW }).execute();
  return id;
}
export async function insertFire(db: Kysely<OwnerBotDatabase>, id: string, n: number, status: "uncertain" | "completed" | "cancelled" = "uncertain") {
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, ...TARGET_A, now: NOW });
  await db.insertInto("bot_routine_fires").values({ fire_id: `fire_${n.toString(16).padStart(24, "0")}`, owner_id: OWNER, routine_id: id, task_id: task.taskId,
    scheduled_for: at(n), status, attempts: 1, retry_after: null, lease_expires_at: null, failure_code: "private_provider_error", created_at: NOW, updated_at: at(n) }).execute();
}
export { scope };
