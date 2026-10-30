"use client";

import {
  useGettingStartedVisibility, useGettingStartedPopoverFocus, DesktopHelpMenu, useGetStartedAnswers, useGetStartedEnded, GettingStartedAppOpenButton,
  openGettingStartedBotChat, retryGettingStartedBots, useGettingStartedBots, gettingStartedRowAction, gettingStartedRowView, type GettingStartedRequest, type GettingStartedRowAction, type GettingStartedRowView,
} from "@matrix-os/ui";
import { onboardingChecklist } from "@matrix-os/brand";
import {
  deriveGettingStartedSnapshot,
  emptyGettingStartedSnapshot,
  getStartedAppGalleryLabel,
  gettingStartedRows,
  type GetStartedRecipeBotId,
  type GettingStartedResults,
  type GettingStartedRow,
  type GettingStartedSnapshot,
  type GettingStartedStepId,
  type GettingStartedStepStatus,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Bot, CheckIcon, ClipboardCheck, CreditCard, DownloadIcon, Folder, Github, KeyRound, MailIcon, Plug, Sparkles } from "@/lib/hugeicons";
import { getGatewayUrl } from "@/lib/gateway";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { useGettingStartedConnections } from "./use-getting-started-connections";

const STATUS_TIMEOUT_MS = 10_000;
const BRAND_COLORS = onboardingChecklist.colors;

export const DESKTOP_APP_DOWNLOAD_URL = "https://matrix-os.com/desktop";
const DESKTOP_RELEASE_REDIRECT_URL = "https://matrix-os.com/api/desktop-release";
export const GETTING_STARTED_REFRESH_MS = 15_000;

type DesktopNavigatorIdentity = {
  platform?: string;
  userAgent?: string;
};

type DesktopDownloadSuggestion = {
  href: string;
  label: string;
  guidance?: string;
};

function directDesktopDownload(platform: "macArm64" | "macX64" | "windowsX64" | "linuxX64"): string {
  return `${DESKTOP_RELEASE_REDIRECT_URL}?platform=${platform}`;
}

export function resolveDesktopDownloadSuggestion(
  identity: DesktopNavigatorIdentity,
  architecture?: string,
): DesktopDownloadSuggestion {
  const platform = `${identity.platform ?? ""} ${identity.userAgent ?? ""}`.toLowerCase();
  const normalizedArchitecture = architecture?.toLowerCase();
  const isArm = normalizedArchitecture?.includes("arm") || normalizedArchitecture?.includes("aarch");
  const fallback = { href: DESKTOP_APP_DOWNLOAD_URL, label: "Choose desktop download" };

  if (/\b(android|iphone|ipad|ipod|mobile)\b/.test(platform)) {
    return fallback;
  }

  if (platform.includes("win")) {
    if (isArm) return fallback;
    return {
      href: directDesktopDownload("windowsX64"),
      label: "Download for Windows",
      guidance: "SmartScreen: select More info, verify Finna Labs Inc., then select Run anyway. Run as administrator does not bypass it.",
    };
  }

  if (platform.includes("mac")) {
    if (normalizedArchitecture?.includes("arm")) {
      return { href: directDesktopDownload("macArm64"), label: "Download for macOS (Apple silicon)" };
    }
    if (normalizedArchitecture === "x86" || normalizedArchitecture === "x86_64" || normalizedArchitecture === "amd64") {
      return { href: directDesktopDownload("macX64"), label: "Download for macOS (Intel)" };
    }
    return { href: DESKTOP_APP_DOWNLOAD_URL, label: "Choose macOS download" };
  }

  if (platform.includes("linux") && !isArm && !platform.includes("arm") && !platform.includes("aarch")) {
    return { href: directDesktopDownload("linuxX64"), label: "Download for Linux" };
  }

  return fallback;
}

/** Each row's icon, chosen in JSX so the React Compiler sees a fixed component. */
function RowIconGlyph({ row }: { row: GettingStartedRow }) {
  const props = { className: "size-4 shrink-0", "aria-hidden": true, style: { color: BRAND_COLORS.subtleText } } as const;
  if (row.kind === "tool") return <Plug {...props} />;
  if (row.kind === "bot") return <Bot {...props} />;
  switch (row.id) {
    case "github": return <Github {...props} />;
    case "email-calendar": return <MailIcon {...props} />;
    case "agent": return <KeyRound {...props} />;
    case "first-work": return <Folder {...props} />;
    case "billing": return <CreditCard {...props} />;
  }
}

/** Where a Getting started row leads besides Settings: Chat (a bot's own chat, or a ready prompt) or App Gallery. */
export type GettingStartedDestination = { kind: "chat"; chatId?: string; prompt?: string } | { kind: "app-gallery" };

/** Bot status reads and opening a bot's chat, on the owner's gateway. */
const webGettingStartedRequest: GettingStartedRequest = async (path, method, body) => {
  const response = await fetch(`${getGatewayUrl()}${path}`, {
    method,
    cache: "no-store",
    credentials: "include",
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("getting_started_request_failed");
  return response.json();
};

export type GettingStartedSettingsSection = "integrations" | "agents-providers" | "billing";

interface GettingStartedPopoverProps {
  onOpenSettings: (section: GettingStartedSettingsSection) => void;
  /** Opens Chat (a bot's own chat when given) or App Gallery. */
  onOpenFirstWork: (destination?: GettingStartedDestination) => void;
  triggerClassName?: string;
  helpMenu?: { onSupport(): void; discordIcon: ReactNode };
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

/** The status reads behind Getting started; the popover and the Getting started app derive from the same results. */
export async function loadWebGettingStartedResults(
  fetcher: GettingStartedFetcher = fetch,
  signal?: AbortSignal,
): Promise<GettingStartedResults> {
  const gatewayUrl = getGatewayUrl();
  const billingUrl = `/billing/status?runtimeSlot=${encodeURIComponent(currentRuntimeSlot())}`;
  const [github, integrations, agents, projects, chats, billing, providers] = await Promise.allSettled([
    readJson(fetcher, `${gatewayUrl}/api/github/status`, signal),
    readJson(fetcher, `${gatewayUrl}/api/integrations`, signal),
    readJson(fetcher, `${gatewayUrl}/api/agents/credentials/status`, signal),
    readJson(fetcher, `${gatewayUrl}/api/workspace/projects`, signal),
    readJson(fetcher, `${gatewayUrl}/api/chats?limit=1`, signal),
    readJson(fetcher, billingUrl, signal),
    readJson(fetcher, `${gatewayUrl}/api/ai/provider-settings`, signal),
  ]);
  return { github, integrations, agents, projects, chats, billing, providers };
}

export async function loadWebGettingStartedSnapshot(
  fetcher: GettingStartedFetcher = fetch,
  signal?: AbortSignal,
): Promise<GettingStartedSnapshot> {
  return deriveGettingStartedSnapshot(await loadWebGettingStartedResults(fetcher, signal));
}

/** One checklist row: label (or its try action), optional help line, and its icon or "Try". */
function ChecklistRow({ row, view, onActivate }: { row: GettingStartedRow; view: GettingStartedRowView; onActivate(): void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-busy={view.trailing === "waiting"}
      className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70"
      title={row.status === "unavailable" ? "Status is temporarily unavailable" : undefined}
    >
      <StepIndicator step={row} />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate"
          style={{
            color: view.struck ? BRAND_COLORS.subtleText : BRAND_COLORS.text,
            fontSize: 11,
            fontWeight: 400,
            lineHeight: "normal",
            textDecoration: view.struck ? "line-through" : "none",
          }}
        >
          {view.label}
        </span>
        {view.detail ? (
          <span className="mt-0.5 block truncate" style={{ color: BRAND_COLORS.subtleText, fontSize: 10 }}>{view.detail}</span>
        ) : null}
      </span>
      {view.trailing === "icon" ? (
        <RowIconGlyph row={row} />
      ) : view.trailing === "try" ? (
        <span className="shrink-0 rounded-full border px-2 py-0.5" style={{ borderColor: BRAND_COLORS.border, color: BRAND_COLORS.text, fontSize: 10 }}>Try</span>
      ) : null}
    </button>
  );
}

function StepIndicator({ step }: { step: { status: GettingStartedStepStatus } }) {
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

/**
 * A bot row opens that bot's own chat. A bot that failed to create (`create`) is created again
 * from the saved choices instead, and the rows reload with the result.
 */
function activateBotRow(
  action: Extract<GettingStartedRowAction, { type: "bot" | "create-bots" }>,
  agentIds: Partial<Record<GetStartedRecipeBotId, string>>,
  onOpenFirstWork: GettingStartedPopoverProps["onOpenFirstWork"],
  reload: () => void,
): void {
  if (action.type === "create-bots") {
    retryGettingStartedBots(webGettingStartedRequest, reload);
    return;
  }
  const agentId = agentIds[action.recipeId];
  if (!agentId) {
    onOpenFirstWork({ kind: "chat" });
    return;
  }
  void openGettingStartedBotChat(webGettingStartedRequest, agentId).then(
    (chatId) => onOpenFirstWork({ kind: "chat", ...(chatId ? { chatId } : {}) }),
    (error: unknown) => {
      console.warn("[getting-started] unable to open bot chat:", error instanceof Error ? error.name : typeof error);
      onOpenFirstWork({ kind: "chat" });
    },
  );
}

export function GettingStartedPopover(props: GettingStartedPopoverProps) {
  const { scope } = useGettingStartedVisibility();
  return <GettingStartedPopoverContent key={scope} {...props} />;
}

function GettingStartedPopoverContent({
  onOpenSettings,
  onOpenFirstWork,
  helpMenu,
  triggerClassName = "flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
}: GettingStartedPopoverProps) {
  const {
    visible: open, requestedOpen, blocked, isBlocked, autoOpenSuppressed, isAutoOpenSuppressed, setRequestedOpen: setOpen,
  } = useGettingStartedVisibility();
  const { markManualOpen, onOpenAutoFocus, onCloseAutoFocus } = useGettingStartedPopoverFocus();
  const helpTriggerRef = useRef<HTMLButtonElement>(null);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const requestRefresh = useCallback(() => setRefreshRequest((request) => (request + 1) % 1_000_000), []);
  // Rows start an app's own sign-in, like the onboarding widget, and reload when any connection changes.
  const { connectApp, connectingService, failedServices, appsUnavailable } = useGettingStartedConnections(requestRefresh);
  const [snapshot, setSnapshot] = useState(emptyGettingStartedSnapshot);
  // Spec 635: lead with the steps that fit the owner's Get started answers.
  const getStartedAnswers = useGetStartedAnswers();
  const bots = useGettingStartedBots(webGettingStartedRequest, getStartedAnswers?.bots, refreshRequest);
  const { rows, completedCount, total } = useMemo(
    () => gettingStartedRows(snapshot, getStartedAnswers, bots.statuses),
    [getStartedAnswers, snapshot, bots.statuses],
  );
  // After Get started, the checklist reopens on every load until done, but only once per load.
  const getStartedEnded = useGetStartedEnded();
  const autoOpenedThisLoad = useRef(false);
  const [downloadSuggestion, setDownloadSuggestion] = useState<DesktopDownloadSuggestion>({
    href: DESKTOP_APP_DOWNLOAD_URL,
    label: "Choose desktop download",
  });
  const [autoOpenKey] = useState(() => webGettingStartedAutoOpenKey(currentComputerScope()));

  useEffect(() => {
    setDownloadSuggestion(resolveDesktopDownloadSuggestion(navigator));

    const userAgentData = (navigator as Navigator & {
      userAgentData?: {
        getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
      };
    }).userAgentData;
    if (!userAgentData?.getHighEntropyValues) return;

    let cancelled = false;
    void userAgentData.getHighEntropyValues(["architecture"]).then(({ architecture }) => {
      if (!cancelled) {
        setDownloadSuggestion(resolveDesktopDownloadSuggestion(navigator, architecture));
      }
    }).catch((error: unknown) => {
      console.warn(
        "[getting-started] unable to detect device architecture:",
        error instanceof Error ? error.name : typeof error,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      || blocked
      || isBlocked()
      || autoOpenSuppressed
      || isAutoOpenSuppressed()
      || completedCount === total
      || autoOpenedThisLoad.current
      || (!getStartedEnded && hasAutoOpened(autoOpenKey))
    ) return;
    autoOpenedThisLoad.current = true;
    setOpen(true);
  }, [autoOpenKey, getStartedEnded, completedCount, total, snapshot.loaded, blocked, isBlocked, autoOpenSuppressed, isAutoOpenSuppressed, setOpen]);

  useEffect(() => {
    if (!open) return;
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
  }, [open, requestRefresh]);

  const handleRadixOpenChange = (nextOpen: boolean) => {
    if (!nextOpen || blocked) return;
    markManualOpen();
    setOpen(true);
    requestRefresh();
  };

  const activateStep = (id: GettingStartedStepId) => {
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
  };

  const activateRow = (row: GettingStartedRow) => {
    const action = gettingStartedRowAction(row, { canConnect: !appsUnavailable });
    switch (action.type) {
      case "try":
        onOpenFirstWork({ kind: "chat", prompt: action.prompt });
        return;
      case "connect":
        connectApp(action.service);
        return;
      case "step":
        activateStep(action.id);
        return;
      case "settings":
        onOpenSettings("integrations");
        return;
      case "create-bots":
      case "bot":
        activateBotRow(action, bots.agentIds, onOpenFirstWork, () => setRefreshRequest((request) => (request + 1) % 1_000_000));
    }
  };

  useEffect(() => {
    // A manual opening counts too, even while status is loading: a later
    // response must not undo the user's explicit dismissal.
    if (open && !isBlocked() && autoOpenKey) {
      rememberAutoOpened(autoOpenKey);
    }
  }, [open, isBlocked, autoOpenKey]);

  const label = `Getting started — ${completedCount} of ${total}`;
  const progress = `${(completedCount / total) * 100}%`;

  const trigger = (closeHelp?: () => void) => <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          disabled={blocked}
          className={helpMenu ? "relative flex w-full flex-wrap items-center gap-2.5 rounded-md p-2 text-left text-[13px] outline-none hover:bg-foreground/5 focus-visible:bg-foreground/5" : `relative ${triggerClassName}`}
          onClick={() => {
            if (requestedOpen) setOpen(false);
            closeHelp?.();
          }}
        >
          <ClipboardCheck className="size-4" aria-hidden="true" />
          {helpMenu ? <><span className="flex-1">Getting started</span><span className="text-xs">{completedCount} of {total}</span><span className="h-1 w-full overflow-hidden rounded" style={{ background: BRAND_COLORS.progressTrack }}><span className="block h-full" style={{ width: progress, background: BRAND_COLORS.progressFill }} /></span></> : null}
          {!helpMenu && completedCount < total ? (
            <span aria-hidden="true" className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />
          ) : null}
        </button>
      </PopoverPrimitive.Trigger>;
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleRadixOpenChange}>
      {helpMenu ? <DesktopHelpMenu {...helpMenu} incomplete={completedCount < total} gettingStarted={trigger}
        gettingStartedOpen={requestedOpen} onGettingStartedClose={() => setOpen(false)} triggerRef={helpTriggerRef}
        anchorTrigger={(helpTrigger) => <PopoverPrimitive.Anchor asChild>{helpTrigger}</PopoverPrimitive.Anchor>} /> : trigger()}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          role="dialog"
          aria-label="Getting started"
          align="end"
          side="bottom"
          sideOffset={7}
          collisionPadding={12}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus(event);
            if (helpMenu && !requestedOpen) {
              event.preventDefault();
              helpTriggerRef.current?.focus();
            }
          }}
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
            <span className="flex items-center gap-1.5">
              <span
                data-testid="getting-started-counter"
                style={{ color: BRAND_COLORS.subtleText, fontSize: 11, fontWeight: 500, lineHeight: "normal" }}
              >
                {completedCount} of {total}
              </span>
              <GettingStartedAppOpenButton onOpened={() => setOpen(false)} />
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
              href={downloadSuggestion.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={downloadSuggestion.label}
              className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70"
              style={{ color: BRAND_COLORS.text, fontSize: 11 }}
            >
              <DownloadIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block">{downloadSuggestion.label}</span>
                {downloadSuggestion.guidance ? (
                  <span
                    className="mt-1 block leading-snug"
                    style={{ color: BRAND_COLORS.subtleText, fontSize: 10 }}
                  >
                    {downloadSuggestion.guidance}
                  </span>
                ) : null}
              </span>
            </a>
            {/* A link, not a step: building an app has no completion check. */}
            <button
              type="button"
              data-testid="getting-started-app-gallery"
              onClick={() => onOpenFirstWork({ kind: "app-gallery" })}
              className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70"
              style={{ color: BRAND_COLORS.text, fontSize: 11 }}
            >
              <Sparkles className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{getStartedAppGalleryLabel(getStartedAnswers)} in App Gallery</span>
            </button>
            {rows.map((row) => (
              <ChecklistRow key={row.id} row={row} view={gettingStartedRowView(row, connectingService, failedServices)} onActivate={() => activateRow(row)} />
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
