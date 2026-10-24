import {
  isValidServiceId,
  parseAvailableIntegrations,
  parseConnectedIntegrations,
  hasCompletedIntegrationConnection,
  isCompletedIntegrationAttempt,
  parseIntegrationAttemptStatus,
  parseIntegrationConnectResponse,
  type AvailableIntegration,
  type ConnectedIntegration,
  type OnboardingWidgetEvent,
} from "@matrix-os/contracts";
import { startConnectPoll, useGmailConnectionChoice, type OnboardingAppConnect } from "@matrix-os/ui";
import { GmailConnectionOptionsSchema, type GmailConnectionMethod, type GmailConnectionOptions } from "@matrix-os/contracts/integration-marketplace";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";

const REQUEST_TIMEOUT_MS = 10_000;
const LIST_RETRY_DELAYS_MS = [3_000, 10_000, 30_000];

interface Options {
  gatewayUrl?: string;
  fetchFn?: typeof fetch;
  /** Overrides the connect poll backoff; tests only. */
  pollIntervals?: number[];
  /** Overrides the delays before re-reading lists that failed to load; tests only. */
  listRetryDelays?: number[];
  /** Calls back when an app is connected or disconnected elsewhere, such as in Settings; returns an unsubscribe. */
  subscribeConnectionChanges?: (onChange: () => void) => () => void;
}

export interface ShellOnboardingIntegrations extends OnboardingAppConnect {
  available: AvailableIntegration[];
  connections: ConnectedIntegration[];
  gmailChoice: ReturnType<typeof useGmailConnectionChoice>;
}

class IntegrationsRequestError extends Error {
  override readonly name = "IntegrationsRequestError";
  constructor(readonly status: number) {
    super(`IntegrationsRequestFailed:${status}`);
  }
}

async function readJson(fetchFn: typeof fetch, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new IntegrationsRequestError(response.status);
  return response.json();
}

/** The gateway mounts these routes only when an integration service is configured; outages are 5xx. */
function isIntegrationServiceMissing(error: unknown): boolean {
  return error instanceof IntegrationsRequestError && error.status === 404;
}

function errorName(error: unknown): string {
  return error instanceof IntegrationsRequestError ? `${error.name}:${error.status}` : error instanceof Error ? error.name : typeof error;
}

/** Reads the app and connection lists, re-reading whichever failed after each delay. Returns a cancel function. */
function loadIntegrationLists({ gatewayUrl, fetchFn, retryDelays, connectionsRevision, onAvailable, onConnections, onServiceMissing }: {
  gatewayUrl: string;
  fetchFn: typeof fetch;
  retryDelays: readonly number[];
  /** Changes whenever a connection list is applied, so a read that started earlier cannot overwrite a newer sync. */
  connectionsRevision: () => number;
  onAvailable: (available: AvailableIntegration[]) => void;
  onConnections: (connections: ConnectedIntegration[]) => void;
  onServiceMissing: () => void;
}): () => void {
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const skipped = Promise.resolve(null);
  const load = (attempt: number, needAvailable: boolean, needConnections: boolean) => {
    const startedAt = connectionsRevision();
    void Promise.allSettled([
      needAvailable ? readJson(fetchFn, `${gatewayUrl}/api/integrations/available`) : skipped,
      needConnections ? readJson(fetchFn, `${gatewayUrl}/api/integrations`) : skipped,
    ]).then(([availableResult, connectionsResult]) => {
      if (cancelled) return;
      if (needAvailable) {
        if (availableResult.status === "fulfilled") onAvailable(parseAvailableIntegrations(availableResult.value));
        else console.warn("[onboarding-widget] apps unavailable:", errorName(availableResult.reason));
      }
      if (needConnections) {
        if (connectionsResult.status === "fulfilled") {
          if (connectionsRevision() === startedAt) onConnections(parseConnectedIntegrations(connectionsResult.value));
        } else console.warn("[onboarding-widget] connections unavailable:", errorName(connectionsResult.reason));
      }
      if (needAvailable && availableResult.status === "rejected" && isIntegrationServiceMissing(availableResult.reason)) {
        onServiceMissing();
        return;
      }
      const retryAvailable = needAvailable && availableResult.status === "rejected";
      const retryConnections = needConnections && connectionsResult.status === "rejected" && !isIntegrationServiceMissing(connectionsResult.reason);
      if ((!retryAvailable && !retryConnections) || attempt >= retryDelays.length) return;
      retryTimer = setTimeout(() => load(attempt + 1, retryAvailable, retryConnections), retryDelays[attempt]);
    });
  };
  load(0, true, true);
  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
  };
}

/** Lists the owner's apps and runs the popup consent flow behind the widget's Connect buttons. */
export function useShellOnboardingIntegrations(
  dispatch: (event: OnboardingWidgetEvent) => void,
  options: Options = {},
): ShellOnboardingIntegrations {
  const [available, setAvailable] = useState<AvailableIntegration[]>([]);
  const [connections, setConnections] = useState<ConnectedIntegration[]>([]);
  const [connectingService, setConnectingService] = useState<string | null>(null);
  const [appsUnavailable, setAppsUnavailable] = useState(false);
  const appsUnavailableRef = useRef(false);
  const optionsRef = useRef(options);
  const connectionsRef = useRef(connections);
  const connectionsRevisionRef = useRef(0);
  const attemptRef = useRef(0);
  const cancelPollRef = useRef<(() => void) | null>(null);
  const popupRef = useRef<Window | null>(null);
  useEffect(() => {
    optionsRef.current = options;
  });

  const transport = useCallback(() => ({
    gatewayUrl: optionsRef.current.gatewayUrl ?? getGatewayUrl(),
    fetchFn: optionsRef.current.fetchFn ?? fetch,
  }), []);

  const loadGmailOptions = useCallback(async (): Promise<GmailConnectionOptions> => {
    const { gatewayUrl, fetchFn } = transport();
    try {
      return GmailConnectionOptionsSchema.parse(await readJson(fetchFn, `${gatewayUrl}/api/integrations/gmail/connection-options`));
    } catch (error: unknown) {
      if (isIntegrationServiceMissing(error)) return { methods: ["pipedream"], defaultMethod: "pipedream" };
      throw error;
    }
  }, [transport]);
  const gmailChoice = useGmailConnectionChoice(loadGmailOptions);

  const applyConnections = useCallback((next: ConnectedIntegration[]) => {
    connectionsRevisionRef.current += 1;
    connectionsRef.current = next;
    setConnections(next);
  }, []);

  const markAppsUnavailable = useCallback(() => {
    appsUnavailableRef.current = true;
    setAppsUnavailable(true);
  }, []);

  useEffect(() => {
    const { gatewayUrl, fetchFn } = transport();
    return loadIntegrationLists({
      gatewayUrl,
      fetchFn,
      retryDelays: optionsRef.current.listRetryDelays ?? LIST_RETRY_DELAYS_MS,
      connectionsRevision: () => connectionsRevisionRef.current,
      onAvailable: setAvailable,
      onConnections: applyConnections,
      onServiceMissing: markAppsUnavailable,
    });
  }, [applyConnections, markAppsUnavailable, transport]);

  // Settings and other clients change connections without this hook, so re-read the list when they do.
  const subscribeConnectionChanges = options.subscribeConnectionChanges;
  useEffect(() => {
    if (!subscribeConnectionChanges) return;
    let disposed = false;
    // One read at a time: a change that lands mid-read queues one more, so the last read starts
    // after the last change. The revision check still drops a read a newer sync overtook.
    let reading = false;
    let changedSinceRead = false;
    const { gatewayUrl, fetchFn } = transport();
    const refresh = () => {
      if (reading) { changedSinceRead = true; return; }
      reading = true;
      changedSinceRead = false;
      const startedAt = connectionsRevisionRef.current;
      readJson(fetchFn, `${gatewayUrl}/api/integrations`).then((value) => {
        if (!disposed && connectionsRevisionRef.current === startedAt) applyConnections(parseConnectedIntegrations(value));
      }, (error: unknown) => {
        if (!disposed) console.warn("[onboarding-widget] connections refresh failed:", errorName(error));
      }).finally(() => {
        reading = false;
        if (!disposed && changedSinceRead) refresh();
      });
    };
    const unsubscribe = subscribeConnectionChanges(refresh);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [applyConnections, subscribeConnectionChanges, transport]);

  const cancelAttempt = useCallback(() => {
    attemptRef.current += 1;
    cancelPollRef.current?.();
    cancelPollRef.current = null;
    popupRef.current?.close();
    popupRef.current = null;
  }, []);
  useEffect(() => cancelAttempt, [cancelAttempt]);

  const startConnection = useCallback((serviceId: string, connectionMethod?: GmailConnectionMethod) => {
    cancelAttempt();
    const attempt = attemptRef.current;
    const isCurrent = () => attemptRef.current === attempt;
    const settle = (found: boolean) => {
      if (!isCurrent()) return;
      cancelAttempt();
      setConnectingService(null);
      dispatch({ type: found ? "connect.succeeded" : "connect.failed", service: serviceId });
    };
    // Opened synchronously inside the method click so popup blockers allow it.
    const popup = window.open("about:blank", "_blank", "width=600,height=700");
    if (!popup) {
      console.warn("[onboarding-widget] consent window blocked");
      settle(false);
      return;
    }
    popupRef.current = popup;
    setConnectingService(serviceId);
    dispatch({ type: "connect.started" });
    const previousConnections = connectionsRef.current.map(connection => ({ ...connection }));
    const { gatewayUrl, fetchFn } = transport();
    void (async () => {
      const started = parseIntegrationConnectResponse(await readJson(fetchFn, `${gatewayUrl}/api/integrations/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: serviceId, ...(connectionMethod ? { connectionMethod } : {}) }),
      }));
      if (!isCurrent()) { popup.close(); return; }
      if (!started) throw new Error("InvalidConsentResponse");
      const { url, attemptId } = started;
      popup.opener = null;
      popup.location.href = url;
      let completed = false;
      cancelPollRef.current = startConnectPoll({
        ...(optionsRef.current.pollIntervals ? { intervals: optionsRef.current.pollIntervals } : {}),
        tick: async () => {
          if (!isCurrent()) return;
          if (attemptId) {
            // A receipt-bearing connection must settle its own account; inventory alone
            // can contain unrelated accounts or the same account before reauthorization.
            const receipt = parseIntegrationAttemptStatus(await readJson(fetchFn, `${gatewayUrl}/api/integrations/gmail/pipedream/attempts/${attemptId}`));
            if (!isCurrent()) return;
            if (!receipt || receipt.status === "failed" || receipt.status === "expired") { settle(false); return; }
            if (receipt.status === "pending") return;
            const next = parseConnectedIntegrations(await readJson(fetchFn, `${gatewayUrl}/api/integrations`));
            if (!isCurrent()) return;
            applyConnections(next);
            completed = isCompletedIntegrationAttempt(receipt, serviceId, next);
            return;
          }
          const synced = parseConnectedIntegrations(await readJson(fetchFn, `${gatewayUrl}/api/integrations/sync`, { method: "POST" }));
          if (!isCurrent()) return;
          applyConnections(synced);
          completed = hasCompletedIntegrationConnection(previousConnections, serviceId, synced);
          // Check the last sync before treating a provider self-closing window as cancelled.
          if (popup.closed && !completed) settle(false);
        },
        isDone: () => completed,
        onSettled: settle,
      });
    })().catch((error: unknown) => {
      console.warn("[onboarding-widget] app connect failed:", errorName(error));
      popup.close();
      if (!isCurrent()) return;
      if (!isIntegrationServiceMissing(error)) { settle(false); return; }
      cancelAttempt();
      markAppsUnavailable();
      setConnectingService(null);
      dispatch({ type: "connect.unavailable", service: serviceId });
    });
  }, [applyConnections, cancelAttempt, dispatch, markAppsUnavailable, transport]);

  const connectApp = useCallback((serviceId: string) => {
    cancelAttempt();
    gmailChoice.cancel();
    setConnectingService(null);
    if (appsUnavailableRef.current) {
      dispatch({ type: "connect.unavailable", service: serviceId });
      return;
    }
    if (!isValidServiceId(serviceId)) {
      dispatch({ type: "connect.failed", service: serviceId });
      return;
    }
    if (serviceId === "gmail") gmailChoice.request(method => startConnection(serviceId, method));
    else startConnection(serviceId);
  }, [cancelAttempt, dispatch, gmailChoice, startConnection]);

  return { available, connections, connectingService, connectApp, appsUnavailable, gmailChoice };
}
