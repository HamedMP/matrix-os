import {
  parseAvailableIntegrations,
  parseConnectedIntegrations,
  parseConnectUrl,
  type AvailableIntegration,
  type ConnectedIntegration,
  type OnboardingWidgetEvent,
} from "@matrix-os/contracts";
import { activeConnectionIds, hasNewActiveConnection, startConnectPoll, type OnboardingAppConnect } from "@matrix-os/ui";
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
  useEffect(() => {
    optionsRef.current = options;
  });

  const transport = useCallback(() => ({
    gatewayUrl: optionsRef.current.gatewayUrl ?? getGatewayUrl(),
    fetchFn: optionsRef.current.fetchFn ?? fetch,
  }), []);

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

  useEffect(() => () => {
    attemptRef.current += 1;
    cancelPollRef.current?.();
  }, []);

  const connectApp = useCallback((serviceId: string) => {
    cancelPollRef.current?.();
    cancelPollRef.current = null;
    const attempt = ++attemptRef.current;
    const isCurrent = () => attemptRef.current === attempt;
    if (appsUnavailableRef.current) {
      setConnectingService(null);
      dispatch({ type: "connect.unavailable", service: serviceId });
      return;
    }
    // Opened synchronously inside the click so popup blockers allow it; the consent URL arrives later.
    const popup = window.open("about:blank", "_blank", "width=600,height=700");
    const fail = () => {
      if (!isCurrent()) return;
      setConnectingService(null);
      dispatch({ type: "connect.failed", service: serviceId });
    };
    if (!popup) {
      console.warn("[onboarding-widget] consent window blocked");
      fail();
      return;
    }
    setConnectingService(serviceId);
    dispatch({ type: "connect.started" });
    const previouslyActive = activeConnectionIds(connectionsRef.current, serviceId);
    const { gatewayUrl, fetchFn } = transport();
    void (async () => {
      const url = parseConnectUrl(await readJson(fetchFn, `${gatewayUrl}/api/integrations/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: serviceId }),
      }));
      if (!isCurrent()) { popup.close(); return; }
      if (!url) throw new Error("InvalidConsentUrl");
      popup.opener = null;
      popup.location.href = url;
      cancelPollRef.current = startConnectPoll({
        ...(optionsRef.current.pollIntervals ? { intervals: optionsRef.current.pollIntervals } : {}),
        tick: async () => {
          if (!isCurrent()) return;
          const synced = parseConnectedIntegrations(await readJson(fetchFn, `${gatewayUrl}/api/integrations/sync`, { method: "POST" }));
          if (!isCurrent()) return;
          applyConnections(synced);
          // A closed window ends the attempt unless this last sync found the connection;
          // some sign-in pages close themselves once they finish.
          if (popup.closed && !hasNewActiveConnection(synced, serviceId, previouslyActive)) {
            cancelPollRef.current?.();
            cancelPollRef.current = null;
            fail();
          }
        },
        isDone: () => hasNewActiveConnection(connectionsRef.current, serviceId, previouslyActive),
        onSettled: (found) => {
          if (!isCurrent()) return;
          cancelPollRef.current = null;
          if (!found) { fail(); return; }
          setConnectingService(null);
          dispatch({ type: "connect.succeeded", service: serviceId });
        },
      });
    })().catch((error: unknown) => {
      console.warn("[onboarding-widget] app connect failed:", errorName(error));
      popup.close();
      if (!isIntegrationServiceMissing(error)) { fail(); return; }
      markAppsUnavailable();
      if (!isCurrent()) return;
      setConnectingService(null);
      dispatch({ type: "connect.unavailable", service: serviceId });
    });
  }, [applyConnections, dispatch, markAppsUnavailable, transport]);

  return { available, connections, connectingService, connectApp, appsUnavailable };
}
