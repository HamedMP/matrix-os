import * as Tooltip from "@radix-ui/react-tooltip";
import { useEffect } from "react";
import { Toaster } from "sonner";
import SignIn from "./features/signin/SignIn";
import MissionControl from "./features/mission-control/MissionControl";
import { useConnection, wireConnectionEvents } from "./stores/connection";

export default function App() {
  const status = useConnection((s) => s.status);
  const refresh = useConnection((s) => s.refresh);

  useEffect(() => {
    wireConnectionEvents();
    void refresh();
  }, [refresh]);

  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <div className="flex h-full flex-col" style={{ background: "var(--bg-app)" }}>
        {status === "loading" ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="status-pulse text-sm" style={{ color: "var(--text-tertiary)" }}>
              Connecting…
            </span>
          </div>
        ) : status === "signed-out" ? (
          <SignIn />
        ) : (
          <MissionControl />
        )}
      </div>
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
  );
}
