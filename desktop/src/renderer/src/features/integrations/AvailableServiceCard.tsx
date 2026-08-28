// Figma-style catalog card. The card is deliberately stateful: a connected
// service gets the green check affordance, while an available service gets a
// compact plus action. Account details remain accessible without changing the
// compact visual treatment of the card.
import { Button } from "../../design/primitives";
import { Check, Plus, X } from "@renderer/lib/hugeicons";
import { IntegrationIcon } from "./IntegrationIcon";
import { displayIntegrationName, type AvailableIntegration, type ConnectedIntegration } from "./types";

const INTEGRATION_DESCRIPTIONS: Record<string, string> = {
  github: "Manage repos, issues, and pull requests",
  notion: "Search, update, and organize workspace",
  slack: "Send messages and manage channels",
  linear: "Manage issues, projects & team workflows",
  figma: "Generate diagrams and export designs",
  google_drive: "Search, read, and upload files",
  jira: "Access issues and project boards",
  hubspot: "CRM context for every answer and action",
};

export function AvailableServiceCard({
  service,
  connected,
  connecting,
  disabled,
  connection,
  connections = connection ? [connection] : [],
  onConnect,
  onDisconnect,
}: {
  service: AvailableIntegration;
  connected: boolean;
  connecting: boolean;
  disabled: boolean;
  connection?: ConnectedIntegration;
  connections?: ConnectedIntegration[];
  onConnect: () => void;
  onDisconnect?: (connection: ConnectedIntegration) => void;
}) {
  const description = service.description ?? INTEGRATION_DESCRIPTIONS[service.id] ?? "Connect this service to extend your agent.";
  // A card-level hover action is only unambiguous for one account. Services
  // with several accounts expose an explicit disconnect control per account.
  const actionIsConnected = connected && connections.length === 1 && connection !== undefined && onDisconnect !== undefined;

  return (
    <div
      data-testid={`integration-card-${service.id}`}
      className="group relative flex min-h-[72px] items-center gap-3 rounded-xl border p-3"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <IntegrationIcon name={service.name} logoUrl={service.logoUrl} testId={`integration-icon-${service.id}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-md" style={{ color: "var(--text-primary)" }}>
          {service.name}
        </p>
        <p className="truncate text-sm" style={{ color: "var(--text-tertiary)" }}>
          {description}
        </p>
        <span className="sr-only">
          <span>Category: </span>
          <span>{service.category}</span>
        </span>
        {connections.length > 0 ? (
          <span className="sr-only">
            <span>Connected account: </span>
            {connections.map((account) => (
              <span key={account.id}>
                <span>{displayIntegrationName(account.accountLabel)}</span>
                {account.accountEmail ? <span>{account.accountEmail}</span> : null}
                <span>{account.status}</span>
              </span>
            ))}
          </span>
        ) : null}
        {connections.length > 1 && onDisconnect ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {connections.map((account) => (
              <button
                key={account.id}
                type="button"
                className="rounded border px-1.5 py-0.5 text-xs"
                style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
                aria-label={`Disconnect ${displayIntegrationName(account.accountLabel)}`}
                disabled={disabled}
                onClick={() => onDisconnect(account)}
              >
                {displayIntegrationName(account.accountLabel)} ×
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {actionIsConnected ? (
        <div
          data-testid={`integration-connect-${service.id}`}
          className="relative size-7 shrink-0"
          onClick={onConnect}
        >
          <Button
            variant="subtle"
            className="size-7 justify-center rounded-full p-1 px-1!"
            style={{ background: "var(--surface-success-emphasis, #288A5B)", color: "var(--text-on-accent)", borderRadius: "9999px" }}
            aria-label={`Add another ${service.name} account`}
            data-testid={`integration-action-${service.id}`}
            data-state="connected"
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onConnect();
            }}
          >
            <Check size={16} strokeWidth={2.5} aria-hidden="true" />
          </Button>
          <Button
            variant="danger"
            className="pointer-events-none absolute inset-0 size-7 justify-center rounded-full p-1 px-1! opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100"
            aria-label={`Disconnect ${displayIntegrationName(connection.accountLabel)}`}
            data-testid={`integration-disconnect-${connection.id}`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onDisconnect(connection);
            }}
          >
            <span className="sr-only">Disconnect</span>
            <X size={16} />
          </Button>
        </div>
      ) : (
        <div data-testid={`integration-action-${service.id}`} data-state="available" className="size-7 shrink-0">
          <Button
            variant="subtle"
            className="size-7 justify-center rounded-[8px] border p-1 px-1!"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
            aria-label={connecting ? `Connecting ${service.name}` : `Connect ${service.name}`}
            data-testid={`integration-connect-${service.id}`}
            disabled={disabled}
            onClick={onConnect}
          >
            <Plus size={16} aria-hidden="true" />
          </Button>
        </div>
      )}
      {connecting ? <span className="sr-only">Connecting...</span> : null}
    </div>
  );
}
