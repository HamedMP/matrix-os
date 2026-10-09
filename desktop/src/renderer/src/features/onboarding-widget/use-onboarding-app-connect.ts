import type { OnboardingWidgetEvent } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { invoke } from "../../lib/operator";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { startConnectPoll } from "../integrations/connect-poll";
import { useIntegrations } from "../integrations/integrations-store";

export interface OnboardingAppConnect {
  connectingService: string | null;
  connectApp: (serviceId: string) => void;
}

/** Opens the integration consent page and waits for the new connection to land. */
export function useOnboardingAppConnect(api: ApiClient | null, dispatch: (event: OnboardingWidgetEvent) => void): OnboardingAppConnect {
  const [connectingService, setConnectingService] = useState<string | null>(null);
  const attemptRef = useRef(0);
  const cancelPollRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (api) void useIntegrations.getState().refresh(api);
  }, [api]);

  useEffect(() => () => {
    attemptRef.current += 1;
    cancelPollRef.current?.();
  }, []);

  const connectApp = useCallback((serviceId: string) => {
    if (!api) { dispatch({ type: "connect.failed" }); return; }
    cancelPollRef.current?.();
    const attempt = ++attemptRef.current;
    const generation = captureRuntimeGeneration();
    const isCurrent = () => attemptRef.current === attempt && isCurrentRuntimeGeneration(generation);
    const fail = () => {
      if (!isCurrent()) return;
      setConnectingService(null);
      dispatch({ type: "connect.failed" });
    };
    setConnectingService(serviceId);
    dispatch({ type: "connect.started" });
    const previousIds = new Set(useIntegrations.getState().connections.map((connection) => connection.id));
    void (async () => {
      const url = await useIntegrations.getState().startConnect(serviceId, api);
      if (!isCurrent()) return;
      if (!url) { fail(); return; }
      await invoke("shell:open-external", { url });
      if (!isCurrent()) return;
      cancelPollRef.current = startConnectPoll({
        tick: async () => {
          if (!isCurrent()) { cancelPollRef.current?.(); return; }
          const result = await useIntegrations.getState().syncNow(api);
          if (result === "superseded") cancelPollRef.current?.();
        },
        isDone: () => useIntegrations.getState().connections.some((connection) => connection.service === serviceId && !previousIds.has(connection.id)),
        onSettled: (found) => {
          if (!isCurrent()) return;
          cancelPollRef.current = null;
          if (!found) { fail(); return; }
          setConnectingService(null);
          dispatch({ type: "connect.succeeded" });
        },
      });
    })().catch((error: unknown) => {
      console.warn("[onboarding-widget] app connect failed:", error instanceof Error ? error.name : typeof error);
      fail();
    });
  }, [api, dispatch]);

  return { connectingService, connectApp };
}
