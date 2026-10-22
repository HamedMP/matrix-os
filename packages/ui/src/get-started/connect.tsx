import {
  getStartedConnectPlan,
  type AvailableIntegration,
  type ConnectedIntegration,
  type GetStartedAnswers,
  type GetStartedConnectRow,
  type OnboardingWidgetEvent,
} from "@matrix-os/contracts";
import { useCallback, useId, useMemo, useState, type ComponentType, type ReactNode } from "react";

/** A surface's app connections, read from the same hooks its onboarding widget uses. */
export interface GetStartedConnect {
  availableServices: ReadonlySet<string>;
  connectedServices: ReadonlySet<string>;
  connectingService: string | null;
  failedServices: ReadonlySet<string>;
  /** This computer has no app connection service. */
  unavailable: boolean;
  /** Opens the provider's own sign-in; the wizard never sees tokens or URLs. */
  connect(service: string): void;
}

/** Mounted only while the wizard is open, so its integration requests never run for other owners. */
export type GetStartedConnector = ComponentType<{ children: (connect: GetStartedConnect) => ReactNode }>;

/** Adapts the onboarding widget's connect events, which hosts already emit, into per-service failures. */
export function useGetStartedConnectFailures() {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const onEvent = useCallback((event: OnboardingWidgetEvent) => {
    if (event.type === "connect.failed" || event.type === "connect.unavailable") {
      const service = event.service;
      setFailed((previous) => (previous.includes(service) ? previous : [...previous, service]));
    } else if (event.type === "connect.succeeded") {
      const service = event.service;
      setFailed((previous) => previous.filter((candidate) => candidate !== service));
    }
  }, []);
  const clear = useCallback((service: string) => {
    setFailed((previous) => previous.filter((candidate) => candidate !== service));
  }, []);
  const failedServices = useMemo(() => new Set(failed), [failed]);
  return { failedServices, onEvent, clear };
}

/** Builds the wizard's connect value from a host's integration lists and its widget connect hook. */
export function useGetStartedConnect({ failures, available, connections, connectingService, appsUnavailable, connectApp }: {
  failures: ReturnType<typeof useGetStartedConnectFailures>;
  available: readonly AvailableIntegration[];
  connections: readonly ConnectedIntegration[];
  connectingService: string | null;
  appsUnavailable: boolean;
  connectApp(service: string): void;
}): GetStartedConnect {
  const { failedServices, clear } = failures;
  const availableServices = useMemo(() => new Set(available.map((app) => app.id)), [available]);
  const connectedServices = useMemo(
    () => new Set(connections.filter((connection) => connection.status === "active").map((connection) => connection.service)),
    [connections],
  );
  const connect = useCallback((service: string) => {
    clear(service);
    connectApp(service);
  }, [clear, connectApp]);
  return useMemo(() => ({
    availableServices, connectedServices, connectingService, failedServices, unavailable: appsUnavailable, connect,
  }), [availableServices, connectedServices, connectingService, failedServices, appsUnavailable, connect]);
}

function ConnectAction({ row, connect }: { row: GetStartedConnectRow; connect: GetStartedConnect }) {
  if (row.kind !== "app" || !row.service) return <span className="mxo-gs__later">Later</span>;
  const service = row.service;
  if (connect.connectedServices.has(service)) return <span className="mxo-gs__connected">Connected</span>;
  if (connect.connectingService === service) {
    return <span className="mxo-gs__waiting"><span className="mxo-gs__spinner" aria-hidden />Waiting for {row.label} sign-in…</span>;
  }
  const busy = connect.connectingService !== null;
  if (connect.failedServices.has(service)) {
    return (
      <span className="mxo-gs__retry">
        <span>Sign-in didn't finish</span>
        <button type="button" className="mxo-gs__ghost" disabled={busy} aria-label={`Try connecting ${row.label} again`} onClick={() => connect.connect(service)}>
          Try again
        </button>
      </span>
    );
  }
  return (
    <button type="button" className="mxo-gs__ghost" disabled={busy} aria-label={`Connect ${row.label}`} onClick={() => connect.connect(service)}>
      Connect
    </button>
  );
}

function ConnectRows({ rows, connect, label, labelledBy }: {
  rows: readonly GetStartedConnectRow[];
  connect: GetStartedConnect;
  label?: string;
  labelledBy?: string;
}) {
  return (
    <ul className="mxo-gs__connect" aria-label={label} aria-labelledby={labelledBy}>
      {rows.map((row) => (
        <li key={row.tool} className="mxo-gs__connect-row">
          <span className="mxo-gs__connect-icon" aria-hidden>{row.label.slice(0, 1)}</span>
          <span className="mxo-gs__connect-text">
            <span className="mxo-gs__connect-name">{row.label}</span>
            <span className="mxo-gs__connect-why">{row.why}</span>
          </span>
          <ConnectAction row={row} connect={connect} />
        </li>
      ))}
    </ul>
  );
}

export function GetStartedConnectList({ answers, connect }: { answers: GetStartedAnswers; connect: GetStartedConnect }) {
  const suggestionId = useId();
  const plan = useMemo(() => getStartedConnectPlan(answers, connect.availableServices), [answers, connect.availableServices]);
  if (connect.unavailable) {
    return <p className="mxo-gs__note">You can connect apps from Getting started once you're in.</p>;
  }
  if (plan.rows.length === 0 && plan.suggestions.length === 0) return null;
  return (
    <section className="mxo-gs__connect-section">
      <h3 className="mxo-gs__group-title">Connect your tools</h3>
      {plan.rows.length > 0 ? <ConnectRows rows={plan.rows} connect={connect} label="Connect your tools" /> : null}
      {plan.suggestionTitle ? (
        <>
          <h4 id={suggestionId} className="mxo-gs__group-title mxo-gs__suggestion-title">{plan.suggestionTitle}</h4>
          <ConnectRows rows={plan.suggestions} connect={connect} labelledBy={suggestionId} />
        </>
      ) : null}
      <p className="mxo-gs__note">Optional. Each one opens the app's own sign-in. Anything you skip stays in Getting started.</p>
    </section>
  );
}
