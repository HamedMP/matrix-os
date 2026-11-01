import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { BotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createRoutineCliProposals, type RoutineCliProposalDependencies } from "../../../packages/gateway/src/bots/routine-cli-proposals.js";
import { createBotRoutineApprovals } from "../../../packages/gateway/src/bots/routine-approval.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createPrivateBotAdmission } from "../../../packages/gateway/src/bots/admission.js";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import { createMatrixBotChatProviderAdapter } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { withBotProviderInstance } from "../../../packages/gateway/src/bots/provider-instance.js";
import { requestFixture, proposal, TARGET_A, scope } from "./routine-cli-request-support.js";
import { OWNER, BOT, NOW } from "./bot-state-support.js";
import type { ChatGptPlanAuthority } from "../../../packages/gateway/src/bots/chatgpt-plan.js";
/** Real canonical admission/task/private admission/registry/approval/outbox. Only host runtime calls,
 * source policy and bounded external background-authority snapshot are fixtures, never account execution. */
export async function proposalFixture(db: Kysely<OwnerBotDatabase>, instrument: <Args extends unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => Result = fn => fn, extra?: { adapters: import("../../../packages/gateway/src/chat/provider-adapter.js").CanonicalChatProviderAdapter[]; catalog: import("@matrix-os/contracts").CanonicalProviderCatalog; actualSourceOnly?: boolean }) {
  const f = await requestFixture(db, { actualSourceOnly: extra?.actualSourceOnly }), registry = new BotRuntimeRegistry();
  const hooks: { transact?: BotStateTransactions; authorizeTarget?: RoutineCliProposalDependencies["authorizeTarget"]; sources?: RoutineCliProposalDependencies["sources"]; targets?: RoutineCliProposalDependencies["targets"]; resolveRoutineSource?: ChatGptPlanAuthority["resolve"] } = {};
  const proposalTransactions: BotStateTransactions = (owner, work) => (hooks.transact ?? f.transact)(owner, work);
  const state = { background: true, sourceAllowed: true, stopBeforeProposal: false };
  const route = { api: "openai-responses" as const, modelId: proposal.selection.model, input: ["text" as const], contextWindow: 8192, maxOutputTokens: 256 };
  const subscription = { accountId: "fixture-account", computerId: scope.computerId, grantRevision: 1, peerId: "de000000-0000-4000-8000-000000000900" };
  const approvals = createBotRoutineApprovals({ db, transact: f.transact, now: () => new Date(f.state.clock),
    definitionRevision: async (owner, bot) => (await f.agents.get({ type: "personal", ownerId: owner }, bot))!.revision,
    source: { resolve: async (...args) => { if (hooks.resolveRoutineSource) return hooks.resolveRoutineSource(...args); if (!state.background) throw new Error("Fixture background disabled"); return { route, accessSourceId: "matrix_chatgpt_plan", subscription }; } } });
  const host = { createRuntime: instrument(async () => ({ runtimeHandle: `runtime_${randomBytes(16).toString("hex")}`, executionGeneration: "1" })),
    renewRuntime: instrument(async () => ({})), stopRuntime: instrument(async () => ({})) };
  const roots = { resolve: async () => ({ ref: { kind: "bot_workspace" as const, botId: BOT }, fingerprint: "a".repeat(64), primaryWorkspaceRoot: "/fixture/bot" }) };
  const admission = createPrivateBotAdmission({ db, registry, host: { available: true, client: host as never }, roots });
  let canonical!: CanonicalChatOrchestrator;
  const transport = { admitTurn: (...args: Parameters<CanonicalChatOrchestrator["admitTurn"]>) => canonical.admitTurn(...args),
    enqueueQueuedTurn: (...args: Parameters<CanonicalChatOrchestrator["enqueueQueuedTurn"]>) => canonical.enqueueQueuedTurn(...args) };
  const proposals = createRoutineCliProposals({ db, scope, transact: proposalTransactions, sources: { validateAcceptedWithin: (trx, input, work) => (hooks.sources ?? f.sources).validateAcceptedWithin(trx, input, work) },
    targets: { validatePinnedWithin: (...args) => (hooks.targets ?? f.targets).validatePinnedWithin(...args),
      validateClaimedTargetWithin: (...args) => (hooks.targets ?? f.targets).validateClaimedTargetWithin(...args) },
    authorizeTarget: async (...args) => hooks.authorizeTarget ? hooks.authorizeTarget(...args) : f.state.targetAllowed, approvals, registry,
    canonical: { repository: f.chats, orchestrator: transport }, now: () => new Date(f.state.clock) });
  const runBot = instrument(async (input: { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }): Promise<{ ok: true; reply: Record<string, unknown> }> => {
    if (input.command.kind === "bot.run") throw new Error("Trusted intent reached worker/model inference");
    return { ok: true, reply: {} }; // Cancellation transport ACK is explicitly not worker exit.
  });
  const interactions = createBotInteractionService({ transact: f.transact, now: () => new Date(f.state.clock), handlers: { decideApproval: approvals.decide,
    chooseAccount: async () => { throw new Error("No real account fixture"); } } });
  const taskDependencies: Parameters<typeof createBotTaskOrchestrator>[0] = { bindings: createBotBindingsRepository(db), transact: f.transact,
    routineTools: true, agents: f.agents, recipes: createBotRecipeCatalog([{ recipeId: "report", version: "1", name: "Report", description: "Fixture report",
      instructions: "Read", capabilities: ["artifact.read"], integrations: [], output: "Report" }]),
    resolveRoute: async () => ({ route, accessSourceId: "matrix_chatgpt_plan", subscription }), admission, registry, client: { runBot },
    routineProposals: proposals as never, interactions, now: () => new Date(f.state.clock), assertSource: async () => {
      if (!state.sourceAllowed) throw new Error("Fixture target source denied");
    } };
  const tasks = createBotTaskOrchestrator(taskDependencies);
  const adapterOptions: Parameters<typeof createMatrixBotChatProviderAdapter>[0] = { orchestrator: tasks, stopRuntime: async handle => { await admission.release(handle); }, proposals };
  const adapter = createMatrixBotChatProviderAdapter(adapterOptions);
  canonical = new CanonicalChatOrchestrator({ repository: f.chats, adapters: new CanonicalChatProviderRegistry([adapter, ...(extra?.adapters ?? [])]),
    catalog: withBotProviderInstance({ getCatalog: async () => (extra?.catalog ?? { revision: "fixture", drivers: [], instances: [] }) }),
    agentContext: new ChatAgentContext({ repository: f.chats, agents: f.agents, enabled: () => true,
      botChats: { directBot: async (owner, chat) => owner.type === "personal" ? await createBotBindingsRepository(db).directChatId({ ownerId: owner.ownerId, botId: BOT }).then(id => id === chat ? BOT : null) : null } }),
    now: () => new Date(f.state.clock) });
  return { ...f, state: f.state, originState: f.state, hooks, policy: state, proposals, approvals, registry, subscription, taskDependencies, host, admission, tasks, canonical, adapter, adapterOptions, catalog: extra?.catalog, runBot, transport, interactions,
    submit: async (operation = { operation: "propose" as const, requestId: "de000000-0000-4000-8000-000000000100", proposal }) => f.execute(operation, proposals),
    close: async () => { await canonical.drain(); await canonical.close(); await f.close(); } };
}
