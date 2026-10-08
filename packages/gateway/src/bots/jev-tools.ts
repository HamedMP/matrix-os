import { createHash } from "node:crypto";
import type { ChatAgent, BotToolResult } from "@matrix-os/contracts";
import type { HermesJevScope } from "../chat/hermes-integration-capability.js";
import type { GmailAccountRow } from "../chat/jev-recipe-authority.js";
import { createJevInboxBroker, InboxPreviewError, InboxPreviewInput, InboxReceiptError } from "../jev/inbox-broker.js";
import { createJevInboxBatch } from "../jev/inbox-batch.js";
import { createInboxBatchProcessor } from "../jev/inbox-batch-process.js";
import type { JevInboxBatchStore } from "../jev/inbox-batch-store.js";
import { boundedOperation } from "../bounded-operation.js";
import { BotBrokerActionError } from "./broker-actions.js";
import type { BotRecipeCatalog } from "./recipe-catalog.js";
import type { BotGrantRecord } from "./repositories/grants.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";

export type JevBotWorkflowDependencies = Pick<Parameters<typeof createJevInboxBroker>[0], "read" | "evaluate" | "label"> & {
  fundedReady(signal: AbortSignal): Promise<boolean>;
  listGmailAccounts(ownerId: string): Promise<readonly GmailAccountRow[]>;
  batchStore?: JevInboxBatchStore;
};
type Active = { scope: HermesJevScope; binding: BotRuntimeBinding; signal: AbortSignal; abort: () => void; expiresAt: number; ready: boolean; paidReady: boolean };
const MAX_RUNS = 128;
const TTL = 35 * 60_000;
const key = (owner: string, run: string) => JSON.stringify([owner, run]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown): BotToolResult => ({ ok: true, content: [{ type: "text", text: JSON.stringify(value) }] });

/** Dedicated Pi broker authority; no Hermes process, credential, or general Gmail write tool. */
export function createBotJevTools(deps: {
  agents: { get(owner: { type: "personal"; ownerId: string }, botId: string): Promise<ChatAgent | null> };
  recipes: Pick<BotRecipeCatalog, "resolve">;
  listGrants(ownerId: string, botId: string): Promise<readonly BotGrantRecord[]>;
  signalFor(binding: BotRuntimeBinding): AbortSignal | undefined;
  ensureAccess?(binding: BotRuntimeBinding, signal: AbortSignal): Promise<BotToolResult | null>;
  workflow: JevBotWorkflowDependencies;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let closed = false;
  const active = new Map<string, Active>();
  const pending = new Set<Promise<void>>(); // max MAX_RUNS, removed on settle
  async function derive(binding: BotRuntimeBinding): Promise<HermesJevScope> {
    const agent = await deps.agents.get({ type: "personal", ownerId: binding.ownerId }, binding.botId);
    if (!agent || agent.archived || agent.recipeRef?.recipeId !== "jev-inbox-triage") throw new BotBrokerActionError("not_granted");
    const recipe = deps.recipes.resolve(agent.recipeRef);
    const effects = recipe.integrations.find(entry => entry.service === "gmail")?.effects;
    if (!recipe.capabilities.includes("jev.inbox") || !effects?.includes("read") || !effects.includes("label")) throw new BotBrokerActionError("not_granted");
    const grants = (await deps.listGrants(binding.ownerId, binding.botId)).filter(grant => grant.ownerId === binding.ownerId
      && grant.botId === binding.botId && grant.service === "gmail" && grant.audience === "direct" && !grant.revokedAt
      && (!grant.expiresAt || Date.parse(grant.expiresAt) > now()) && grant.effects.includes("read") && grant.effects.includes("label"));
    const accounts = (await deps.workflow.listGmailAccounts(binding.ownerId)).filter(account => account.service === "gmail"
      && account.status === "active");
    // Disconnected grants do not authorize work or block an approved replacement.
    // Duplicate active labels and multiple usable grants remain ambiguous.
    const usable = grants.flatMap(grant => {
      const matching = accounts.filter(account => account.account_label === grant.accountLabel);
      return matching.length === 1 && matching[0]!.id === grant.connectionId && matching[0]!.account_email
        ? [{ grant, account: matching[0]! }] : [];
    });
    if (usable.length !== 1) throw new BotBrokerActionError("not_granted");
    const { grant, account } = usable[0]!;
    return { kind: "jev_inbox_preview", agentId: binding.botId, runId: binding.runId, revision: agent.revision,
      authorityStamp: digest([agent.recipeRef, grant.grantId, grant.revision, grant.grantedByActorId, grant.expiresAt]),
      account: { service: "gmail", accountLabel: grant.accountLabel, connectionId: grant.connectionId,
        expectedEmail: account.account_email!, labelingEnabled: true } };
  }
  function clear(owner: string, run: string) {
    const entry = active.get(key(owner, run));
    if (!entry) return;
    active.delete(key(owner, run));
    entry.signal.removeEventListener("abort", entry.abort);
    broker.clearRun(owner, run);
    if (batch && pending.size < MAX_RUNS) {
      const work = boundedOperation(() => batch.pause(owner, entry.scope), 20_000).catch(error => {
        console.warn("[jev-bot] Batch pause unavailable", { errorName: error instanceof Error ? error.name : "UnknownError" });
      }).finally(() => pending.delete(work));
      pending.add(work);
    }
  }
  function sweep() { for (const entry of active.values()) if (entry.expiresAt <= now() || entry.signal.aborted) clear(entry.binding.ownerId, entry.binding.runId); }
  async function authorize(owner: string, scope: HermesJevScope) {
    sweep();
    const entry = active.get(key(owner, scope.runId));
    if (!entry || entry.signal.aborted || JSON.stringify(entry.scope) !== JSON.stringify(scope)) throw new BotBrokerActionError("not_granted");
    const currentSignal = deps.signalFor(entry.binding);
    if (currentSignal !== entry.signal || currentSignal.aborted) throw new BotBrokerActionError("stale_generation");
    const current = await derive(entry.binding);
    if (JSON.stringify(current) !== JSON.stringify(scope)) throw new BotBrokerActionError("not_granted");
    currentSignal.throwIfAborted();
  }
  const batch = deps.workflow.batchStore ? createJevInboxBatch({ store: deps.workflow.batchStore, authorize,
    read: deps.workflow.read, process: createInboxBatchProcessor(deps.workflow), now }) : undefined;
  const broker = createJevInboxBroker({ ...deps.workflow, authorize, batch, now });
  async function prepare(entry: Active, signal: AbortSignal, paid: boolean) {
    entry.ready = false;
    try {
      if (paid) {
        await broker.preflight(entry.binding.ownerId, entry.scope, signal);
        if (!await deps.workflow.fundedReady(signal)) throw new BotBrokerActionError("unavailable");
      }
      signal.throwIfAborted(); await authorize(entry.binding.ownerId, entry.scope);
      entry.paidReady = paid; entry.ready = true;
    } catch (error) {
      clear(entry.binding.ownerId, entry.binding.runId);
      // No processing effect has started during admission; known refusals are certain.
      if (error instanceof InboxPreviewError) throw new BotBrokerActionError(error.code === "denied" ? "not_granted" : error.code === "invalid_request" ? "invalid_arguments" : "unavailable");
      throw error;
    }
  }
  return {
    async call(binding: BotRuntimeBinding, args: unknown, signal: AbortSignal): Promise<BotToolResult> {
      if (closed) throw new BotBrokerActionError("unavailable");
      if (!binding.capabilities.includes("jev.inbox")) throw new BotBrokerActionError("not_granted");
      const input = InboxPreviewInput.safeParse(args);
      if (!input.success) throw new BotBrokerActionError("invalid_arguments");
      const runSignal = deps.signalFor(binding);
      if (!runSignal || runSignal.aborted) throw new BotBrokerActionError("stale_generation");
      const bounded = AbortSignal.any([signal, runSignal]);
      bounded.throwIfAborted(); sweep();
      if (!active.has(key(binding.ownerId, binding.runId))) {
        if (deps.ensureAccess) {
          const waiting = await deps.ensureAccess(binding, bounded);
          if (waiting) return waiting;
        }
        const scope = await derive(binding);
        if (closed || runSignal.aborted) throw new BotBrokerActionError("stale_generation");
        if (active.size >= MAX_RUNS) throw new BotBrokerActionError("budget_exhausted");
        const abort = () => clear(binding.ownerId, binding.runId);
        if (active.has(key(binding.ownerId, binding.runId))) throw new BotBrokerActionError("unavailable");
        const admitted: Active = { scope, binding, signal: runSignal, abort, expiresAt: now() + TTL, ready: false, paidReady: false };
        active.set(key(binding.ownerId, binding.runId), admitted);
        runSignal.addEventListener("abort", abort, { once: true });
        await prepare(admitted, bounded, input.data.operation !== "batch_status");
      }
      const entry = active.get(key(binding.ownerId, binding.runId));
      if (!entry) throw new BotBrokerActionError("stale_generation");
      if (!entry.ready) throw new BotBrokerActionError("unavailable");
      if (input.data.operation !== "batch_status" && !entry.paidReady) await prepare(entry, bounded, true);
      // Historical uncertainty belongs to the batch, not to every later tool call.
      // Snapshot server progress before a new processing operation so only newly
      // unconfirmed work marks this call's effect checkpoint unknown.
      const before = input.data.operation === "batch_next" && batch
        ? await batch.execute(binding.ownerId, entry.scope, { operation: "batch_status", jobId: input.data.jobId }, bounded)
        : null;
      const priorUnconfirmed = before?.kind === "batch" ? before.unconfirmed : 0;
      try {
        const result = await broker.execute(binding.ownerId, entry.scope, args, bounded);
        if ((input.data.operation === "evaluate" && result.kind === "labeling_unconfirmed")
          || (input.data.operation === "batch_next" && result.kind === "batch" && result.unconfirmed > priorUnconfirmed)) {
          // Preserve the broker checkpoint's uncertainty; this is not a pre-dispatch refusal.
          throw new Error("Jev Inbox effect remains unconfirmed");
        }
        return text(result);
      }
      catch (error: unknown) {
        const operation = input.data.operation;
        const knownReceiptRefusal = operation === "evaluate" && error instanceof InboxReceiptError;
        if ((operation === "evaluate" || operation === "batch_next") && !knownReceiptRefusal
          && (error instanceof BotBrokerActionError || error instanceof InboxPreviewError)) {
          // Authority can disappear after a partial external effect. Never mark it observed_complete.
          throw new Error("Jev Inbox execution could not be confirmed", { cause: error });
        }
        if (error instanceof InboxPreviewError) throw new BotBrokerActionError(error.code === "denied" ? "not_granted" : error.code === "invalid_request" ? "invalid_arguments" : "unavailable");
        throw error;
      }
    },
    clearRun: clear,
    finishRun(runId: string) { for (const entry of [...active.values()]) if (entry.binding.runId === runId) clear(entry.binding.ownerId, runId); },
    async close() {
      closed = true;
      for (const entry of [...active.values()]) clear(entry.binding.ownerId, entry.binding.runId);
      await Promise.allSettled([...pending]); batch?.close();
    },
  };
}
export type BotJevTools = ReturnType<typeof createBotJevTools>;
