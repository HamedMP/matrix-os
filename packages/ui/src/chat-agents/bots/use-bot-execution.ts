import { useEffect, useState } from "react";
import { botExecutionPresentation, type CanonicalProviderCatalog, type CanonicalChatResourceReference, type ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../client.js";

/** Unknown definition remains a Bot with disabled execution, never an ordinary Chat. */
export function useBotExecution(agentId: string | null, client: ChatAgentClient | undefined,
  catalog: CanonicalProviderCatalog | null | undefined, refreshKey?: number) {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{ agentId: string; client: ChatAgentClient; agent: ChatAgent | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!agentId || !client) return;
    let current = true;
    void client.list().then(result => {
      const agent = result.enabled ? result.agents.find(candidate => candidate.id === agentId && !candidate.archived) : undefined;
      if (current) setSnapshot({ agentId, client, agent: agent ?? null, failed: !agent });
    }).catch((error: unknown) => {
      console.warn("[bots] Definition unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (current) setSnapshot({ agentId, client, agent: null, failed: true });
    });
    return () => { current = false; };
  }, [agentId, client, refreshKey, attempt]);
  useEffect(() => { if (!agentId || !client) return; const timer = setInterval(() => setAttempt(value => value + 1), 15_000); return () => clearInterval(timer); }, [agentId, client]);
  const current = snapshot?.agentId === agentId && snapshot.client === client ? snapshot : null;
  const agent = current?.agent ?? null;
  const presentation = agent ? botExecutionPresentation(agent, catalog) : null;
  const consentResources: CanonicalChatResourceReference[] = agent && presentation?.kind === "custom"
    ? [{ kind: "agent", id: agent.id, label: agent.name, revision: String(agent.revision) }] : [];
  return { agent, presentation, consentResources, loading: Boolean(agentId && !current),
    error: current?.failed ? "Bot settings could not be loaded. Try again." : null, retry: () => setAttempt(value => value + 1) };
}
