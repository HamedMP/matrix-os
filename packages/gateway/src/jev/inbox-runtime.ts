import type { ChatAgent } from "@matrix-os/contracts";
import { ChatAgentContextError } from "../chat/agent-context.js";
import type { HermesJevScope } from "../chat/hermes-integration-capability.js";
import type { JevHermesCredentials } from "../chat/jev-hermes-credentials.js";
import { boundedOperation } from "../bounded-operation.js";
import { createJevInboxBroker, InboxPreviewError, assertJevInboxProfile } from "./inbox-broker.js";
import type { JevService } from "./service.js";
import { formatJevInboxPresentation } from "./inbox-presentation.js";

const TTL = 10 * 60_000;
const MAX_RUNS = 128;
type Active = { scope: string; expiresAt: number; signal: AbortSignal; onAbort: () => void; ready: boolean };

/** Production composition: exact saved agent binding plus a live restricted run, never model claims. */
export function createJevInboxRuntime(options: {
  ownerId: string;
  getAgent: (ownerId: string, agentId: string) => Promise<ChatAgent | null>;
  resolveCredentials: (ownerId: string, selection: unknown, signal: AbortSignal) => Promise<JevHermesCredentials>;
  verifyRuntime: (root: string, signal: AbortSignal) => Promise<void>;
  fundedPolicyReady: (signal: AbortSignal) => Promise<boolean>;
  fundedReady: (signal: AbortSignal) => Promise<boolean>;
  read: Parameters<typeof createJevInboxBroker>[0]["read"];
  evaluate: JevService["evaluate"];
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const active = new Map<string, Active>();
  const id = (owner: string, run: string) => JSON.stringify([owner, run]);
  const stamp = (scope: HermesJevScope) => JSON.stringify(scope);
  function clearRun(owner: string, run: string): void {
    const key = id(owner, run); const entry = active.get(key);
    if (entry) entry.signal.removeEventListener("abort", entry.onAbort);
    active.delete(key); broker.clearRun(owner, run);
  }
  function sweep(): void {
    for (const [key, entry] of active) if (entry.expiresAt <= now() || entry.signal.aborted) {
      entry.signal.removeEventListener("abort", entry.onAbort); active.delete(key);
      const [owner, run] = JSON.parse(key) as [string, string]; broker.clearRun(owner, run);
    }
  }
  async function saved(owner: string, agentId: string, revision: number): Promise<ChatAgent> {
    if (owner !== options.ownerId) throw new InboxPreviewError("denied");
    const value = await options.getAgent(owner, agentId);
    if (!value || value.archived || value.revision !== revision
      || !value.recipe?.skills.includes("matrix-jev-email-triage")
      || value.recipe.jevInboxTriage?.ownerId !== owner) throw new InboxPreviewError("denied");
    return value;
  }
  async function bound(owner: string, scope: HermesJevScope): Promise<ChatAgent> {
    const value = await saved(owner, scope.agentId, scope.revision);
    const binding = value.recipe!.jevInboxTriage!;
    const { version: _version, ownerId: _ownerId, ...account } = binding;
    if (JSON.stringify(account) !== JSON.stringify(scope.account)
      || !value.recipe!.integrations.some(entry => entry.service === "gmail" && entry.accountLabel === account.accountLabel)) {
      throw new InboxPreviewError("denied");
    }
    return value;
  }
  function admitted(owner: string, scope: HermesJevScope, provisional = false): void {
    sweep();
    const entry = active.get(id(owner, scope.runId));
    if (!entry || entry.scope !== stamp(scope) || entry.signal.aborted || (!provisional && !entry.ready)) throw new InboxPreviewError("denied");
  }
  const broker = createJevInboxBroker({ read: options.read, evaluate: options.evaluate, now,
    authorize: async (owner, scope) => {
      admitted(owner, scope); await bound(owner, scope); admitted(owner, scope);
    } });
  return {
    broker,
    async admit(owner: string, agent: ChatAgent): Promise<void> {
      try {
        await boundedOperation(async signal => {
          const current = await saved(owner, agent.id, agent.revision);
          if (JSON.stringify(current.recipe) !== JSON.stringify(agent.recipe)
            || JSON.stringify(current.selection) !== JSON.stringify(agent.selection)) throw new InboxPreviewError("denied");
          await options.resolveCredentials(owner, current.selection, signal);
          signal.throwIfAborted();
          if (!await options.fundedPolicyReady(signal)) throw new ChatAgentContextError("workflow_funding_required");
          signal.throwIfAborted();
        }, 20_000);
      } catch (error: unknown) {
        if (error instanceof ChatAgentContextError) throw error;
        if (error instanceof InboxPreviewError) throw new ChatAgentContextError("context_unavailable");
        console.warn("[jev-inbox] Setup unavailable:", error instanceof Error ? error.name : "UnknownError");
        throw new ChatAgentContextError("workflow_setup_required");
      }
    },
    launch: {
      resolveCredentials: options.resolveCredentials,
      verifyRuntime: options.verifyRuntime,
      async preflight(owner: string, scope: HermesJevScope, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted(); await bound(owner, scope); signal.throwIfAborted();
        if (!await options.fundedPolicyReady(signal)) throw new ChatAgentContextError("workflow_funding_required");
        signal.throwIfAborted(); sweep();
        const key = id(owner, scope.runId);
        if (active.has(key) || active.size >= MAX_RUNS) throw new InboxPreviewError("denied");
        const onAbort = () => clearRun(owner, scope.runId);
        const entry: Active = { scope: stamp(scope), expiresAt: now() + TTL, signal, onAbort, ready: false };
        active.set(key, entry);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const profile = await options.read(owner, scope, "get_profile", undefined, signal);
          signal.throwIfAborted(); admitted(owner, scope, true); assertJevInboxProfile(profile, scope);
          await bound(owner, scope); admitted(owner, scope, true);
          if (!await options.fundedReady(signal)) throw new ChatAgentContextError("workflow_funding_required");
          signal.throwIfAborted(); await bound(owner, scope); admitted(owner, scope, true);
          entry.ready = true;
        }
        catch (error) { clearRun(owner, scope.runId); throw error; }
      },
      clearRun,
      summary(owner: string, scope: HermesJevScope): string | null {
        try { admitted(owner, scope); return formatJevInboxPresentation(broker.presentation(owner, scope)); }
        catch (error: unknown) {
          if (!(error instanceof InboxPreviewError)) console.warn("[jev-inbox] Summary unavailable:", error instanceof Error ? error.name : "UnknownError");
          return null;
        }
      },
    },
    close(): void {
      for (const key of [...active.keys()]) {
        const [owner, run] = JSON.parse(key) as [string, string]; clearRun(owner, run);
      }
    },
  };
}
