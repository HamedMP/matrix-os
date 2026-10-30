import { getStartedAppGalleryLabel, gettingStartedRows, type GettingStartedRow, type GettingStartedStepStatus, type OnboardingWidgetEvent } from "@matrix-os/contracts";
import {
  useGettingStartedVisibility, useGettingStartedPopoverFocus, DesktopHelpMenu, useGetStartedAnswers, useGetStartedEnded, GettingStartedAppHelpMenu, useGettingStartedHelpMode,
  openGettingStartedBotChat, retryGettingStartedBots, useGettingStartedBots, useGetStartedConnectFailures, gettingStartedRowAction, gettingStartedRowView,
  type GettingStartedRequest, type GettingStartedRowView,
} from "@matrix-os/ui";
import * as Popover from "@radix-ui/react-popover";
import { onboardingChecklist } from "@matrix-os/brand";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import gettingStartedCheckUrl from "../../assets/getting-started-check.svg";
import { Bot, ClipboardCheck, CreditCard, Folder, Github, KeyRound, MailIcon, Plug, Sparkles } from "../../lib/hugeicons";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { seedNewChatDraft } from "../chat/use-chat-composer-drafts";
import { showOnboardingTab as showTab } from "../onboarding-widget/onboarding-widget-navigation";
import { useOnboardingAppConnect } from "../onboarding-widget/use-onboarding-app-connect";
import { useUi } from "../../stores/ui";
import {
  emptyGettingStartedSnapshot,
  loadGettingStartedSnapshot,
  type GettingStartedStepId,
} from "./getting-started";

const BRAND_COLORS = onboardingChecklist.colors;
/** Same cadence as the web checklist, so a connection made elsewhere shows up while it stays open. */
const REFRESH_MS = 15_000;

/** Each row's icon, chosen in JSX so the React Compiler sees a fixed component. */
function RowIconGlyph({ row }: { row: GettingStartedRow }) {
  const props = { size: 16, className: "shrink-0", "aria-hidden": true, style: { color: BRAND_COLORS.subtleText } } as const;
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

const menuOverlay = {
  acquire: () => useUi.getState().acquireRendererOverlay(),
  release: () => useUi.getState().releaseRendererOverlay(),
};

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

/** One checklist row: label (or its try action), optional help line, and its icon or "Try". */
function ChecklistRow({ row, view, onActivate }: { row: GettingStartedRow; view: GettingStartedRowView; onActivate(): void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-busy={view.trailing === "waiting"}
      className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
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
      {complete ? <img alt="" src={gettingStartedCheckUrl} width={12} height={12} /> : null}
    </span>
  );
}

/**
 * Spec 639: where this computer serves the Getting started app, the Getting started toggle shows
 * only its summary; the checklist remains for computers that predate it.
 */
export default function GettingStartedPopover(props: { helpMenu?: { onSupport(): void; discordIcon: ReactNode } } = {}) {
  const { scope } = useGettingStartedVisibility();
  const helpMode = useGettingStartedHelpMode();
  if (props.helpMenu && helpMode === "app") return <GettingStartedAppHelpMenu overlay={menuOverlay} {...props.helpMenu} zIndex={DESKTOP_Z_INDEX.popover} />;
  return <GettingStartedPopoverContent key={scope} {...props} />;
}

function GettingStartedPopoverContent({ helpMenu }: { helpMenu?: { onSupport(): void; discordIcon: ReactNode } }) {
  const api = useConnection((state) => state.api);
  const connectionStatus = useConnection((state) => state.status);
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);
  const {
    visible: open, requestedOpen, blocked, isBlocked, autoOpenSuppressed, isAutoOpenSuppressed, setRequestedOpen: setOpen,
  } = useGettingStartedVisibility();
  const { markManualOpen, onOpenAutoFocus, onCloseAutoFocus } = useGettingStartedPopoverFocus();
  const helpTriggerRef = useRef<HTMLButtonElement>(null);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const requestRefresh = useCallback(() => setRefreshRequest((request) => (request + 1) % 1_000_000), []);
  const [snapshot, setSnapshot] = useState(emptyGettingStartedSnapshot);
  // Rows start an app's own sign-in, like the onboarding widget, and reload as soon as it lands.
  // A sign-in that fails, is blocked or times out is remembered per app until it is tried again.
  const failures = useGetStartedConnectFailures();
  const { onEvent: recordFailure, clear: clearFailure, failedServices } = failures;
  const onConnectEvent = useCallback((event: OnboardingWidgetEvent) => {
    recordFailure(event);
    if (event.type === "connect.succeeded") requestRefresh();
  }, [recordFailure, requestRefresh]);
  const { connectApp: startConnect, connectingService, appsUnavailable } = useOnboardingAppConnect(api, onConnectEvent);
  const connectApp = useCallback((service: string) => {
    clearFailure(service);
    startConnect(service);
  }, [clearFailure, startConnect]);
  // Spec 635: lead with the steps that fit the owner's Get started answers.
  const getStartedAnswers = useGetStartedAnswers();
  const botRequest = useMemo<GettingStartedRequest | null>(() => (
    api ? (path, method, body) => (method === "GET" ? api.get(path) : api.post(path, body ?? {})) : null
  ), [api]);
  const bots = useGettingStartedBots(botRequest, getStartedAnswers?.bots, refreshRequest);
  const { rows, completedCount, total } = useMemo(
    () => gettingStartedRows(snapshot, getStartedAnswers, bots.statuses),
    [getStartedAnswers, snapshot, bots.statuses],
  );
  // After Get started, the checklist reopens on every load until done, but only once per load.
  const getStartedEnded = useGetStartedEnded();
  const autoOpenedThisLoad = useRef(false);

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
    if (!nextOpen || blocked) return;
    markManualOpen();
    setOpen(true);
    requestRefresh();
  }, [blocked, markManualOpen, requestRefresh, setOpen]);

  // Customer feedback: the checklist used to reload only when reopened, so it never caught up.
  useEffect(() => {
    if (!open) return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") requestRefresh();
    };
    const intervalId = window.setInterval(requestRefresh, REFRESH_MS);
    window.addEventListener("focus", requestRefresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", requestRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [open, requestRefresh]);

  const autoOpenKey = useMemo(() => (
    handle ? gettingStartedAutoOpenKey(handle, runtimeSlot) : null
  ), [handle, runtimeSlot]);

  useEffect(() => {
    if (
      connectionStatus !== "signed-in"
      || !autoOpenKey
      || !snapshot.loaded
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
  }, [autoOpenKey, connectionStatus, getStartedEnded, completedCount, total, snapshot.loaded, blocked, isBlocked, autoOpenSuppressed, isAutoOpenSuppressed, setOpen]);

  const openSettings = useCallback((section: "services" | "providers" | "billing") => {
    requestSettingsSection(section);
    showTab({ kind: "settings", title: "Settings" });
  }, [requestSettingsSection]);

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
        showTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "draft" });
        break;
      case "billing":
        openSettings("billing");
        break;
    }
  }, [openSettings]);

  const openChat = useCallback((chatId?: string) => {
    showTab(chatId
      ? { kind: "work", title: "Chat", workRoute: "chat", chatId, chatView: "conversation" }
      : { kind: "work", title: "Chat", workRoute: "chat", chatView: "draft" });
  }, []);

  const activateRow = useCallback((row: GettingStartedRow) => {
    const action = gettingStartedRowAction(row, { canConnect: !appsUnavailable });
    switch (action.type) {
      case "try":
        seedNewChatDraft(action.prompt);
        openChat();
        return;
      case "connect":
        connectApp(action.service);
        return;
      case "step":
        activateStep(action.id);
        return;
      case "settings":
        openSettings("services");
        return;
      case "create-bots":
        // A bot that failed to create: create the saved choices again, then reload the rows.
        if (botRequest) retryGettingStartedBots(botRequest, () => setRefreshRequest((request) => (request + 1) % 1_000_000));
        return;
      case "bot": {
        const agentId = bots.agentIds[action.recipeId];
        if (!agentId || !botRequest) {
          openChat();
          return;
        }
        void openGettingStartedBotChat(botRequest, agentId).then(
          (chatId) => openChat(chatId ?? undefined),
          (error: unknown) => {
            console.warn("[getting-started] unable to open bot chat:", error instanceof Error ? error.name : typeof error);
            openChat();
          },
        );
      }
    }
  }, [activateStep, appsUnavailable, bots.agentIds, botRequest, connectApp, openChat, openSettings]);

  useEffect(() => {
    // A manual opening counts too, even while status is loading: a later
    // response must not undo the user's explicit dismissal.
    if (open && !isBlocked() && autoOpenKey) {
      rememberAutoOpened(autoOpenKey);
    }
  }, [open, isBlocked, autoOpenKey]);


  const label = `Getting started — ${completedCount} of ${total}`;
  const progress = `${(completedCount / total) * 100}%`;

  const helpRow = Boolean(helpMenu);
  const trigger = (closeHelp?: () => void) => <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          disabled={blocked}
          onClick={() => {
            if (requestedOpen) setOpen(false);
            closeHelp?.();
          }}
          className={helpRow ? "relative flex w-full flex-wrap items-center gap-2.5 rounded-lg p-2 text-left text-[13px] outline-none hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]" : "relative flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"}
          style={{ color: "var(--text-secondary)" }}
        >
          <ClipboardCheck aria-hidden="true" size={16} />
          {helpRow ? <><span className="flex-1">Getting started</span><span className="text-xs">{completedCount} of {total}</span><span className="h-1 w-full overflow-hidden rounded" style={{ background: BRAND_COLORS.progressTrack }}><span className="block h-full" style={{ width: progress, background: BRAND_COLORS.progressFill }} /></span></> : null}
          {!helpRow && completedCount < total ? (
            <span
              aria-hidden="true"
              className="absolute right-0.5 top-0.5 size-1.5 rounded-full"
              style={{ background: "var(--accent)" }}
            />
          ) : null}
        </button>
      </Popover.Trigger>;
  return (
    <Popover.Root open={open} onOpenChange={handleRadixOpenChange}>
      {helpMenu ? <DesktopHelpMenu overlay={menuOverlay} {...helpMenu} incomplete={completedCount < total} gettingStarted={trigger}
        gettingStartedOpen={requestedOpen} onGettingStartedClose={() => setOpen(false)} triggerRef={helpTriggerRef}
        anchorTrigger={(helpTrigger) => <Popover.Anchor asChild>{helpTrigger}</Popover.Anchor>} /> : trigger()}
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
            if (helpMenu && !requestedOpen) {
              event.preventDefault();
              helpTriggerRef.current?.focus();
            }
          }}
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
              {completedCount} of {total}
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
            {/* A link, not a step: building an app has no completion check. */}
            <button
              type="button"
              data-testid="getting-started-app-gallery"
              onClick={() => showTab({ kind: "app", slug: "app-gallery", title: "App Gallery" })}
              className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
              style={{ color: BRAND_COLORS.text, fontSize: 11 }}
            >
              <Sparkles aria-hidden="true" size={16} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{getStartedAppGalleryLabel(getStartedAnswers)} in App Gallery</span>
            </button>
            {rows.map((row) => (
              <ChecklistRow key={row.id} row={row} view={gettingStartedRowView(row, connectingService, failedServices)} onActivate={() => activateRow(row)} />
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
