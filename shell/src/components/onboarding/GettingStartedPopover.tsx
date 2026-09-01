"use client";

import { onboardingChecklist } from "@matrix-os/brand";
import {
  deriveGettingStartedSnapshot,
  emptyGettingStartedSnapshot,
  GETTING_STARTED_STEP_IDS,
  type GettingStartedSnapshot,
  type GettingStartedStep,
  type GettingStartedStepId,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { CheckIcon, ClipboardCheck, DownloadIcon, Github } from "@/lib/hugeicons";
import { getGatewayUrl } from "@/lib/gateway";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

const TOTAL_STEPS = GETTING_STARTED_STEP_IDS.length;
const STATUS_TIMEOUT_MS = 10_000;
const BRAND_COLORS = onboardingChecklist.colors;

export const DESKTOP_APP_DOWNLOAD_URL = "https://github.com/HamedMP/matrix-os/releases";
export const GETTING_STARTED_REFRESH_MS = 15_000;

export type GettingStartedSettingsSection = "integrations" | "agents-providers" | "billing";

interface GettingStartedPopoverProps {
  onOpenSettings: (section: GettingStartedSettingsSection) => void;
  onOpenFirstWork: () => void;
  triggerClassName?: string;
}

type GettingStartedFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function webGettingStartedAutoOpenKey(scope: string): string {
  return `matrix:getting-started:auto-opened:web:${encodeURIComponent(scope)}`;
}

function currentComputerScope(): string {
  const runtimeSlot = new URLSearchParams(window.location.search).get("runtime");
  return runtimeSlot ? `${window.location.pathname}?runtime=${runtimeSlot}` : window.location.pathname;
}

function currentRuntimeSlot(): string {
  const runtimeSlot = new URLSearchParams(window.location.search).get("runtime");
  return runtimeSlot && /^[A-Za-z0-9_-]{1,32}$/.test(runtimeSlot) ? runtimeSlot : "primary";
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

async function readJson(
  fetcher: GettingStartedFetcher,
  input: RequestInfo | URL,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(input, {
    cache: "no-store",
    credentials: "include",
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error("getting_started_status_unavailable");
  return response.json();
}

export async function loadWebGettingStartedSnapshot(
  fetcher: GettingStartedFetcher = fetch,
  signal?: AbortSignal,
): Promise<GettingStartedSnapshot> {
  const gatewayUrl = getGatewayUrl();
  const billingUrl = `/billing/status?runtimeSlot=${encodeURIComponent(currentRuntimeSlot())}`;
  const [github, integrations, agents, projects, chats, billing] = await Promise.allSettled([
    readJson(fetcher, `${gatewayUrl}/api/github/status`, signal),
    readJson(fetcher, `${gatewayUrl}/api/integrations`, signal),
    readJson(fetcher, `${gatewayUrl}/api/agents/credentials/status`, signal),
    readJson(fetcher, `${gatewayUrl}/api/workspace/projects`, signal),
    readJson(fetcher, `${gatewayUrl}/api/chats?limit=1`, signal),
    readJson(fetcher, billingUrl, signal),
  ]);
  return deriveGettingStartedSnapshot({ github, integrations, agents, projects, chats, billing });
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
      {complete ? <CheckIcon className="size-3" style={{ color: BRAND_COLORS.border }} /> : null}
    </span>
  );
}

export function GettingStartedPopover({
  onOpenSettings,
  onOpenFirstWork,
  triggerClassName = "flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
}: GettingStartedPopoverProps) {
  const [open, setOpen] = useState(false);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [snapshot, setSnapshot] = useState(emptyGettingStartedSnapshot);
  const autoOpenKey = useMemo(() => (
    webGettingStartedAutoOpenKey(currentComputerScope())
  ), []);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- checklist state is sourced from independent authenticated APIs and refreshed when the popover opens.
  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    void loadWebGettingStartedSnapshot(fetch, controller.signal).then((next) => {
      if (!controller.signal.aborted) setSnapshot(next);
    });
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [refreshRequest]);

  useEffect(() => {
    if (
      !snapshot.loaded
      || snapshot.completedCount === TOTAL_STEPS
      || hasAutoOpened(autoOpenKey)
    ) return;
    rememberAutoOpened(autoOpenKey);
    setOpen(true);
  }, [autoOpenKey, snapshot.completedCount, snapshot.loaded]);

  useEffect(() => {
    if (!open) return;
    const requestRefresh = () => {
      setRefreshRequest((request) => (request + 1) % 1_000_000);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") requestRefresh();
    };
    const intervalId = window.setInterval(requestRefresh, GETTING_STARTED_REFRESH_MS);
    window.addEventListener("focus", requestRefresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", requestRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [open]);

  const handleRadixOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) return;
    setOpen(true);
    setRefreshRequest((request) => (request + 1) % 1_000_000);
  }, []);

  const activateStep = useCallback((id: GettingStartedStepId) => {
    switch (id) {
      case "github":
      case "email-calendar":
        onOpenSettings("integrations");
        break;
      case "agent":
        onOpenSettings("agents-providers");
        break;
      case "first-work":
        onOpenFirstWork();
        break;
      case "billing":
        onOpenSettings("billing");
        break;
    }
  }, [onOpenFirstWork, onOpenSettings]);

  const label = `Getting started — ${snapshot.completedCount} of ${TOTAL_STEPS}`;
  const progress = `${(snapshot.completedCount / TOTAL_STEPS) * 100}%`;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleRadixOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={`relative ${triggerClassName}`}
          onClick={() => {
            if (open) setOpen(false);
          }}
        >
          <ClipboardCheck className="size-4" aria-hidden="true" />
          {snapshot.completedCount < TOTAL_STEPS ? (
            <span aria-hidden="true" className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />
          ) : null}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
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
            zIndex: SHELL_Z_INDEX.popover,
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
          <div className="px-3 pb-4">
            <div className="h-1 w-full overflow-hidden rounded-[2px]" style={{ background: BRAND_COLORS.progressTrack }}>
              <div
                className="h-full transition-[width] duration-200"
                style={{ width: progress, background: BRAND_COLORS.progressFill }}
              />
            </div>
          </div>
          <div className="pb-1">
            <a
              href={DESKTOP_APP_DOWNLOAD_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Download desktop app"
              className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70"
              style={{ color: BRAND_COLORS.text, fontSize: 11 }}
            >
              <DownloadIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">Download desktop app</span>
            </a>
            {snapshot.steps.map((step) => {
              const complete = step.status === "complete";
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => activateStep(step.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70"
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
                    <Github className="size-4" aria-hidden="true" style={{ color: BRAND_COLORS.subtleText }} />
                  ) : null}
                </button>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
