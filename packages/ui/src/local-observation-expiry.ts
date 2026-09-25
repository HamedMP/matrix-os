import { useEffect, useState } from "react";

/** Rerender a mounted status view when its next bounded observation expires. */
export function useLocalObservationExpiry(staleAfters: readonly (string | null | undefined)[]): void {
  const key = staleAfters.filter((value): value is string => Boolean(value)).join("|");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const next = key.split("|")
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value) && value > now)
      .sort((left, right) => left - right)[0];
    if (next === undefined) return;
    const timer = setTimeout(() => setRevision((value) => value + 1), Math.min(next - now + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [key, revision]);
}
