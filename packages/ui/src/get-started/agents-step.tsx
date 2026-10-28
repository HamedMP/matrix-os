import { GET_STARTED_AGENTS, type GetStartedAgentKind, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useCallback, useEffect, useState } from "react";
import { AgentRow } from "../agents-providers/AgentRow.js";
import { resolveHarnessConnection } from "../agents-providers/harness-connection.js";
import { gatewayChatAvailableMicrousd, gatewayCreditLines, gatewayCreditStaleAfter } from "../agents-providers/utils.js";
import { capabilityRowStatus, resolvedWorkflowRowStatus, updateWorkflowRowStatus } from "../agents-providers/workflow-row-status.js";
import { useLocalObservationExpiry } from "../local-observation-expiry.js";
import { GetStartedAgentDetails, type GetStartedAgentLoginPort } from "./agent-login.js";
import { GET_STARTED_AGENT_NAMES, findAgentHarness, isAgentConnected, useAgentCapabilities, type GetStartedAgentCapabilities } from "./agent-state.js";

/** The row's chip: Settings' own status once this computer's state is read. */
function agentStatus(agent: GetStartedAgentKind, port: GetStartedAgentLoginPort, capabilities: GetStartedAgentCapabilities | null, override?: string): string {
  if (port.failed) return "Not connected";
  if (!port.snapshot || !capabilities) return "Checking installation";
  const capability = capabilities[agent];
  const harness = findAgentHarness(port.snapshot, agent, capability);
  if (harness) return resolvedWorkflowRowStatus(harness, resolveHarnessConnection(harness, port.snapshot.accounts, port.snapshot.accessSources).source, override);
  return capability ? capabilityRowStatus(capability.installState, override) : "Not connected";
}

/** The spendable Matrix AI credit Settings shows, only while current and above zero. */
function matrixCredit(snapshot: ProviderSettingsSnapshot | null, now: number | null): string | null {
  if (!snapshot || now === null) return null;
  const sources = snapshot.accessSources.filter((source) => source.kind === "matrix_gateway");
  const preferred = sources.find((source) => source.id === snapshot.gatewayPolicy?.accessSourceId);
  for (const source of preferred ? [preferred, ...sources.filter((item) => item !== preferred)] : sources) {
    const available = gatewayChatAvailableMicrousd(source, now);
    if (available !== null && available > 0) return gatewayCreditLines(source, now).primary;
  }
  return null;
}

/** Reports the connected agents once this computer's state is read; unread state is unknown, not none. */
function useReportAgents(snapshot: ProviderSettingsSnapshot | null, failed: boolean, onAgentsConnected: (agents: GetStartedAgentKind[]) => void): void {
  const connected = snapshot && !failed ? GET_STARTED_AGENTS.filter((agent) => isAgentConnected(snapshot, agent)).join(",") : null;
  useEffect(() => {
    if (connected !== null) onAgentsConnected(connected ? connected.split(",") as GetStartedAgentKind[] : []);
  }, [connected, onAgentsConnected]);
}

/**
 * Spec 636: the Get started coding agents screen. Claude Code and Codex as the Settings >
 * Agents & providers rows, with the Matrix AI credit the owner already has above them.
 */
export function GetStartedAgentsStep({ port, onAgentsConnected }: {
  port: GetStartedAgentLoginPort;
  onAgentsConnected(agents: GetStartedAgentKind[]): void;
}) {
  const capabilities = useAgentCapabilities(port.workflowClient, port.snapshot);
  const [expanded, setExpanded] = useState<GetStartedAgentKind | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const now = useLocalObservationExpiry(port.snapshot?.accessSources.map(gatewayCreditStaleAfter) ?? []);
  const credit = matrixCredit(port.snapshot, now);
  const onStateChange = useCallback((agent: GetStartedAgentKind, status: string | null) => {
    setOverrides((current) => updateWorkflowRowStatus(current, agent, status));
  }, []);
  useReportAgents(port.snapshot, port.failed, onAgentsConnected);
  return (
    <div className="matrix-agents-providers mxo-gs__agents">
      {credit ? <p className="mxo-gs__credit">You have {credit} of Matrix AI credit, so Matrix works without signing in.</p> : null}
      <section className="matrix-ap-agent-list" aria-label="Coding agents">
        <div className="matrix-ap-list-heading">
          <h2>Coding agents</h2>
        </div>
        {GET_STARTED_AGENTS.map((agent) => (
          <AgentRow
            key={agent}
            id={`get-started-${agent}`}
            harness={agent}
            name={capabilities?.[agent]?.displayName ?? GET_STARTED_AGENT_NAMES[agent]}
            status={agentStatus(agent, port, capabilities, overrides[agent])}
            expanded={expanded === agent}
            onToggle={() => setExpanded((current) => (current === agent ? null : agent))}
          >
            <GetStartedAgentDetails agent={agent} capabilities={capabilities} port={port} onStateChange={(status) => onStateChange(agent, status)} />
          </AgentRow>
        ))}
      </section>
    </div>
  );
}
