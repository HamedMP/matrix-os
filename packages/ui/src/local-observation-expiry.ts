import { useEffect, useRef, useState } from "react";

/** Return the display clock, or null until replacement evidence is synchronized. */
export function useLocalObservationExpiry(staleAfters: readonly (string | null | undefined)[]): number | null {
  const key = staleAfters.filter((value): value is string => Boolean(value)).join("|");
  const [revision, setRevision] = useState(0);
  const [clock, setClock] = useState(() => ({ key, now: Date.now() }));
  const clockKey = useRef(key);
  useEffect(() => {
    let active = true;
    const updateTime = () => { if (active) setClock({ key, now: Date.now() }); };
    // Synchronize replacement evidence without an impure render.
    // Only key/revision changes own this work; updating the clock cannot rearm it.
    if (clockKey.current !== key) queueMicrotask(() => {
      if (active) { clockKey.current = key; updateTime(); }
    });
    const now = Date.now();
    const next = key.split("|")
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value) && value > now)
      .sort((left, right) => left - right)[0];
    const timer = next === undefined ? undefined : setTimeout(() => {
      updateTime();
      setRevision((value) => value + 1);
    }, Math.min(next - now + 1, 2_147_483_647));
    return () => { active = false; clearTimeout(timer); };
  }, [key, revision]);
  return clock.key === key ? clock.now : null;
}
