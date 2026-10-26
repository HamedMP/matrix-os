"use client";

import type { OnboardingWidgetEvent } from "@matrix-os/contracts";
import { useGetStartedConnectFailures } from "@matrix-os/ui";
import { useCallback, useEffect, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { useShellConnectionChanges } from "../onboarding-widget/use-shell-connection-changes";
import { useShellOnboardingIntegrations } from "../onboarding-widget/use-shell-onboarding-integrations";

/**
 * Getting started's app connections on the web: the onboarding widget's own sign-in flow, and a
 * reload whenever a connection changes anywhere (Settings, another tab or the sign-in itself).
 */
export function useGettingStartedConnections(onChanged: () => void) {
  const [gatewayUrl] = useState(getGatewayUrl);
  const subscribeConnectionChanges = useShellConnectionChanges();
  useEffect(() => subscribeConnectionChanges(onChanged), [subscribeConnectionChanges, onChanged]);
  // A sign-in that fails, is blocked or times out is remembered per app until it is tried again.
  const failures = useGetStartedConnectFailures();
  const { onEvent: recordFailure, clear } = failures;
  const onEvent = useCallback((event: OnboardingWidgetEvent) => {
    recordFailure(event);
    if (event.type === "connect.succeeded") onChanged();
  }, [onChanged, recordFailure]);
  const integrations = useShellOnboardingIntegrations(onEvent, { gatewayUrl, subscribeConnectionChanges });
  const { connectApp: startConnect } = integrations;
  const connectApp = useCallback((service: string) => {
    clear(service);
    startConnect(service);
  }, [clear, startConnect]);
  return { connectApp, connectingService: integrations.connectingService, failedServices: failures.failedServices, appsUnavailable: integrations.appsUnavailable };
}
