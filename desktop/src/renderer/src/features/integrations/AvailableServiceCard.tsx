// One catalog card: icon initial, name, category, connected badge, and the
// Connect/Add-account action. Connect stays available for connected services
// so the user can add a second account (mirrors the shell behavior).
import { Button } from "../../design/primitives";
import { IntegrationIcon } from "./IntegrationIcon";
import type { AvailableIntegration } from "./types";

export function AvailableServiceCard({
  service,
  connected,
  connecting,
  disabled,
  onConnect,
}: {
  service: AvailableIntegration;
  connected: boolean;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border p-3"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <IntegrationIcon name={service.name} testId={`integration-icon-${service.id}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {service.name}
        </p>
        <p className="text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
          {service.category}
        </p>
      </div>
      {connected ? (
        <span
          className="rounded-full px-2 py-0.5 text-xs"
          style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
        >
          Connected
        </span>
      ) : null}
      <Button
        variant={connected ? "subtle" : "primary"}
        data-testid={`integration-connect-${service.id}`}
        disabled={disabled}
        onClick={onConnect}
      >
        {connecting ? "Connecting..." : connected ? "Add account" : "Connect"}
      </Button>
    </div>
  );
}
