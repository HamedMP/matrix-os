import { GET_STARTED_AGENTS, type GetStartedAgentKind, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
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

/** Both agents' capabilities from one request, null while loading; a failed request offers none. */
export function useAgentCapabilities(client: ProviderWorkflowClient, refreshedAt: string | undefined): GetStartedAgentCapabilities | null {
  const [capabilities, setCapabilities] = useState<GetStartedAgentCapabilities | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    client.capabilities(controller.signal).then((all) => {
      if (controller.signal.aborted) return;
      const found: GetStartedAgentCapabilities = {};
      for (const item of all) {
        if (isGetStartedAgent(item.harness) && !found[item.harness]) found[item.harness] = withoutTerminal(managedConnectionCapability(item));
      }
      setCapabilities(found);
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[get-started] Agent sign-in unavailable:", error instanceof Error ? error.name : typeof error);
      setCapabilities({});
    });
    return () => controller.abort();
  }, [client, refreshedAt]);
  return capabilities;
}

/** The agent's harness instance: the one its capability names, else the first of its kind. */
export function findAgentHarness(snapshot: ProviderSettingsSnapshot, agent: GetStartedAgentKind, capability?: ProviderWorkflowUICapability): Harness | undefined {
  return capability
    ? snapshot.harnesses.find((item) => item.id === capability.harnessInstanceId)
    : snapshot.harnesses.find((item) => item.harness === agent);
}

/** Whether any instance of the agent has a configured connection, the same test as its status chip. */
export function isAgentConnected(snapshot: ProviderSettingsSnapshot, agent: GetStartedAgentKind): boolean {
  return snapshot.harnesses.some((harness) => harness.harness === agent
    && hasConfiguredConnection(harness, resolveHarnessConnection(harness, snapshot.accounts, snapshot.accessSources).source));
}
