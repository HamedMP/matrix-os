import * as Popover from "@radix-ui/react-popover";
import { onboardingChecklist } from "@matrix-os/brand";
import { Github } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import gettingStartedCheckUrl from "../../assets/getting-started-check.svg";
import { ClipboardCheck } from "../../lib/hugeicons";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import {
  emptyGettingStartedSnapshot,
  GETTING_STARTED_STEP_IDS,
  loadGettingStartedSnapshot,
  type GettingStartedStep,
  type GettingStartedStepId,
} from "./getting-started";

const TOTAL_STEPS = GETTING_STARTED_STEP_IDS.length;
const BRAND_COLORS = onboardingChecklist.colors;

export function gettingStartedAutoOpenKey(handle: string, runtimeSlot: string): string {
  return `matrix:getting-started:auto-opened:${encodeURIComponent(handle)}:${encodeURIComponent(runtimeSlot)}`;
}

function hasAutoOpened(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch (error: unknown) {
    console.warn("[getting-started] unable to read auto-open state:", error instanceof Error ? error.name : typeof error);
    return true;
  }
}

function rememberAutoOpened(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch (error: unknown) {
    console.warn("[getting-started] unable to save auto-open state:", error instanceof Error ? error.name : typeof error);
  }
}

function StepIndicator({ step }: { step: GettingStartedStep }) {
  const complete = step.status === "complete";
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-full"
      style={{
        background: complete ? BRAND_COLORS.completed : BRAND_COLORS.surface,
        border: complete ? "none" : `1px solid ${BRAND_COLORS.border}`,
        opacity: step.status === "unavailable" ? 0.55 : 1,
      }}
    >
      {complete ? <img alt="" src={gettingStartedCheckUrl} width={12} height={12} /> : null}
    </span>
  );
}

export default function GettingStartedPopover() {
  const api = useConnection((state) => state.api);
  const connectionStatus = useConnection((state) => state.status);
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const openTab = useTabs((state) => state.openTab);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);
  const [open, setOpen] = useState(false);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [snapshot, setSnapshot] = useState(emptyGettingStartedSnapshot);

  useEffect(() => {
    setSnapshot(emptyGettingStartedSnapshot());
  }, [api, authGeneration, runtimeSlot]);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    void loadGettingStartedSnapshot(api, controller.signal).then((next) => {
      if (!controller.signal.aborted) setSnapshot(next);
    });
    return () => controller.abort();
  }, [api, authGeneration, refreshRequest, runtimeSlot]);

  const handleRadixOpenChange = useCallback((nextOpen: boolean) => {
    // Dismissal is deliberately owned by the title-bar trigger. Radix may
    // request `false` for Escape, focus changes, and outside interactions;
    // none of those are allowed to close this persistent checklist.
    if (!nextOpen) return;
    setOpen(true);
    setRefreshRequest((request) => (request + 1) % 1_000_000);
  }, []);

  const autoOpenKey = useMemo(() => (
    handle ? gettingStartedAutoOpenKey(handle, runtimeSlot) : null
  ), [handle, runtimeSlot]);

  useEffect(() => {
    if (
      connectionStatus !== "signed-in"
      || !autoOpenKey
      || !snapshot.loaded
      || snapshot.completedCount === TOTAL_STEPS
      || hasAutoOpened(autoOpenKey)
    ) return;
    rememberAutoOpened(autoOpenKey);
    setOpen(true);
  }, [autoOpenKey, connectionStatus, snapshot.completedCount, snapshot.loaded]);

  const openSettings = useCallback((section: "services" | "providers" | "billing") => {
    requestSettingsSection(section);
    openTab({ kind: "settings", title: "Settings" });
  }, [openTab, requestSettingsSection]);

  const activateStep = useCallback((id: GettingStartedStepId) => {
    switch (id) {
      case "github":
      case "email-calendar":
        openSettings("services");
        break;
      case "agent":
        openSettings("providers");
        break;
      case "first-work":
        openTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "draft" });
        break;
      case "billing":
        openSettings("billing");
        break;
    }
  }, [openSettings, openTab]);

  const label = `Getting started — ${snapshot.completedCount} of ${TOTAL_STEPS}`;
  const progress = `${(snapshot.completedCount / TOTAL_STEPS) * 100}%`;

  return (
    <Popover.Root open={open} onOpenChange={handleRadixOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={() => {
            if (open) setOpen(false);
          }}
          className="relative flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-secondary)" }}
        >
          <ClipboardCheck aria-hidden="true" size={16} />
          {snapshot.completedCount < TOTAL_STEPS ? (
            <span
              aria-hidden="true"
              className="absolute right-0.5 top-0.5 size-1.5 rounded-full"
              style={{ background: "var(--accent)" }}
            />
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label="Getting started"
          align="end"
          side="bottom"
          sideOffset={7}
          collisionPadding={12}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="w-[252px] overflow-hidden rounded-[12px] border outline-none"
          style={{
            zIndex: DESKTOP_Z_INDEX.popover,
            background: BRAND_COLORS.surface,
            borderColor: BRAND_COLORS.border,
            boxShadow: onboardingChecklist.shadow,
            fontFamily: onboardingChecklist.fontFamily,
          }}
        >
          <div className="flex items-center justify-between whitespace-nowrap px-3 pb-3 pt-4">
            <h2 style={{ color: BRAND_COLORS.text, fontSize: 16, fontWeight: 400, lineHeight: "normal" }}>
              Getting started
            </h2>
            <span
              data-testid="getting-started-counter"
              style={{ color: BRAND_COLORS.subtleText, fontSize: 11, fontWeight: 500, lineHeight: "normal" }}
            >
              {snapshot.completedCount} of {TOTAL_STEPS}
            </span>
          </div>
          <div data-testid="getting-started-progress" className="px-3 pb-4">
            <div
              data-testid="getting-started-progress-track"
              className="h-1 w-full overflow-hidden rounded-[2px]"
              style={{ background: BRAND_COLORS.progressTrack }}
            >
              <div
                data-testid="getting-started-progress-fill"
                className="h-full transition-[width] duration-200"
                style={{ width: progress, background: BRAND_COLORS.progressFill }}
              />
            </div>
          </div>
          <div className="pb-1">
            {snapshot.steps.map((step) => {
              const complete = step.status === "complete";
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => activateStep(step.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
                  title={step.status === "unavailable" ? "Status is temporarily unavailable" : undefined}
                >
                  <StepIndicator step={step} />
                  <span
                    className="min-w-0 flex-1 truncate"
                    style={{
                      color: complete ? BRAND_COLORS.subtleText : BRAND_COLORS.text,
                      fontSize: 11,
                      fontWeight: 400,
                      lineHeight: "normal",
                      textDecoration: complete ? "line-through" : "none",
                    }}
                  >
                    {step.label}
                  </span>
                  {step.id === "github" ? (
                    <Github aria-hidden="true" size={16} style={{ color: BRAND_COLORS.subtleText }} />
                  ) : null}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
