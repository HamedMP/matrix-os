"use client";

import type { OnboardingWidgetEvent } from "@matrix-os/contracts";
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
  const onEvent = useCallback((event: OnboardingWidgetEvent) => {
    if (event.type === "connect.succeeded") onChanged();
  }, [onChanged]);
  const { connectApp, connectingService, appsUnavailable } = useShellOnboardingIntegrations(onEvent, { gatewayUrl, subscribeConnectionChanges });
  return { connectApp, connectingService, appsUnavailable };
}
