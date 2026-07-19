// One connected account row: label, status dot, email, service + connected
// date, and the disconnect affordance. Only display-safe proxy fields.
import { Button, StatusDot } from "../../design/primitives";
import { IntegrationIcon } from "./IntegrationIcon";
import type { ConnectedIntegration } from "./types";

function statusColor(status: string): string {
  if (status === "active") return "var(--status-complete)";
  if (status === "expired") return "var(--status-waiting)";
  return "var(--status-failed)";
}

function formatConnectedAt(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ConnectedServiceRow({
  connection,
  serviceName,
  disconnecting,
  onDisconnect,
}: {
  connection: ConnectedIntegration;
  serviceName: string;
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  const connectedDate = formatConnectedAt(connection.connectedAt);
  return (
    <div
      className="flex items-center gap-3 rounded-xl border p-3"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <IntegrationIcon name={serviceName} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {connection.accountLabel}
          </p>
          <StatusDot color={statusColor(connection.status)} />
          <span className="text-xs capitalize" style={{ color: "var(--text-tertiary)" }}>
            {connection.status}
          </span>
        </div>
        {connection.accountEmail ? (
          <p className="truncate text-xs" style={{ color: "var(--text-secondary)" }}>
            {connection.accountEmail}
          </p>
        ) : null}
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          {serviceName}
          {connectedDate ? ` · Connected ${connectedDate}` : ""}
        </p>
      </div>
      <Button
        variant="subtle"
        aria-label={`Disconnect ${connection.accountLabel}`}
        data-testid={`integration-disconnect-${connection.id}`}
        disabled={disconnecting}
        onClick={onDisconnect}
      >
        Disconnect
      </Button>
    </div>
  );
}
