import React, { useEffect, useState } from "react";
import { invoke } from "../../lib/operator";
import type { DesktopDevRunSummary } from "../../../../shared/dev-run-label";
import { StatusBanner } from "./StatusBanner";
/** Unpacked-only label for telling side-by-side dev builds apart (MATRIX_DESKTOP_DEV_LABEL). */
export function DevRunBanner() {
  const [run, setRun] = useState<DesktopDevRunSummary | null>(null);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- immutable, bounded main-process presentation metadata is loaded once at application boot.
  useEffect(() => {
    let active = true;
    void invoke("app:get-dev-run", {}).then(value => { if (active) setRun(value); })
      .catch((error: unknown) => console.warn("[dev-run] presentation unavailable", error instanceof Error ? error.name : "UnknownError"));
    return () => { active = false; };
  }, []);
  if (!run) return null;
  const source = [run.branch, run.sha].filter(Boolean).join(" @ ");
  return <StatusBanner>
    <strong>Dev build · {run.label}</strong>
    {source ? <span className="font-mono"> · {source}</span> : null}
    {run.platformOrigin ? <span> · {run.platformOrigin}</span> : null}
    {run.apiOrigin ? <span> · API {run.apiOrigin}</span> : null}
  </StatusBanner>;
}
