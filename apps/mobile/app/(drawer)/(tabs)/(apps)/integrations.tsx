import { ConnectAppsScreen } from "@/components/integrations/ConnectAppsScreen";
import { BackTopBar } from "@/components/shell/BackTopBar";
import { TabScreen } from "@/components/shell/TabScreen";

export default function IntegrationsRoute() {
  return (
    <TabScreen>
      <BackTopBar fallbackHref="/apps" />
      <ConnectAppsScreen openedFrom="apps" />
    </TabScreen>
  );
}
