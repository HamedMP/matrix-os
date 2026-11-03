import { useEffect, useState } from "react";

/** Re-renders once a minute while visible so Chat start ages stay current. */
export function useMinuteClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Catch up immediately after a long collapse, then tick each minute.
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
