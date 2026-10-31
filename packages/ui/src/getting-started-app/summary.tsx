import { GETTING_STARTED_APP_TASK_IDS } from "@matrix-os/contracts";
import { ArrowRight } from "lucide-react";
import { GETTING_STARTED_APP_BRAND_VARS } from "./brand-vars.js";
import { useGettingStartedApp } from "./provider.js";

/** Help popover line for the Getting started app (spec 639): progress, points and Open. */
export function GettingStartedAppSummary() {
  const state = useGettingStartedApp();
  if (!state?.enabled || !state.open) return null;
  const points = state.points.kind === "ready" ? `${state.points.total} pts` : "– pts";
  return (
    <button type="button" className="mxo-gsa-summary" style={GETTING_STARTED_APP_BRAND_VARS} onClick={state.open}>
      <span className="mxo-gsa-summary__text">
        <span className="mxo-gsa-summary__title">Open Getting started</span>
        <span className="mxo-gsa-summary__detail">{state.doneCount} of {GETTING_STARTED_APP_TASK_IDS.length} done · {points}</span>
      </span>
      <ArrowRight size={14} aria-hidden="true" />
    </button>
  );
}
