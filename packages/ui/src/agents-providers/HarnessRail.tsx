import type { ReactNode } from "react";
import { isSupportedGenericHarnessCredentialRoute } from "@matrix-os/contracts";
import type { ProviderAccessSource, ProviderHarnessInstance, ProviderHarnessKind } from "@matrix-os/contracts";

/** Runtime symbols, not provider trademarks. Always use a contrasting foreground. */
export function HarnessIcon({ harness }: { harness: ProviderHarnessKind }) {
  const paths: Record<ProviderHarnessKind, string> = {
    claude: "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4L18.4 5.6M8.6 3.7l6.8 16.6M3.7 8.6l16.6 6.8M3.7 15.4l16.6-6.8M8.6 20.3l6.8-16.6",
    codex: "M8 6l-6 6 6 6M16 6l6 6-6 6M14 4l-4 16",
    pi: "M4 7h16M8 7v13M16 7v10c0 2 1 3 3 3",
    opencode: "M5 4h14v16H5zM10 4v16",
    hermes: "M3 6h18l-6 6h6l-9 9 2-8H8l2-4H3z",
    openclaw: "M7 3L3 7l4 5h10l4-5-4-4M7 12v5l5 4 5-4v-5M12 12v9",
  };
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[harness]} /></svg>;
}

function rowStatus(harness: ProviderHarnessInstance, source: ProviderAccessSource | undefined): string {
  if (harness.installState === "missing") return "Install";
  if (harness.installState === "installing") return "Installing…";
  if (harness.installState !== "installed") return "Check failed";
  if (!harness.enabled) return "Disabled";
  if (harness.connectivity === "offline" || harness.connectivity === "degraded") return "Check failed";
  if (harness.authState === "authenticating") return "Signing in…";
  if (harness.authState === "unauthenticated" || harness.authState === "expired") return "Sign in";
  if (harness.connectivity !== "online") return "Check failed";
  if (harness.authState !== "authenticated") return "Check failed";
  if (!source) return "Connect access";
  if (!isSupportedGenericHarnessCredentialRoute(harness, source)) return "Check access";
  if (source.readiness.state === "auth_required" || source.readiness.state === "expired") return "Sign in";
  if (source.readiness.state !== "ready") return "Check access";
  return "Ready";
}

export function HarnessRail({ harnesses, sources, selectedId, disabled, canEnable, onSelect, onEnable, renderDetails }: {
  harnesses: ProviderHarnessInstance[];
  sources: ProviderAccessSource[];
  selectedId: string | null;
  disabled: boolean;
  canEnable: (harness: ProviderHarnessInstance) => boolean;
  onSelect: (id: string) => void;
  onEnable: (harness: ProviderHarnessInstance) => void;
  renderDetails: (harness: ProviderHarnessInstance) => ReactNode;
}) {
  return (
    <section className="matrix-ap-agent-list" aria-label="Installed agents">
      <div className="matrix-ap-list-heading"><h2>Agents</h2><p>Installed agents appear automatically. Expand one to connect and choose a model.</p></div>
      {harnesses.map((harness) => {
        const expanded = harness.id === selectedId;
        const status = rowStatus(harness, sources.find((source) => source.id === harness.accessSourceId));
        const detailsId = `matrix-ap-details-${harness.id}`;
        return (
          <div key={harness.id} className="matrix-ap-agent-row">
            <div className="matrix-ap-agent-row-head">
              <button type="button" className="matrix-ap-rail-item" aria-expanded={expanded} aria-controls={detailsId} onClick={() => onSelect(harness.id)}>
                <span className="matrix-ap-harness-mark" data-accent={harness.accentColor ?? "none"} aria-hidden="true"><HarnessIcon harness={harness.harness} /></span>
                <span className="matrix-ap-rail-copy">
                  <span className="matrix-ap-rail-name">{harness.displayName}{harness.version ? <span>v{harness.version.replace(/^v/, "")}</span> : null}</span>
                  <span className="matrix-ap-rail-status" data-state={status.toLowerCase().replaceAll(" ", "-")}><i aria-hidden="true" />{status}</span>
                </span>
                <span className="matrix-ap-chevron" aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
              </button>
              {canEnable(harness) ? (
                <label className="matrix-ap-switch">
                  <input type="checkbox" role="switch" aria-label={`Enable ${harness.displayName}`} checked={harness.enabled}
                    disabled={disabled || harness.installState !== "installed"} onChange={() => onEnable(harness)} />
                  <span aria-hidden="true" />
                </label>
              ) : null}
            </div>
            <div id={detailsId} className="matrix-ap-agent-details" hidden={!expanded}>{expanded ? renderDetails(harness) : null}</div>
          </div>
        );
      })}
    </section>
  );
}
