import {
  parseAvailableIntegrations,
  parseConnectedIntegrations,
  parseConnectUrl,
  type AvailableIntegration,
  type ConnectedIntegration,
  type OnboardingWidgetEvent,
} from "@matrix-os/contracts";
import { startConnectPoll, type OnboardingAppConnect } from "@matrix-os/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";

const REQUEST_TIMEOUT_MS = 10_000;

interface Options {
  gatewayUrl?: string;
  fetchFn?: typeof fetch;
  /** Overrides the connect poll backoff; tests only. */
  pollIntervals?: number[];
}

export interface ShellOnboardingIntegrations extends OnboardingAppConnect {
  available: AvailableIntegration[];
  connections: ConnectedIntegration[];
}

async function readJson(fetchFn: typeof fetch, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`IntegrationsRequestFailed:${response.status}`);
  return response.json();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Lists the owner's apps and runs the popup consent flow behind the widget's Connect buttons. */
export function useShellOnboardingIntegrations(
  dispatch: (event: OnboardingWidgetEvent) => void,
  options: Options = {},
): ShellOnboardingIntegrations {
  const [available, setAvailable] = useState<AvailableIntegration[]>([]);
  const [connections, setConnections] = useState<ConnectedIntegration[]>([]);
  const [connectingService, setConnectingService] = useState<string | null>(null);
  const optionsRef = useRef(options);
  const connectionsRef = useRef(connections);
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
    connectionsRef.current = next;
    setConnections(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    const { gatewayUrl, fetchFn } = transport();
    void Promise.allSettled([
      readJson(fetchFn, `${gatewayUrl}/api/integrations/available`),
      readJson(fetchFn, `${gatewayUrl}/api/integrations`),
    ]).then(([availableResult, connectionsResult]) => {
      if (disposed) return;
      if (availableResult.status === "fulfilled") setAvailable(parseAvailableIntegrations(availableResult.value));
      else console.warn("[onboarding-widget] apps unavailable:", errorName(availableResult.reason));
      if (connectionsResult.status === "fulfilled") applyConnections(parseConnectedIntegrations(connectionsResult.value));
      else console.warn("[onboarding-widget] connections unavailable:", errorName(connectionsResult.reason));
    });
    return () => { disposed = true; };
  }, [applyConnections, transport]);

  useEffect(() => () => {
    attemptRef.current += 1;
    cancelPollRef.current?.();
  }, []);

  const connectApp = useCallback((serviceId: string) => {
    cancelPollRef.current?.();
    cancelPollRef.current = null;
    const attempt = ++attemptRef.current;
    const isCurrent = () => attemptRef.current === attempt;
    // Opened synchronously inside the click so popup blockers allow it; the consent URL arrives later.
    const popup = window.open("about:blank", "_blank", "width=600,height=700");
    const fail = () => {
      if (!isCurrent()) return;
      setConnectingService(null);
      dispatch({ type: "connect.failed" });
    };
    if (!popup) {
      console.warn("[onboarding-widget] consent window blocked");
      fail();
      return;
    }
    setConnectingService(serviceId);
    dispatch({ type: "connect.started" });
    const previousIds = new Set(connectionsRef.current.map((connection) => connection.id));
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
          if (isCurrent()) applyConnections(synced);
        },
        isDone: () => connectionsRef.current.some((connection) => connection.service === serviceId && !previousIds.has(connection.id)),
        onSettled: (found) => {
          if (!isCurrent()) return;
          cancelPollRef.current = null;
          if (!found) { fail(); return; }
          setConnectingService(null);
          dispatch({ type: "connect.succeeded" });
        },
      });
    })().catch((error: unknown) => {
      console.warn("[onboarding-widget] app connect failed:", errorName(error));
      popup.close();
      fail();
    });
  }, [applyConnections, dispatch, transport]);

  return { available, connections, connectingService, connectApp };
}
