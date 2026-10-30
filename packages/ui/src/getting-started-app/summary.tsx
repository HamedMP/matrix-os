import { GETTING_STARTED_APP_TASK_IDS, gettingStartedAppNextTask } from "@matrix-os/contracts";
import { onboardingChecklist } from "@matrix-os/brand";
import * as Popover from "@radix-ui/react-popover";
import { ArrowRight, Rocket } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { DesktopHelpMenu } from "../desktop-top-bar.js";
import { useGettingStartedPopoverFocus, useGettingStartedVisibility } from "../getting-started-visibility.js";
import { GETTING_STARTED_APP_BRAND_VARS } from "./brand-vars.js";
import { useGettingStartedApp } from "./provider.js";

const TOTAL_TASKS = GETTING_STARTED_APP_TASK_IDS.length;

/**
 * Whether Help's Getting started toggle shows the app summary ("app"), or the older checklist
 * popover ("checklist") on computers that do not serve the app. While the first read is pending
 * Help shows the app row (disabled), so the checklist never opens just before the app takes over.
 */
export function useGettingStartedHelpMode(): "app" | "checklist" {
  const state = useGettingStartedApp();
  if (!state?.open) return "checklist";
  return state.availability === "unavailable" ? "checklist" : "app";
}

const CHECKLIST = onboardingChecklist.colors;

/**
 * Help › Getting started where the computer serves the app (spec 639): the same small toggle
 * popover anchored to the title bar as before, with only the app summary (progress, points and
 * Open Getting started) plus the surface's `extra` rows. It stays open until its row is clicked
 * again, and never opens by itself: the app opens itself after the Get started wizard.
 */
export function GettingStartedAppHelpMenu({ onSupport, discordIcon, overlay, extra, zIndex }: {
  onSupport(): void;
  discordIcon: ReactNode;
  overlay?: { acquire(): void; release(): void };
  /** Rows under the summary, e.g. the Web desktop download; `closePopover` closes the popover. */
  extra?: (closePopover: () => void) => ReactNode;
  /** The surface's popover layer. */
  zIndex: number;
}) {
  const state = useGettingStartedApp();
  const { visible: open, requestedOpen, blocked, setRequestedOpen: setOpen } = useGettingStartedVisibility();
  const { markManualOpen, onOpenAutoFocus, onCloseAutoFocus } = useGettingStartedPopoverFocus();
  const helpTriggerRef = useRef<HTMLButtonElement>(null);
  const ready = state?.availability === "enabled" && state.open !== null;
  const points = state?.points.kind === "ready" ? state.points.total : null;
  const doneCount = state?.doneCount ?? 0;
  const incomplete = ready && state ? gettingStartedAppNextTask(state.tasks) !== null : false;
  const label = ready
    ? `Getting started — ${doneCount} of ${TOTAL_TASKS} done${points === null ? "" : `, ${points} points`}`
    : "Getting started";
  const progress = `${ready ? (doneCount / TOTAL_TASKS) * 100 : 0}%`;
  const close = () => setOpen(false);

  const trigger = (closeHelp: () => void) => (
    <Popover.Trigger asChild>
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={blocked || !ready}
        aria-busy={!ready}
        className="relative flex w-full flex-wrap items-center gap-2.5 rounded-md p-2 text-left text-[13px] outline-none hover:bg-black/5 focus-visible:bg-black/5 disabled:opacity-60"
        onClick={() => {
          if (requestedOpen) setOpen(false);
          closeHelp();
        }}
      >
        <Rocket className="size-4" aria-hidden="true" />
        <span className="flex-1">Getting started</span>
        {ready ? <span className="text-xs">{doneCount} of {TOTAL_TASKS}</span> : null}
        <span className="h-1 w-full overflow-hidden rounded" style={{ background: CHECKLIST.progressTrack }}>
          <span className="block h-full" style={{ width: progress, background: CHECKLIST.progressFill }} />
        </span>
      </button>
    </Popover.Trigger>
  );

  return (
    <Popover.Root open={open && ready} onOpenChange={(nextOpen) => {
      // The title-bar row owns dismissal; Escape, focus changes and outside clicks never close it.
      if (!nextOpen || blocked) return;
      markManualOpen();
      setOpen(true);
    }}>
      <DesktopHelpMenu {...(overlay ? { overlay } : {})} onSupport={onSupport} discordIcon={discordIcon} incomplete={incomplete}
        gettingStarted={trigger} gettingStartedOpen={requestedOpen} onGettingStartedClose={close} triggerRef={helpTriggerRef}
        anchorTrigger={(helpTrigger) => <Popover.Anchor asChild>{helpTrigger}</Popover.Anchor>} />
      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label="Getting started"
          align="end"
          side="bottom"
          sideOffset={7}
          collisionPadding={12}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus(event);
            if (!requestedOpen) {
              event.preventDefault();
              helpTriggerRef.current?.focus();
            }
          }}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="w-[252px] overflow-hidden rounded-[12px] border outline-none"
          style={{
            zIndex,
            background: CHECKLIST.surface,
            borderColor: CHECKLIST.border,
            boxShadow: onboardingChecklist.shadow,
            fontFamily: onboardingChecklist.fontFamily,
          }}
        >
          <div className="flex items-center justify-between whitespace-nowrap px-3 pb-3 pt-4">
            <h2 style={{ color: CHECKLIST.text, fontSize: 16, fontWeight: 400, lineHeight: "normal" }}>Getting started</h2>
            <span data-testid="getting-started-counter" style={{ color: CHECKLIST.subtleText, fontSize: 11, fontWeight: 500, lineHeight: "normal" }}>
              {doneCount} of {TOTAL_TASKS}
            </span>
          </div>
          <div className="px-3 pb-3">
            <div className="h-1 w-full overflow-hidden rounded-[2px]" style={{ background: CHECKLIST.progressTrack }}>
              <div className="h-full transition-[width] duration-200" style={{ width: progress, background: CHECKLIST.progressFill }} />
            </div>
          </div>
          <button
            type="button"
            className="mxo-gsa-summary"
            style={GETTING_STARTED_APP_BRAND_VARS}
            onClick={() => {
              close();
              state?.open?.();
            }}
          >
            <span className="mxo-gsa-summary__text">
              <span className="mxo-gsa-summary__title">Open Getting started</span>
              <span className="mxo-gsa-summary__detail">{doneCount} of {TOTAL_TASKS} done · {points === null ? "–" : points} pts</span>
            </span>
            <ArrowRight size={14} aria-hidden="true" />
          </button>
          {extra ? <div className="pb-1">{extra(close)}</div> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
