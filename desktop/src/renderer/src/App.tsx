import { useEffect } from "react";
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
    <div className="flex h-full flex-col" style={{ background: "var(--bg-app)" }}>
      {status === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="status-pulse text-sm" style={{ color: "var(--text-tertiary)" }}>
            Connecting…
          </span>
        </div>
      ) : status === "signed-out" ? (
        <>
          <header className="titlebar-drag" style={{ height: "var(--titlebar-height)" }} />
          <SignIn />
        </>
      ) : (
        <MissionControl />
      )}
    </div>
  );
}
