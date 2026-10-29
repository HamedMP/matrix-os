import { Check } from "lucide-react";
import { gettingStartedAppToastText, type GettingStartedAppToast } from "./actions.js";
import { GETTING_STARTED_APP_BRAND_VARS } from "./brand-vars.js";

/** Completion toast (Figma 1938:1226): dark pill with a check, the title and gold points. */
export function GettingStartedAppToastView({ toast }: { toast: GettingStartedAppToast }) {
  return (
    <span className="mxo-gsa-toast" style={GETTING_STARTED_APP_BRAND_VARS} aria-label={gettingStartedAppToastText(toast)}>
      <Check size={14} aria-hidden="true" />
      <span aria-hidden="true">{toast.title}</span>
      <span className="mxo-gsa-toast__points" aria-hidden="true">+{toast.points} pts</span>
    </span>
  );
}
