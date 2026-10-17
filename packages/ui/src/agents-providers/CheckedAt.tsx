import { useEffect, useState } from "react";
import { relativeCheckedAt } from "./utils.js";

/** Local elapsed-time display; never refreshes the observed snapshot. */
export function CheckedAt({ value }: { value: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!Number.isFinite(Date.parse(value))) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [value]);
  return <span>Checked {relativeCheckedAt(value, now)}</span>;
}
