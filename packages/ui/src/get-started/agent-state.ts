import { GET_STARTED_AGENTS, type GetStartedAgentKind, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useEffect, useMemo, useState } from "react";
import { hasConfiguredConnection, resolveHarnessConnection } from "../agents-providers/harness-connection.js";
import { managedConnectionCapability } from "../agents-providers/managed-connection-capability.js";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../agents-providers/types.js";

// Spec 636: what the coding agents screen derives from the surface's provider state.

export const GET_STARTED_AGENT_NAMES: Record<GetStartedAgentKind, string> = { claude: "Claude Code", codex: "Codex" };

/** Each agent's workflow capability; an agent missing here has no workflow on this computer. */
export type GetStartedAgentCapabilities = Partial<Record<GetStartedAgentKind, ProviderWorkflowUICapability>>;

type Harness = ProviderSettingsSnapshot["harnesses"][number];

/** The wizard cannot show Terminal, so only browser, device-code and API-key sign-ins are offered. */
function withoutTerminal(capability: ProviderWorkflowUICapability): ProviderWorkflowUICapability {
  return {
    ...capability,
    loginMethods: capability.loginMethods.filter((method) => method !== "terminal"),
    ...(capability.connectionOptions ? { connectionOptions: capability.connectionOptions.filter((option) => option.method !== "terminal") } : {}),
  };
}

export function canSignInHere(capability: ProviderWorkflowUICapability): boolean {
  return capability.loginMethods.length > 0 || capability.apiKeyProviders.length > 0
    || Boolean(capability.connectionOptions?.some((option) => option.availability === "available"));
}

function isGetStartedAgent(harness: string): harness is GetStartedAgentKind {
  return (GET_STARTED_AGENTS as readonly string[]).includes(harness);
}

function isHarnessConnected(snapshot: ProviderSettingsSnapshot, harness: Harness): boolean {
  return hasConfiguredConnection(harness, resolveHarnessConnection(harness, snapshot.accounts, snapshot.accessSources).source);
}

/** Each agent's capability: the instance with a connection, else the first one listed. */
function pickAgentCapabilities(all: readonly ProviderWorkflowUICapability[], snapshot: ProviderSettingsSnapshot | null): GetStartedAgentCapabilities {
  const found: GetStartedAgentCapabilities = {};
  for (const agent of GET_STARTED_AGENTS) {
    const candidates = all.filter((item) => item.harness === agent);
    const connected = snapshot ? candidates.find((item) => {
      const harness = findAgentHarness(snapshot, agent, item);
      return harness ? isHarnessConnected(snapshot, harness) : false;
    }) : undefined;
    const capability = connected ?? candidates[0];
    if (capability) found[agent] = capability;
  }
  return found;
}

/** Both agents' capabilities from one request, null while loading; a failed request offers none. */
export function useAgentCapabilities(client: ProviderWorkflowClient, snapshot: ProviderSettingsSnapshot | null): GetStartedAgentCapabilities | null {
  const [all, setAll] = useState<ProviderWorkflowUICapability[] | null>(null);
  const refreshedAt = snapshot?.refreshedAt;
  useEffect(() => {
    const controller = new AbortController();
    client.capabilities(controller.signal).then((items) => {
      if (controller.signal.aborted) return;
      setAll(items.filter((item) => isGetStartedAgent(item.harness)).map((item) => withoutTerminal(managedConnectionCapability(item))));
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[get-started] Agent sign-in unavailable:", error instanceof Error ? error.name : typeof error);
      setAll([]);
    });
    return () => controller.abort();
  }, [client, refreshedAt]);
  return useMemo(() => (all ? pickAgentCapabilities(all, snapshot) : null), [all, snapshot]);
}

/** The agent's harness instance: the one its capability names, else the first of its kind. */
export function findAgentHarness(snapshot: ProviderSettingsSnapshot, agent: GetStartedAgentKind, capability?: ProviderWorkflowUICapability): Harness | undefined {
  return capability
    ? snapshot.harnesses.find((item) => item.id === capability.harnessInstanceId)
    : snapshot.harnesses.find((item) => item.harness === agent);
}

/** Whether any instance of the agent has a configured connection, the same test as its status chip. */
export function isAgentConnected(snapshot: ProviderSettingsSnapshot, agent: GetStartedAgentKind): boolean {
  return snapshot.harnesses.some((harness) => harness.harness === agent && isHarnessConnected(snapshot, harness));
}
