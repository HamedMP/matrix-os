import { GETTING_STARTED_APP_TASK_IDS, gettingStartedAppNextTask } from "@matrix-os/contracts";
import { Rocket } from "lucide-react";
import type { ReactNode } from "react";
import { DesktopHelpMenu } from "../desktop-top-bar.js";
import { GETTING_STARTED_APP_BRAND_VARS } from "./brand-vars.js";
import { useGettingStartedApp } from "./provider.js";

const TOTAL_TASKS = GETTING_STARTED_APP_TASK_IDS.length;

/**
 * Whether Help shows the Getting started app's single row ("app"), or the older checklist popover
 * ("checklist") on computers that do not serve the app. While the first read is pending Help shows
 * the row too, so the checklist never opens just before the app takes over.
 */
export function useGettingStartedHelpMode(): "app" | "checklist" {
  const state = useGettingStartedApp();
  if (!state?.open) return "checklist";
  return state.availability === "unavailable" ? "checklist" : "app";
}

/** One Help row: opens the app; disabled while this computer is still being checked. */
function GettingStartedAppHelpRow({ closeHelp }: { closeHelp(): void }) {
  const state = useGettingStartedApp();
  const ready = state?.availability === "enabled" && state.open !== null;
  const points = state?.points.kind === "ready" ? state.points.total : null;
  const doneCount = state?.doneCount ?? 0;
  const label = ready
    ? `Getting started — ${doneCount} of ${TOTAL_TASKS} done${points === null ? "" : `, ${points} points`}`
    : "Getting started";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!ready}
      aria-busy={!ready}
      className="mxo-gsa-help relative flex w-full flex-wrap items-center gap-2.5 rounded-md p-2 text-left text-[13px] outline-none hover:bg-foreground/5 focus-visible:bg-foreground/5 disabled:opacity-60"
      style={GETTING_STARTED_APP_BRAND_VARS}
      onClick={() => {
        closeHelp();
        state?.open?.();
      }}
    >
      <Rocket className="size-4" aria-hidden="true" />
      <span className="flex-1">Getting started</span>
      {ready ? <span className="text-xs opacity-70">{doneCount} of {TOTAL_TASKS}{points === null ? "" : ` · ${points} pts`}</span> : null}
      <span className="h-1 w-full overflow-hidden rounded" style={{ background: "var(--gsa-track)" }}>
        <span className="block h-full" style={{ width: `${ready ? (doneCount / TOTAL_TASKS) * 100 : 0}%`, background: "var(--gsa-brand-green)" }} />
      </span>
    </button>
  );
}

/** Help with the app's single Getting started row (spec 639); `extra` adds the surface's own rows below it. */
export function GettingStartedAppHelpMenu({ onSupport, discordIcon, overlay, extra }: {
  onSupport(): void;
  discordIcon: ReactNode;
  overlay?: { acquire(): void; release(): void };
  extra?: (closeHelp: () => void) => ReactNode;
}) {
  const state = useGettingStartedApp();
  const incomplete = state?.availability === "enabled" && gettingStartedAppNextTask(state.tasks) !== null;
  return (
    <DesktopHelpMenu
      incomplete={incomplete}
      onSupport={onSupport}
      discordIcon={discordIcon}
      {...(overlay ? { overlay } : {})}
      gettingStarted={(closeHelp) => (
        <>
          <GettingStartedAppHelpRow closeHelp={closeHelp} />
          {extra?.(closeHelp)}
        </>
      )}
    />
  );
}
