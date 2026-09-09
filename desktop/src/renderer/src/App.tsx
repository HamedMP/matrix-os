import RuntimeCompatibilityGate from "./features/updates/RuntimeCompatibilityGate";
import { MatrixBootScreen } from "@matrix-os/brand";
import { GettingStartedVisibilityProvider } from "@matrix-os/ui";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useEffect } from "react";
import { Toaster } from "sonner";
import SignIn from "./features/signin/SignIn";
import MissionControl from "./features/mission-control/MissionControl";
import DesktopUpdateExperience from "./features/updates/DesktopUpdateExperience";
import DesktopSupportWidget from "./features/support/DesktopSupportWidget";
import { useAppearance } from "./stores/appearance";
import { useConnection, wireConnectionEvents } from "./stores/connection";

export default function App() {
  const scope = useConnection((s) => JSON.stringify([s.platformHost, s.handle, s.runtimeSlot, s.authGeneration, s.status === "signed-out"]));
  const status = useConnection((s) => s.status);
  const refresh = useConnection((s) => s.refresh);
  const loadAppearance = useAppearance((s) => s.load);

  useEffect(() => {
    wireConnectionEvents();
    void refresh();
    // Apply the persisted theme once at boot; tokens.css keeps the first paint
    // on the Matrix palette until this resolves.
    void loadAppearance();
  }, [loadAppearance, refresh]);

  return (
    <GettingStartedVisibilityProvider scope={scope}>
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <div className="flex h-full flex-col" style={{ background: "var(--bg-app)" }}>
        {status === "loading" ? (
          <MatrixBootScreen label="Connecting to your Matrix computer" />
        ) : status === "signed-out" ? (
          <SignIn />
        ) : (
          <RuntimeCompatibilityGate key={scope}><MissionControl /></RuntimeCompatibilityGate>
        )}
      </div>
      <DesktopSupportWidget />
      <DesktopUpdateExperience />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--bg-overlay)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
          },
        }}
      />
    </Tooltip.Provider>
    </GettingStartedVisibilityProvider>
  );
}
