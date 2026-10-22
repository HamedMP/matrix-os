"use client";

import { useGetStartedConnect, useGetStartedConnectFailures, type GetStartedConnect } from "@matrix-os/ui";
import { useState, type ReactNode } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { useShellConnectionChanges } from "../onboarding-widget/use-shell-connection-changes";
import { useShellOnboardingIntegrations } from "../onboarding-widget/use-shell-onboarding-integrations";

/** Web Desktop and Web Canvas: the wizard connects apps through the onboarding widget's popup consent flow. */
export function ShellGetStartedConnector({ children }: { children: (connect: GetStartedConnect) => ReactNode }) {
  const [gatewayUrl] = useState(getGatewayUrl);
  const failures = useGetStartedConnectFailures();
  // Connections changed in Settings or another window show up here too.
  const subscribeConnectionChanges = useShellConnectionChanges();
  const integrations = useShellOnboardingIntegrations(failures.onEvent, { gatewayUrl, subscribeConnectionChanges });
  const connect = useGetStartedConnect({
    failures,
    available: integrations.available,
    connections: integrations.connections,
    connectingService: integrations.connectingService,
    appsUnavailable: integrations.appsUnavailable,
    connectApp: integrations.connectApp,
  });
  return <>{children(connect)}</>;
}
