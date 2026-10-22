import { useGetStartedConnect, useGetStartedConnectFailures, type GetStartedConnect } from "@matrix-os/ui";
import type { ReactNode } from "react";
import { useConnection } from "../../stores/connection";
import { useIntegrations } from "../integrations/integrations-store";
import { useOnboardingAppConnect } from "../onboarding-widget/use-onboarding-app-connect";

/** Electron Desktop: the wizard connects apps in the system browser, like the onboarding widget. */
export function DesktopGetStartedConnector({ children }: { children: (connect: GetStartedConnect) => ReactNode }) {
  const api = useConnection((state) => state.api);
  const available = useIntegrations((state) => state.available);
  const connections = useIntegrations((state) => state.connections);
  const failures = useGetStartedConnectFailures();
  const appConnect = useOnboardingAppConnect(api, failures.onEvent);
  const connect = useGetStartedConnect({ failures, available, connections, ...appConnect });
  return <>{children(connect)}</>;
}
