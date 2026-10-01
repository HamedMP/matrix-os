import type { ReactNode } from "react";
import { isSupportedGenericHarnessCredentialRoute } from "@matrix-os/contracts";
import type {
  ProviderAccessSource,
  ProviderHarnessInstance,
  ProviderHarnessKind,
  ProviderWorkflowCapability,
} from "@matrix-os/contracts";
import {
  CODING_AGENT_ARTWORK,
  codingAgentArtworkSrc,
} from "../coding-agent-artwork.js";
import { codexLocalObservationLabel } from "../canonical-provider-choice.js";
import { useLocalObservationExpiry } from "../local-observation-expiry.js";

/** The same shipped artwork and backgrounds used by both Terminal menus. */
export function HarnessIcon({ harness }: { harness: ProviderHarnessKind }) {
  const logo = CODING_AGENT_ARTWORK[harness];
  return (
    <span
      className="matrix-ap-agent-logo"
      style={{ background: logo.background }}
      aria-hidden="true"
    >
      <img
        src={codingAgentArtworkSrc(logo.src)}
        alt=""
        width="20"
        height="20"
        draggable={false}
        loading="eager"
      />
    </span>
  );
}

function rowStatus(
  harness: ProviderHarnessInstance,
  source: ProviderAccessSource | undefined,
): string {
  if (harness.installState === "missing") return "Not installed";
  if (harness.installState === "installing") return "Installing";
  if (harness.installState === "failed") return "Needs attention";
  if (harness.installState !== "installed") return "Check connection";
  if (!harness.enabled && harness.configuredEnabled === true) {
    if (harness.authState === "unauthenticated") return "Not connected";
    if (harness.authState === "failed" || source?.readiness.state === "invalid")
      return "Needs attention";
    if (harness.authState === "authenticating") return "Connecting";
    if (harness.authState === "expired") return "Needs attention";
    if (
      source?.readiness.state === "auth_required" ||
      source?.readiness.state === "expired"
    )
      return "Needs attention";
    return "Check connection";
  }
  if (!harness.enabled)
    return harness.authState === "authenticated"
      ? "Off in Settings · Signed in"
      : "Off in Settings";
  if (harness.authState === "unauthenticated") return "Not connected";
  if (harness.authState === "failed" || source?.readiness.state === "invalid")
    return "Needs attention";
  if (harness.authState === "authenticating") return "Connecting";
  if (
    harness.authState === "expired" ||
    source?.readiness.state === "auth_required" ||
    source?.readiness.state === "expired"
  )
    return "Needs attention";
  if (harness.connectivity === "offline" || harness.connectivity === "degraded")
    return "Check connection";
  if (
    harness.connectivity === "online" &&
    harness.authState === "authenticated" &&
    source?.readiness.state === "ready" &&
    isSupportedGenericHarnessCredentialRoute(harness, source)
  )
    return "Connected";
  if (harness.localObservation)
    return codexLocalObservationLabel(harness.localObservation);
  if (harness.harness === "codex" || source?.localObservation !== undefined)
    return codexLocalObservationLabel(source?.localObservation);
  if (harness.connectivity !== "online") return "Check connection";
  if (harness.authState !== "authenticated") return "Check connection";
  if (!source) return "Connect access";
  if (!isSupportedGenericHarnessCredentialRoute(harness, source))
    return "Check access";
  if (source.readiness.state !== "ready") return "Check access";
  return "Connected";
}

export function HarnessRail({
  harnesses,
  sources,
  selectedId,
  disabled,
  canEnable,
  onSelect,
  onEnable,
  renderDetails,
  statusOverride,
  inventory = [],
  renderInventory,
}: {
  harnesses: ProviderHarnessInstance[];
  inventory?: ProviderWorkflowCapability[];
  renderInventory?: (item: ProviderWorkflowCapability) => ReactNode;
  sources: ProviderAccessSource[];
  selectedId: string | null;
  disabled: boolean;
  statusOverride?: { id: string; status: string | null } | null;
  canEnable: (harness: ProviderHarnessInstance) => boolean;
  onSelect: (id: string) => void;
  onEnable: (harness: ProviderHarnessInstance) => void;
  renderDetails: (harness: ProviderHarnessInstance) => ReactNode;
}) {
  useLocalObservationExpiry([
    ...sources.map((source) => source.localObservation?.staleAfter),
    ...harnesses.map((harness) => harness.localObservation?.staleAfter),
  ]);
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
          })),
          ...inventory.map((item) => ({
            id: item.harnessInstanceId,
            harness: item.harness,
            instance: null,
            inventory: item,
          })),
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
              if (item.inventory) {
                const observed = item.inventory;
                const status =
                  statusOverride?.id === item.id && statusOverride.status
                    ? statusOverride.status
                    : observed.installState === "missing"
                      ? "Not installed"
                      : observed.installState === "installing"
                        ? "Installing"
                        : observed.installState === "failed"
                          ? "Needs attention"
                          : "Check connection";
                const detailsId = `matrix-ap-details-${item.id}`;
                return (
                  <div key={item.id} className="matrix-ap-agent-row">
                    <div className="matrix-ap-agent-row-head">
                      <button
                        type="button"
                        className="matrix-ap-rail-item"
                        aria-expanded={expanded}
                        aria-controls={detailsId}
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
                        <span className="matrix-ap-chevron" aria-hidden="true">
                          {expanded ? "⌃" : "⌄"}
                        </span>
                      </button>
                    </div>
                    <div
                      id={detailsId}
                      hidden={!expanded}
                      className="matrix-ap-agent-details"
                    >
                      {expanded ? renderInventory?.(observed) : null}
                    </div>
                  </div>
                );
              }
              const harness = item.instance!;
              const source = sources.find(
                (source) => source.id === harness.accessSourceId,
              );
              const configuredEnabled =
                harness.configuredEnabled ?? harness.enabled;
              const needsConnection =
                !configuredEnabled &&
                (harness.harness === "pi" || harness.harness === "opencode") &&
                !isSupportedGenericHarnessCredentialRoute(harness, source);
              const toggleDisabled =
                disabled ||
                (!configuredEnabled &&
                  (harness.installState !== "installed" || needsConnection));
              const status =
                statusOverride?.id === harness.id && statusOverride.status
                  ? statusOverride.status
                  : rowStatus(harness, source);
              const detailsId = `matrix-ap-details-${harness.id}`;
              const connectionHintId = `matrix-ap-connection-hint-${harness.id}`;
              return (
                <div key={harness.id} className="matrix-ap-agent-row">
                  <div className="matrix-ap-agent-row-head">
                    <button
                      type="button"
                      className="matrix-ap-rail-item"
                      aria-expanded={expanded}
                      aria-controls={detailsId}
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
                          {harness.displayName}
                        </span>
                      </span>
                      <span
                        className="matrix-ap-status-chip"
                        data-state={status.toLowerCase().replaceAll(" ", "-")}
                      >
                        <i aria-hidden="true" />
                        {status}
                      </span>

                      <span className="matrix-ap-chevron" aria-hidden="true">
                        {expanded ? "⌃" : "⌄"}
                      </span>
                    </button>
                  </div>
                  <div
                    id={detailsId}
                    className="matrix-ap-agent-details"
                    hidden={!expanded}
                  >
                    {expanded ? (
                      <>
                        {renderDetails(harness)}
                        <div className="matrix-ap-enablement">
                          {" "}
                          {canEnable(harness) && expanded ? (
                            <label className="matrix-ap-switch">
                              <input
                                type="checkbox"
                                role="switch"
                                aria-label={`Enable ${harness.displayName}`}
                                checked={configuredEnabled}
                                aria-describedby={
                                  needsConnection &&
                                  harness.installState === "installed"
                                    ? connectionHintId
                                    : undefined
                                }
                                disabled={toggleDisabled}
                                onChange={() => {
                                  if (!toggleDisabled) onEnable(harness);
                                }}
                              />
                              <span aria-hidden="true" />
                            </label>
                          ) : null}
                          <span>Enable this agent</span>
                          {needsConnection ? (
                            <span id={connectionHintId}>
                              Choose a connection to enable
                            </span>
                          ) : null}
                          {harness.version ? (
                            <span>Version {harness.version}</span>
                          ) : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}
