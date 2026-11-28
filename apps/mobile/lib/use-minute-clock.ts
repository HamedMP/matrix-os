import { useEffect, useState } from "react";
import { AppState } from "react-native";

/** Keep list dates current, pause in the background, and catch up on return. */
export function useMinuteClock(enabled = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 60_000);
    };
    if (AppState.currentState !== "background" && AppState.currentState !== "inactive") start();
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") start();
      else stop();
    });
    return () => { stop(); subscription.remove(); };
  }, [enabled]);
  return now;
}
