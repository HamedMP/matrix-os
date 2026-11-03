import { useLocalObservationExpiry } from "../local-observation-expiry.js";
import { capabilityRowStatus, resolvedWorkflowRowStatus } from "./workflow-row-status.js";
import { AgentRow } from "./AgentRow.js";
import { resolveHarnessConnection } from "./harness-connection.js";
import type { ReactNode } from "react";
import type {
  ProviderAccessSource,
  ProviderAccount,
  ProviderHarnessInstance,
  ProviderHarnessKind,
  ProviderWorkflowCapability,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";

export { HarnessIcon } from "./AgentRow.js";

export function HarnessRail({
  harnesses,
  sources,
  accounts = [],
  selectedId,
  onSelect,
  renderDetails,
  statusOverride,
  inventory = [],
  renderInventory,
  catalog = [],
  renderCatalog,
}: {
  harnesses: ProviderHarnessInstance[];
  inventory?: ProviderWorkflowCapability[];
  catalog?: ProviderSettingsSnapshot["harnessCatalog"];
  renderCatalog?: (entry: ProviderSettingsSnapshot["harnessCatalog"][number]) => ReactNode;
  renderInventory?: (item: ProviderWorkflowCapability) => ReactNode;
  sources: ProviderAccessSource[];
  accounts?: ProviderAccount[];
  selectedId: string | null;
  disabled: boolean;
  statusOverride?: Record<string, string>;
  canRefreshEnable?: boolean;
  canEnable: (harness: ProviderHarnessInstance) => boolean;
  onSelect: (id: string) => void;
  onEnable: (harness: ProviderHarnessInstance) => void;
  renderDetails: (harness: ProviderHarnessInstance) => ReactNode;
}) {
  useLocalObservationExpiry([...sources.map(item => item.localObservation?.staleAfter), ...harnesses.map(item => item.localObservation?.staleAfter)]);
  return (
    <section className="matrix-ap-agent-groups" aria-label="Installed agents">
      {(["Coding agents", "General agents"] as const).map((group) => {
        const order: ProviderHarnessKind[] =
          group === "Coding agents"
            ? ["claude", "codex", "opencode", "pi"]
            : ["hermes", "openclaw"];
        const items = [
          ...harnesses.map((item) => ({
            id: item.id,
            harness: item.harness,
            instance: item,
            inventory: null,
            catalog: null,
          })),
          ...inventory.map((item) => ({
            id: item.harnessInstanceId,
            harness: item.harness,
            instance: null,
            inventory: item,
            catalog: null,
          })),
          ...catalog.map((entry) => ({ id: `catalog:${entry.harness}`, harness: entry.harness, instance: null, inventory: null, catalog: entry })),
        ]
          .filter((item) => order.includes(item.harness))
          .sort((a, b) => order.indexOf(a.harness) - order.indexOf(b.harness));
        if (!items.length) return null;
        return (
          <section
            key={group}
            className="matrix-ap-agent-list"
            aria-label={group}
          >
            <div className="matrix-ap-list-heading">
              <h2>{group}</h2>
            </div>
            {items.map((item) => {
              const expanded = item.id === selectedId;
              if (item.inventory || item.catalog) {
                const observed = item.inventory ?? item.catalog!;
                return (
                  <AgentRow
                    key={item.id}
                    id={item.id}
                    harness={observed.harness}
                    name={observed.displayName}
                    status={capabilityRowStatus(observed.installState, statusOverride?.[item.id])}
                    expanded={expanded}
                    onToggle={() => onSelect(item.id)}
                  >
                    {item.inventory ? renderInventory?.(item.inventory) : renderCatalog?.(item.catalog!)}
                  </AgentRow>
                );
              }
              const harness = item.instance!;
              const source = resolveHarnessConnection(harness, accounts, sources).source;
              return (
                <AgentRow
                  key={harness.id}
                  id={harness.id}
                  harness={harness.harness}
                  name={harness.harness === "claude" && harness.displayName === "Claude" ? "Claude Code" : harness.displayName}
                  status={resolvedWorkflowRowStatus(harness, source, statusOverride?.[harness.id])}
                  accent={harness.accentColor ?? "none"}
                  expanded={expanded}
                  onToggle={() => onSelect(harness.id)}
                >
                  {renderDetails(harness)}
                </AgentRow>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}
