import { Maximize2 } from "lucide-react";
import { GETTING_STARTED_APP_BRAND_VARS } from "./brand-vars.js";
import { useGettingStartedApp } from "./provider.js";

/**
 * Help checklist header button (spec 639): opens the Getting started app full size,
 * like the onboarding widget's expand button. Hidden where the computer does not serve the app.
 */
export function GettingStartedAppOpenButton({ onOpened }: { onOpened?(): void }) {
  const state = useGettingStartedApp();
  const open = state?.open;
  if (!state?.enabled || !open) return null;
  return (
    <button
      type="button"
      className="mxo-gsa-open"
      style={GETTING_STARTED_APP_BRAND_VARS}
      aria-label="Open Getting started"
      title="Open Getting started"
      onClick={() => {
        onOpened?.();
        open();
      }}
    >
      <Maximize2 size={14} aria-hidden="true" />
    </button>
  );
}
