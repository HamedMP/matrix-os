import { ProviderAccordion } from "./ProviderAccordion.js";
import { hasConfiguredConnection } from "./harness-connection.js";
import type { ReactNode } from "react";
import type {
  ProviderAccessSource,
  ProviderHarnessInstance,
  ProviderHarnessKind,
  ProviderWorkflowCapability,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import {
  codingAgentArtworkSrc, CODING_AGENT_ARTWORK,
} from "../coding-agent-artwork.js";
/** Settings retains the shipped upstream artwork, per the reviewed design override. */
export function HarnessIcon({ harness }: { harness: ProviderHarnessKind }) {
  const src = harness === "claude" ? "/agents/settings/claude.svg" : harness === "codex" ? "/agents/settings/openai.svg" : CODING_AGENT_ARTWORK[harness].src;
  const size = harness === "claude" ? 22 : harness === "codex" ? 20 : 24;
  return (
    <span
      className="matrix-ap-agent-logo"
      aria-hidden="true"
    >
      <img
        src={codingAgentArtworkSrc(src)}
        alt=""
        className={harness === "claude" ? "matrix-ap-claude-logo" : harness === "codex" ? "matrix-ap-openai-logo" : "matrix-ap-upstream-logo"}
        width={size}
        height={size}
        draggable={false}
        loading="eager"
      />
    </span>
  );
}

/** Connection means a configured account/credential, not a successful model call.
 * Canonical auth/readiness remains untouched for Chat admission and account details. */
export function rowStatus(harness: ProviderHarnessInstance, source: ProviderAccessSource | undefined): string {
  if (harness.installState === "missing") return "Not installed";
  if (harness.installState === "installing") return "Installing";
  if (harness.installState !== "installed") return "Not connected";
  if (harness.authState === "authenticating") return "Connecting";
  return hasConfiguredConnection(harness, source) ? "Connected" : "Not connected";
}

function RowChevron({ expanded }: { expanded: boolean }) {
  // Same Hugeicons ChevronDown geometry used by Settings ChannelCard/SkillsSection.
  return <span className="matrix-ap-chevron" data-expanded={expanded} aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  </span>;
}

export function HarnessRail({
  harnesses,
  sources,
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
  selectedId: string | null;
  disabled: boolean;
  statusOverride?: Record<string, string>;
  canRefreshEnable?: boolean;
  canEnable: (harness: ProviderHarnessInstance) => boolean;
  onSelect: (id: string) => void;
  onEnable: (harness: ProviderHarnessInstance) => void;
  renderDetails: (harness: ProviderHarnessInstance) => ReactNode;
}) {
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
                const status =
                  statusOverride?.[item.id] ?? (observed.installState === "missing"
                      ? "Not installed"
                      : observed.installState === "installing"
                        ? "Installing"
                        : observed.installState === "failed"
                          ? "Needs attention"
                          : "Not connected");
                const detailsId = `matrix-ap-details-${item.id}`;
                return (
                  <div key={item.id} className="matrix-ap-agent-row">
                    <div className="matrix-ap-agent-row-head">
                      <button
                        type="button"
                        className="matrix-ap-rail-item"
                        aria-expanded={expanded}
                        aria-controls={detailsId}
                        id={`${detailsId}-trigger`}
                        onClick={() => onSelect(item.id)}
                      >
                        <span className="matrix-ap-harness-mark">
                          <HarnessIcon harness={observed.harness} />
                        </span>
                        <span className="matrix-ap-rail-copy">
                          <span className="matrix-ap-rail-name">
                            {observed.displayName}
                          </span>
                        </span>
                        <span
                          className="matrix-ap-status-chip"
                          data-state={status.toLowerCase().replaceAll(" ", "-")}
                        >
                          <i aria-hidden="true" />
                          {status}
                        </span>
                        <RowChevron expanded={expanded} />
                      </button>
                    </div>
                    <ProviderAccordion id={detailsId} expanded={expanded}>
                      {item.inventory ? renderInventory?.(item.inventory) : renderCatalog?.(item.catalog!)}
                    </ProviderAccordion>
                  </div>
                );
              }
              const harness = item.instance!;
              const source = sources.find(
                (source) => source.id === harness.accessSourceId,
              );
              const status =
                statusOverride?.[harness.id] ?? rowStatus(harness, source);
              const detailsId = `matrix-ap-details-${harness.id}`;
              return (
                <div key={harness.id} className="matrix-ap-agent-row">
                  <div className="matrix-ap-agent-row-head">
                    <button
                      type="button"
                      className="matrix-ap-rail-item"
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                        id={`${detailsId}-trigger`}
                      onClick={() => onSelect(harness.id)}
                    >
                      <span
                        className="matrix-ap-harness-mark"
                        data-accent={harness.accentColor ?? "none"}
                        aria-hidden="true"
                      >
                        <HarnessIcon harness={harness.harness} />
                      </span>
                      <span className="matrix-ap-rail-copy">
                        <span className="matrix-ap-rail-name">
                          {harness.harness === "claude" && harness.displayName === "Claude" ? "Claude Code" : harness.displayName}
                        </span>
                      </span>
                      <span
                        className="matrix-ap-status-chip"
                        data-state={status.toLowerCase().replaceAll(" ", "-")}
                      >
                        <i aria-hidden="true" />
                        {status}
                      </span>

                      <RowChevron expanded={expanded} />
                    </button>
                  </div>
                  <ProviderAccordion id={detailsId} expanded={expanded}>
                    {renderDetails(harness)}
                  </ProviderAccordion>
                </div>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}
