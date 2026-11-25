/**
 * The Mail agent for a store: one per store and account list, over the
 * host's `MatrixOS.ai`, or null when the host has no model. The composer and
 * the agent panel share its proposal registry, so agent drafts open in the
 * composer as tracked changes.
 */
import { useEffect, useMemo } from "react";
import { bridgeMailAi, type MailAi } from "../agent/ai";
import { createMailAgentContext } from "../agent/context";
import { createMailAgent, type MailAgent } from "../agent/controller";
import type { MailAccountEntry, MailStore } from "../model";

/** Builds the agent; `ai` null means the host has no model. Exported for tests. */
export function buildMailAgent(store: MailStore, entries: readonly MailAccountEntry[], ai: MailAi | null): MailAgent | null {
  if (!ai) return null;
  return createMailAgent(createMailAgentContext({
    ai,
    store,
    providerFor: (accountId) => entries.find((entry) => entry.account.id === accountId)?.provider,
  }));
}

/** `ai` defaults to the host bridge's model; pass null to turn the agent off. */
export function useMailAgent(store: MailStore, entries: readonly MailAccountEntry[], ai?: MailAi | null): MailAgent | null {
  const agent = useMemo(() => buildMailAgent(store, entries, ai === undefined ? bridgeMailAi() : ai), [store, entries, ai]);
  // A task still running when the workspace goes away is cancelled, so it cannot write into a disposed store.
  useEffect(() => () => agent?.cancel(), [agent]);
  return agent;
}
