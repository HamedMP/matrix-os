import type { GetStartedAgentKind, ProviderAccessSource, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useState, type ComponentType, type ReactNode } from "react";
import { ConnectedAccountCard } from "../agents-providers/ConnectedAccountCard.js";
import { HarnessWorkflowPanel } from "../agents-providers/HarnessWorkflowPanel.js";
import { hasConfiguredConnection, resolveHarnessConnection } from "../agents-providers/harness-connection.js";
import { ReadOnlyNotice } from "../agents-providers/ReadOnlyNotice.js";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../agents-providers/types.js";
import { GET_STARTED_AGENT_NAMES, canSignInHere, findAgentHarness, type GetStartedAgentCapabilities } from "./agent-state.js";

/** What a surface's Settings > Agents & providers already has: the V3 snapshot and the workflow client. */
export interface GetStartedAgentLoginPort {
  snapshot: ProviderSettingsSnapshot | null;
  failed: boolean;
  workflowClient: ProviderWorkflowClient;
  refresh(): void | Promise<void>;
  openAuthorizationUrl(url: string): void;
}

/** A surface's provider host: one port for the coding agents screen, mounted only while it shows. */
export type GetStartedAgentLoginHost = ComponentType<{ children: (port: GetStartedAgentLoginPort) => ReactNode }>;

const ignoreTerminal = () => undefined;

/** Settings' install and sign-in panel for an agent that is not connected yet; read only when Settings is. */
function AgentSignIn({ capability, harness, source, snapshot, port, onStateChange }: {
  capability: ProviderWorkflowUICapability;
  harness: ProviderSettingsSnapshot["harnesses"][number] | undefined;
  source: ProviderAccessSource | undefined;
  snapshot: ProviderSettingsSnapshot;
  port: GetStartedAgentLoginPort;
  onStateChange(status: string | null): void;
}) {
  const [operationId, setOperationId] = useState<string | null>(null);
  const readOnly = snapshot.access.mode === "read_only" ? snapshot.access : null;
  return (
    <div className="mxo-gs__agent-login">
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
        onOperationId={setOperationId}
        onStateChange={onStateChange}
        terminalAvailable={false}
      />
    </div>
  );
}

/**
 * Spec 636: what an agent's row shows when expanded. The Settings install and sign-in panel, from
 * the same V3 provider state as Settings, or the Settings connection card once connected. The wizard
 * cannot show Terminal: installs run in the background with progress, Terminal sign-ins are not offered.
 */
export function GetStartedAgentDetails({ agent, capabilities, port, onStateChange }: {
  agent: GetStartedAgentKind;
  capabilities: GetStartedAgentCapabilities | null;
  port: GetStartedAgentLoginPort;
  onStateChange(status: string | null): void;
}) {
  const capability = capabilities?.[agent];
  const name = capability?.displayName ?? GET_STARTED_AGENT_NAMES[agent];
  const later = <p className="mxo-muted">You can log in to {name} later in Settings &gt; Agents &amp; providers.</p>;
  if (port.failed || (capabilities && !capability)) return later;
  if (!port.snapshot || !capability) return <p className="mxo-muted" role="status">Checking {name}…</p>;
  const { snapshot } = port;
  const harness = findAgentHarness(snapshot, agent, capability);
  const { account, source } = harness ? resolveHarnessConnection(harness, snapshot.accounts, snapshot.accessSources) : { account: undefined, source: undefined };
  if (harness && hasConfiguredConnection(harness, source)) {
    return <ConnectedAccountCard harness={harness} account={account} source={source} disabled={snapshot.access.mode === "read_only"} onRefresh={() => void port.refresh()} />;
  }
  if (capability.installState === "installed" && !canSignInHere(capability)) return later;
  return <AgentSignIn capability={capability} harness={harness} source={source} snapshot={snapshot} port={port} onStateChange={onStateChange} />;
}
