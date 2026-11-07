// Figma-style catalog card. The card is deliberately stateful: a connected
// service gets the green check affordance, while an available service gets a
// compact plus action. Account details remain accessible without changing the
// compact visual treatment of the card.
import { integrationAuthType, integrationDescription } from "@matrix-os/contracts/integration-marketplace";
import type { IntegrationRowPresentation } from "@matrix-os/ui";
import { Button } from "../../design/primitives";
import { Check, Plus } from "@renderer/lib/hugeicons";
import { IntegrationIcon } from "./IntegrationIcon";
import { displayIntegrationName, type AvailableIntegration, type ConnectedIntegration } from "./types";

export function AvailableServiceCard({
  service,
  connected,
  connecting,
  disabled,
  connectDisabled = disabled,
  connection,
  connections = connection ? [connection] : [],
  onConnect,
  onDisconnect,
  presentation,
}: {
  service: AvailableIntegration;
  connected: boolean;
  connecting: boolean;
  disabled: boolean;
  connectDisabled?: boolean;
  connection?: ConnectedIntegration;
  connections?: ConnectedIntegration[];
  onConnect: () => void;
  onDisconnect?: (connection: ConnectedIntegration) => void;
  presentation?: IntegrationRowPresentation;
}) {
  const description = integrationDescription(service);
  const auth = integrationAuthType(service);
  const detail = presentation?.detail ?? (auth === "keys" ? "API key required" : auth === "oauth" ? "Sign in securely" : "Connect your account");
  const action = presentation ? presentation.action : {
    label: connected ? `Add another ${service.name} account` : connecting ? `Connecting ${service.name}` : `Connect ${service.name}`,
    text: connecting ? "Connecting…" : connected ? "Add account" : "Connect",
    disabled: connectDisabled,
    onClick: onConnect,
  };
  return (
    <div
      data-testid={`integration-card-${service.id}`}
      className="group relative flex min-h-[84px] items-center gap-3 py-3"
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
        <p className={presentation ? "mt-1 truncate text-xs" : "mt-1 text-xs"}
          title={presentation?.detail} role={presentation?.detailIsError ? "alert" : undefined}
          style={{ color: presentation?.detailIsError ? "var(--surface-danger-emphasis, var(--destructive))" : "var(--text-tertiary)" }}>{detail}</p>
        <span className="sr-only">
          <span>Category: </span>
          <span>{service.category}</span>
        </span>
        {connections.length > 0 ? (
          <div className="mt-1 flex flex-col gap-1" aria-label={`${service.name} connected accounts`}>
            {connections.map((account) => (
              <div key={account.id} className="flex min-w-0 items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                <span className="font-medium">{displayIntegrationName(account.accountLabel)}</span>
                {account.accountEmail ? <span className="truncate">{account.accountEmail}</span> : null}
                <span className="capitalize" style={{ color: "var(--surface-success-emphasis, #288A5B)" }}>{account.status}</span>
                {onDisconnect ? (
                  <button
                    type="button"
                    data-testid={`integration-disconnect-${account.id}`}
                    className="ml-auto shrink-0 rounded border px-1.5 py-0.5"
                    style={{ borderColor: "var(--border-subtle)" }}
                    aria-label={`Disconnect ${displayIntegrationName(account.accountLabel)}`}
                    disabled={disabled}
                    onClick={() => onDisconnect(account)}
                  >
                    Disconnect
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div
        data-testid={`integration-action-${service.id}`}
        data-state={connected ? "connected" : "available"}
        className={connected ? "flex shrink-0 items-center gap-2 self-start" : "shrink-0"}
      >
        {connected ? (
          <span
            data-testid={`integration-status-${service.id}`}
            aria-label={presentation?.ready ? `${service.name} ready` : `${service.name} connected`}
            className="flex size-7 items-center justify-center rounded-full"
            style={{ background: "var(--surface-success-emphasis, #288A5B)", color: "var(--text-on-accent)", borderRadius: "9999px" }}
          >
            <Check size={16} strokeWidth={2.5} aria-hidden="true" />
          </span>
        ) : null}
        {action ? (
          <Button
            variant="subtle"
            className="justify-center rounded-full px-3! py-1.5"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
            aria-label={action.label}
            data-testid={`integration-connect-${service.id}`}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.text}
          </Button>
        ) : null}
      </div>
      {connecting ? <span className="sr-only">Connecting...</span> : null}
    </div>
  );
}
