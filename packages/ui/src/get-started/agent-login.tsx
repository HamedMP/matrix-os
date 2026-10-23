import type { GetStartedAgentKind, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useEffect, useState, type ComponentType } from "react";
import { ConnectedAccountCard } from "../agents-providers/ConnectedAccountCard.js";
import { HarnessWorkflowPanel } from "../agents-providers/HarnessWorkflowPanel.js";
import { resolveHarnessConnection } from "../agents-providers/harness-connection.js";
import { managedConnectionCapability } from "../agents-providers/managed-connection-capability.js";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "../agents-providers/types.js";

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

/** The agent's workflow capability, null while loading, or "unavailable" when this computer has none. */
function useAgentCapability(client: ProviderWorkflowClient, agent: GetStartedAgentKind, refreshedAt: string | undefined) {
  const [capability, setCapability] = useState<ProviderWorkflowUICapability | "unavailable" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    client.capabilities(controller.signal).then((all) => {
      if (controller.signal.aborted) return;
      const found = all.find((item) => item.harness === agent);
      setCapability(found ? managedConnectionCapability(found) : "unavailable");
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[get-started] Agent sign-in unavailable:", error instanceof Error ? error.name : typeof error);
      setCapability("unavailable");
    });
    return () => controller.abort();
  }, [client, agent, refreshedAt]);
  return capability;
}

/**
 * Spec 635, step 3: the Settings > Agents & providers sign-in for the coding agent the owner
 * picked, in place. It is the same panel and the same V3 provider state as Settings.
 */
export function GetStartedAgentLogin({ agent, port }: { agent: GetStartedAgentKind; port: GetStartedAgentLoginPort }) {
  const capability = useAgentCapability(port.workflowClient, agent, port.snapshot?.refreshedAt);
  const [operationId, setOperationId] = useState<string | null>(null);
  // A Terminal window would open behind the wizard; the sign-in keeps running and Settings resumes it.
  const [terminalPending, setTerminalPending] = useState(false);
  const name = capability && capability !== "unavailable" ? capability.displayName : AGENT_NAMES[agent];
  if (port.failed || capability === "unavailable") {
    return <p className="mxo-muted">You can log in to {name} later in Settings &gt; Agents &amp; providers.</p>;
  }
  if (!port.snapshot || !capability) return <p className="mxo-muted" role="status">Checking {name}…</p>;
  const { snapshot } = port;
  const harness = snapshot.harnesses.find((item) => item.id === capability.harnessInstanceId);
  const { account, source } = harness ? resolveHarnessConnection(harness, snapshot.accounts, snapshot.accessSources) : { account: undefined, source: undefined };
  return (
    <div className="matrix-agents-providers mxo-gs__agent-login">
      <HarnessWorkflowPanel
        harness={harness ?? { id: capability.harnessInstanceId, harness: capability.harness, displayName: capability.displayName, installState: capability.installState, authState: "unknown" }}
        source={source}
        capability={capability}
        client={port.workflowClient}
        disabled={false}
        onRefresh={port.refresh}
        onOpenTerminal={() => setTerminalPending(true)}
        onOpenAuthorizationUrl={port.openAuthorizationUrl}
        operationId={operationId ?? capability.activeOperationId ?? null}
        onOperationId={setOperationId}
        renderConnection={(action) => (harness
          ? <ConnectedAccountCard harness={harness} account={account} source={source} action={action} disabled={false} onRefresh={port.refresh} />
          : null)}
      />
      {terminalPending ? <p className="mxo-muted" role="status">This sign-in continues in Terminal. After setup, finish it in Settings &gt; Agents &amp; providers.</p> : null}
    </div>
  );
}
