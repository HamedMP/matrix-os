import { isDeepStrictEqual } from "node:util";
import { isManagedPiBinding, type ManagedPiRuntimeBinding } from "./runtime-registry.js";
import { createDelegatedRoutineSourceProducer } from "./routine-cli-delegated-source.js";
import { createChatRoutineSourceProducer } from "../chat/routine-chat-source.js";
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "./database.js";
import type { ChatRepository } from "../chat/repository.js";
import type { ChatAgentStore } from "../chat/agent-store.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import type { BotStateTransactions } from "./events.js";
import type { BotRoutineApprovals } from "./routine-approval.js";
import type { BotRoutineControl } from "./routine-control.js";
import type { BotRuntimeRegistry } from "./runtime-registry.js";
import { RoutineCliTokenSchema } from "@matrix-os/contracts/routine-cli";
import { createRoutineActionSourceRegistry, type RoutineSourceProducer } from "./routine-action-source-registry.js";
import { createRoutineActionPlatformClient } from "./routine-action-platform-client.js";
import { createRoutineCliActionController } from "./routine-action-controller.js";
import { createRoutineCliCanonicalControl } from "./routine-cli-canonical-control.js";
import { createRoutineCliProposals, type RoutineCliProposalRuntime } from "./routine-cli-proposals.js";
import { createRoutineCliRequestService } from "./routine-cli-requests.js";
import { RoutineCliScopeSchema } from "./repositories/routine-cli-preferences.js";
import { RoutineCliError } from "./routine-cli-errors.js";
/** Startup composition only. No producer is registered here; native Tasks5/6 and Terminal Task7 must supply actual adapters. */
export function createRoutineCliRuntime(options: {
  db: Kysely<OwnerBotDatabase>; computerId: string; configuredOwnerIds: readonly string[]; agents: ChatAgentStore;
  repository: Pick<ChatRepository, "get" | "findTurnAdmission" | "findQueuedAdmission">; transact: BotStateTransactions;
  approvals: Pick<BotRoutineApprovals, "proposeWithin">; control: BotRoutineControl; registry: Pick<BotRuntimeRegistry, "lookupRun" | "inferenceSignal">;
  platform: { platformUrl: string; handle: string; token: string; machineId: string; runtimeSlot: string };
  now?: () => Date;
}) {
  const ownerIds = [...new Set(options.configuredOwnerIds)];
  if (ownerIds.length < 1 || ownerIds.length > 2 || options.configuredOwnerIds.length > 2) throw new Error("Routine source configuration unavailable");
  for (const ownerId of ownerIds) RoutineCliScopeSchema.parse({ ownerId, computerId: options.computerId });
  const platform = createRoutineActionPlatformClient(options.platform), controls = createRoutineCliCanonicalControl({ control: options.control });
  if ([options.db?.transaction, options.agents?.get, options.transact, options.approvals?.proposeWithin,
    options.registry?.lookupRun, options.registry?.inferenceSignal, options.repository?.get, options.repository?.findTurnAdmission, options.repository?.findQueuedAdmission]
    .some(value => typeof value !== "function")) throw new Error("Routine source dependencies unavailable");
  const sourceRegistry = createRoutineActionSourceRegistry({ now: options.now ? () => options.now!().getTime() : undefined });
  let canonical: Pick<CanonicalChatOrchestrator, "admitTurn" | "enqueueQueuedTurn"> | undefined, closed = false;
  const requireCanonical = () => { if (closed || !canonical) throw new RoutineCliError("unavailable"); return canonical; };
  const canonicalPort = { admitTurn: (...args: Parameters<CanonicalChatOrchestrator["admitTurn"]>) => requireCanonical().admitTurn(...args),
    enqueueQueuedTurn: (...args: Parameters<CanonicalChatOrchestrator["enqueueQueuedTurn"]>) => requireCanonical().enqueueQueuedTurn(...args) };
  const scopes = ownerIds.map(ownerId => {
    const scope = { ownerId, computerId: options.computerId };
    const controller = createRoutineCliActionController({ db: options.db, scope, agents: options.agents, registry: sourceRegistry,
      platform: { ...options.platform, verify: platform.verify }, now: options.now ? () => options.now!().getTime() : undefined,
      canAccessTarget: async (target, trx) => target.ownerId === ownerId && target.computerId === options.computerId && Boolean(await trx.selectFrom("chats").select("id")
        .where("id", "=", target.chatId).where("owner_id", "=", ownerId).where("owner_type", "=", "personal").where("lifecycle", "=", "active").where("collaboration", "is", null).executeTakeFirst()),
    });
    const proposals = createRoutineCliProposals({ db: options.db, scope, transact: options.transact, sources: controller.sources, targets: controller.targets,
      authorizeTarget: controller.authorizeTarget, approvals: options.approvals, registry: options.registry,
      canonical: { repository: options.repository, orchestrator: canonicalPort }, now: options.now });
    const requests = createRoutineCliRequestService({ db: options.db, scope, transact: options.transact, sources: controller.sources, targets: controller.targets,
      authorizeTarget: controller.authorizeTarget, now: options.now,
      admitMutation: input => input.operation.operation === "propose" ? proposals.admitMutation(input) : controls.admitMutation(input),
      afterMutationCommit: input => input.operation.operation === "propose" ? proposals.afterMutationCommit(input) : controls.afterMutationCommit(input),
    });
    return { ownerId, controller, proposals, requests };
  });
  let cleaning: Promise<unknown> | undefined;
  const cleanupTimer = setInterval(() => {
    if (closed || cleaning) return;
    cleaning = Promise.all(scopes.map(entry => entry.controller.sources.cleanup()))
      .catch(error => console.warn("[routine-action] Expired capability cleanup unavailable", error instanceof Error ? error.name : "UnknownError"))
      .finally(() => { cleaning = undefined; });
  }, 30_000); cleanupTimer.unref?.();
  const forOwner = (ownerId: string) => { const found = scopes.find(scope => scope.ownerId === ownerId); if (!found || closed) throw new RoutineCliError("permission_denied"); return found; };
  const proposalRuntime: RoutineCliProposalRuntime = {
    beginWithin: (tx, input) => forOwner(input.ownerId).proposals.beginWithin(tx, input),
    consume: (binding, signal) => forOwner(binding.ownerId).proposals.consume(binding, signal),
    recover: input => forOwner(input.ownerId).proposals.recover(input),
  };
  return {
    proposals: proposalRuntime,
    bindCanonical(value: Pick<CanonicalChatOrchestrator, "admitTurn" | "enqueueQueuedTurn">) {
      if (canonical || closed || typeof value.admitTurn !== "function" || typeof value.enqueueQueuedTurn !== "function") throw new Error("Routine canonical dependency unavailable"); canonical = value;
    },
    register(producer: RoutineSourceProducer) { requireCanonical(); return forOwner(producer.source.ownerId).controller.register(producer); },
    async registerChat(input: Omit<Parameters<typeof createChatRoutineSourceProducer>[0], "computerId">) {
      requireCanonical(); const actual = createChatRoutineSourceProducer({ ...input, computerId: options.computerId });
      const ports = await forOwner(actual.producer.source.ownerId).controller.register(actual.producer);
      if (input.signal.aborted || !input.current()) { await ports.revoke(); throw new RoutineCliError("permission_denied"); }
      return { ...ports, narrowNativeMode: actual.narrowNativeMode };
    },
    async registerManagedChat(input: Omit<Parameters<typeof createChatRoutineSourceProducer>[0], "computerId" | "provider"> & { binding: ManagedPiRuntimeBinding }) {
      const binding = structuredClone(input.binding), parentSignal = options.registry.inferenceSignal(binding);
      const current = (invocation?: import("./routine-cli-source.js").RoutineCliVerifiedInvocation) => {
        const actual = options.registry.lookupRun(binding);
        return !!actual && isManagedPiBinding(actual) && isDeepStrictEqual(actual, binding) && parentSignal?.aborted === false
          && binding.ownerId === input.input.owner.ownerId && binding.chatId === input.input.chatId && binding.runId === input.input.runId
          && !binding.group && binding.requestClass === "interactive" && binding.capabilities.includes("routine.cli") && input.current(invocation);
      };
      requireCanonical();
      if (!current() || input.input.owner.type !== "personal" || input.input.sharedScopeId) throw new RoutineCliError("permission_denied");
      const actual = createChatRoutineSourceProducer({ ...input, signal: AbortSignal.any([input.signal, parentSignal!]), current, provider: "matrix_pi", computerId: options.computerId });
      const ports = await forOwner(binding.ownerId).controller.register(actual.producer);
      if (!current() || input.signal.aborted) { await ports.revoke(); throw new RoutineCliError("permission_denied"); }
      return ports;
    },
    async registerBotChild(input: Omit<Parameters<typeof createDelegatedRoutineSourceProducer>[0], "computerId" | "registry">) {
      requireCanonical(); const actual = createDelegatedRoutineSourceProducer({ ...input, computerId: options.computerId, registry: options.registry });
      const ports = await forOwner(actual.source.ownerId).controller.register(actual, { botId: input.binding.botId, chatId: input.binding.chatId });
      if (input.signal.aborted || !input.current()) { await ports.revoke(); throw new RoutineCliError("permission_denied"); }
      return ports;
    },
    get: (principal: RequestPrincipal, id: string) => forOwner(principal.userId).controller.get(principal, id),
    list: (principal: RequestPrincipal) => forOwner(principal.userId).controller.list(principal),
    submit: (...args: Parameters<ReturnType<typeof createRoutineCliActionController>["submit"]>) => forOwner(args[0].userId).controller.submit(...args),
    submitChat: (...args: Parameters<ReturnType<typeof createRoutineCliActionController>["submitChat"]>) => forOwner(args[0]).controller.submitChat(...args),
    async execute(input: Parameters<ReturnType<typeof createRoutineCliRequestService>["execute"]>[0]) {
      requireCanonical(); const token = RoutineCliTokenSchema.parse(input.token), hash = createHash("sha256").update(token).digest("hex");
      // Scope is selected only from actually issued capability storage. Never synthesize an owner principal or trust a body selector.
      const cap = await options.db.selectFrom("routine_cli_capabilities").select(["owner_id", "computer_id"]).where("token_hash", "=", hash)
        .where("computer_id", "=", options.computerId).where("owner_id", "in", ownerIds).limit(2).execute();
      if (cap.length !== 1 || !cap[0]) throw new RoutineCliError("permission_denied");
      return forOwner(cap[0].owner_id).requests.execute(input); // Actual one-shot consume revalidates stored scope/source/decision.
    },
    async close() { closed = true; clearInterval(cleanupTimer); for (const entry of scopes) entry.controller.close(); sourceRegistry.close(); await cleaning; },
  };
}
export type RoutineCliRuntime = ReturnType<typeof createRoutineCliRuntime>;
