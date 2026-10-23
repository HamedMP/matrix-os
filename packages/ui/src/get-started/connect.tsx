import {
  getStartedConnectBenefit,
  getStartedConnectOrder,
  type AvailableIntegration,
  type ConnectedIntegration,
  type GetStartedGoalId,
  type OnboardingWidgetEvent,
} from "@matrix-os/contracts";
import { Loading03Icon } from "@hugeicons/core-free-icons";
import { useCallback, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { IntegrationMarketplace } from "../integrations/IntegrationMarketplace.js";
import { ButtonRow, Icon } from "../onboarding-widget/parts.js";

/** A surface's app connections, read from the same hooks its onboarding widget uses. */
export interface GetStartedConnect {
  availableServices: ReadonlySet<string>;
  connectedServices: ReadonlySet<string>;
  connectingService: string | null;
  failedServices: ReadonlySet<string>;
  /** Catalog logos by service id, shown like the onboarding widget's app list. */
  logoUrls: ReadonlyMap<string, string>;
  /** The computer's integration catalog, as Settings > Integrations lists it. */
  catalog: readonly AvailableIntegration[];
  /** The surface has read its connections at least once; until then they are unknown, not empty. */
  connectionsLoaded: boolean;
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
export function useGetStartedConnect({ failures, available, connections, connectionsLoaded, connectingService, appsUnavailable, connectApp }: {
  failures: ReturnType<typeof useGetStartedConnectFailures>;
  available: readonly AvailableIntegration[];
  connections: readonly ConnectedIntegration[];
  connectionsLoaded: boolean;
  connectingService: string | null;
  appsUnavailable: boolean;
  connectApp(service: string): void;
}): GetStartedConnect {
  const { failedServices, clear } = failures;
  const availableServices = useMemo(() => new Set(available.map((app) => app.id)), [available]);
  const logoUrls = useMemo(
    () => new Map(available.flatMap((app) => (app.logoUrl ? [[app.id, app.logoUrl] as const] : []))),
    [available],
  );
  const connectedServices = useMemo(
    () => new Set(connections.filter((connection) => connection.status === "active").map((connection) => connection.service)),
    [connections],
  );
  const connect = useCallback((service: string) => {
    clear(service);
    connectApp(service);
  }, [clear, connectApp]);
  return useMemo(() => ({
    availableServices, connectedServices, connectingService, failedServices, logoUrls, catalog: available, connectionsLoaded, unavailable: appsUnavailable, connect,
  }), [availableServices, connectedServices, connectingService, failedServices, logoUrls, available, connectionsLoaded, appsUnavailable, connect]);
}

/** Connect, waiting, connected and retry states for one app, used by the suggested bots. */
export function ServiceConnectAction({ service, label, connect, text = "Connect" }: {
  service: string;
  label: string;
  connect: GetStartedConnect;
  text?: string;
}) {
  if (connect.connectedServices.has(service)) {
    return <span className="mxo-connected"><span className="mxo-dot mxo-dot--on" aria-hidden />Connected</span>;
  }
  if (connect.connectingService === service) {
    return <span className="mxo-muted"><Icon icon={Loading03Icon} size={14} className="mxo-spin" /> Waiting for {label} sign-in…</span>;
  }
  // Another app's pending sign-in never blocks this one; starting it replaces that attempt.
  if (connect.failedServices.has(service)) {
    return (
      <ButtonRow>
        <span className="mxo-failed-line">Sign-in didn't finish</span>
        <button type="button" className="mxo-btn mxo-btn--outline" aria-label={`Try connecting ${label} again`} onClick={() => connect.connect(service)}>
          Try again
        </button>
      </ButtonRow>
    );
  }
  return (
    <button type="button" className="mxo-btn mxo-btn--outline" aria-label={`Connect ${label}`} onClick={() => connect.connect(service)}>
      {text}
    </button>
  );
}

/**
 * Spec 635, step 3: the Settings > Integrations marketplace itself, with the integrations that
 * fit the owner's goals first. Connect opens the app's own sign-in through the surface's host.
 */
export function GetStartedConnectTools({ goals, connect }: { goals: readonly GetStartedGoalId[]; connect: GetStartedConnect | null }) {
  // Each known integration says what it is for, not only what it can do.
  const services = useMemo(() => (connect?.catalog ?? []).map((service) => {
    const benefit = getStartedConnectBenefit(service.id);
    return benefit ? { ...service, description: benefit } : service;
  }), [connect]);
  const connectedIds = useMemo(() => [...(connect?.connectedServices ?? [])], [connect]);
  const failedIds = useMemo(() => [...(connect?.failedServices ?? [])], [connect]);
  // The integrations that fit the goals lead; the marketplace's category sections follow as in Settings.
  const leadingSection = useMemo(() => ({ title: "Suggested for your goals", ids: getStartedConnectOrder(goals) }), [goals]);
  if (!connect || connect.unavailable || services.length === 0) {
    return <p className="mxo-muted">You can connect apps later in Settings.</p>;
  }
  return (
    <section className="mxo-gs__marketplace" aria-label="Integrations">
      <IntegrationMarketplace
        services={services}
        connectedIds={connectedIds}
        connectingId={connect.connectingService}
        failedIds={failedIds}
        leadingSection={leadingSection}
        lockWhileConnecting={false}
        addAccounts={false}
        onConnect={connect.connect}
      />
    </section>
  );
}
