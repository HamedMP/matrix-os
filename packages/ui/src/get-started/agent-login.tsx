import type { GetStartedAgentKind, ProviderAccessSource, ProviderAccount, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useEffect, useState, type ComponentType } from "react";
import { HarnessWorkflowPanel } from "../agents-providers/HarnessWorkflowPanel.js";
import { hasConfiguredConnection, resolveHarnessConnection } from "../agents-providers/harness-connection.js";
import { managedConnectionCapability } from "../agents-providers/managed-connection-capability.js";
import { ReadOnlyNotice } from "../agents-providers/ReadOnlyNotice.js";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../agents-providers/types.js";
import { connectedAccountLabel, providerName } from "../agents-providers/utils.js";

/** What a surface's Settings > Agents & providers already has: the V3 snapshot and the workflow client. */
export interface GetStartedAgentLoginPort {
  snapshot: ProviderSettingsSnapshot | null;
  failed: boolean;
  workflowClient: ProviderWorkflowClient;
  refresh(): void | Promise<void>;
  openAuthorizationUrl(url: string): void;
}

/** A surface's component that supplies the port for one agent's sign-in. */
export type GetStartedAgentLoginHost = ComponentType<{ agent: GetStartedAgentKind }>;

const AGENT_NAMES: Record<GetStartedAgentKind, string> = { claude: "Claude Code", codex: "Codex" };

/** The wizard cannot show Terminal, so only browser, device-code and API-key sign-ins are offered. */
function withoutTerminal(capability: ProviderWorkflowUICapability): ProviderWorkflowUICapability {
  return {
    ...capability,
    loginMethods: capability.loginMethods.filter((method) => method !== "terminal"),
    ...(capability.connectionOptions ? { connectionOptions: capability.connectionOptions.filter((option) => option.method !== "terminal") } : {}),
  };
}

function canSignInHere(capability: ProviderWorkflowUICapability): boolean {
  return capability.loginMethods.length > 0 || capability.apiKeyProviders.length > 0
    || Boolean(capability.connectionOptions?.some((option) => option.availability === "available"));
}

/** The agent's workflow capability, null while loading, or "unavailable" when this computer has none. */
function useAgentCapability(client: ProviderWorkflowClient, agent: GetStartedAgentKind, refreshedAt: string | undefined) {
  const [capability, setCapability] = useState<ProviderWorkflowUICapability | "unavailable" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    client.capabilities(controller.signal).then((all) => {
      if (controller.signal.aborted) return;
      const found = all.find((item) => item.harness === agent);
      setCapability(found ? withoutTerminal(managedConnectionCapability(found)) : "unavailable");
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[get-started] Agent sign-in unavailable:", error instanceof Error ? error.name : typeof error);
      setCapability("unavailable");
    });
    return () => controller.abort();
  }, [client, agent, refreshedAt]);
  return capability;
}

/** A green "Connected" and how: the agent's own account (with who) or an API key (with whose). */
function AgentConnected({ agent, account, source }: { agent: GetStartedAgentKind; account?: ProviderAccount; source?: ProviderAccessSource }) {
  const { apiKey, label } = connectedAccountLabel(agent, account, source);
  const who = account?.connectionDetails?.email ?? account?.displayName;
  const detail = apiKey
    ? `${providerName(account?.providerId ?? source?.providerId) ?? "Provider"} API key`
    : who ? `${label} · ${who}` : label;
  return (
    <div className="mxo-gs__agent-connected">
      <span className="mxo-connected"><span className="mxo-dot mxo-dot--on" aria-hidden />Connected</span>
      <span className="mxo-muted">{detail}</span>
    </div>
  );
}

const ignoreTerminal = () => undefined;

/** Settings' install and sign-in panel for an agent that is not connected yet; read only when Settings is. */
function AgentSignIn({ capability, harness, source, snapshot, port, operationId, onOperationId }: {
  capability: ProviderWorkflowUICapability;
  harness: ProviderSettingsSnapshot["harnesses"][number] | undefined;
  source: ProviderAccessSource | undefined;
  snapshot: ProviderSettingsSnapshot;
  port: GetStartedAgentLoginPort;
  operationId: string | null;
  onOperationId: (id: string | null) => void;
}) {
  const readOnly = snapshot.access.mode === "read_only" ? snapshot.access : null;
  return (
    <div className="matrix-agents-providers mxo-gs__agent-login">
      {readOnly ? <ReadOnlyNotice access={readOnly} /> : null}
      <HarnessWorkflowPanel
        harness={harness ?? { id: capability.harnessInstanceId, harness: capability.harness, displayName: capability.displayName, installState: capability.installState, authState: "unknown" }}
        source={source}
        capability={capability}
        client={port.workflowClient}
        disabled={readOnly !== null}
        onRefresh={port.refresh}
        onOpenTerminal={ignoreTerminal}
        onOpenAuthorizationUrl={port.openAuthorizationUrl}
        operationId={operationId ?? capability.activeOperationId ?? null}
        onOperationId={onOperationId}
        terminalAvailable={false}
      />
    </div>
  );
}

/**
 * Spec 635, step 3: the Settings > Agents & providers install and sign-in for the coding agent
 * the owner picked, in place, from the same V3 provider state as Settings. The wizard cannot show
 * Terminal: installs run in the background with progress here, and Terminal sign-ins are not offered.
 */
export function GetStartedAgentLogin({ agent, port }: { agent: GetStartedAgentKind; port: GetStartedAgentLoginPort }) {
  const capability = useAgentCapability(port.workflowClient, agent, port.snapshot?.refreshedAt);
  const [operationId, setOperationId] = useState<string | null>(null);
  const name = capability && capability !== "unavailable" ? capability.displayName : AGENT_NAMES[agent];
  const later = <p className="mxo-muted">You can log in to {name} later in Settings &gt; Agents &amp; providers.</p>;
  if (port.failed || capability === "unavailable") return later;
  if (!port.snapshot || !capability) return <p className="mxo-muted" role="status">Checking {name}…</p>;
  const { snapshot } = port;
  const harness = snapshot.harnesses.find((item) => item.id === capability.harnessInstanceId);
  const { account, source } = harness ? resolveHarnessConnection(harness, snapshot.accounts, snapshot.accessSources) : { account: undefined, source: undefined };
  if (harness && hasConfiguredConnection(harness, source)) return <AgentConnected agent={agent} account={account} source={source} />;
  if (capability.installState === "installed" && !canSignInHere(capability)) return later;
  return <AgentSignIn capability={capability} harness={harness} source={source} snapshot={snapshot} port={port} operationId={operationId} onOperationId={setOperationId} />;
}
