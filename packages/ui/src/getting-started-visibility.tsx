"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface Visibility {
  scope: string;
  requestedOpen: boolean;
  visible: boolean;
  blocked: boolean;
  /** Another onboarding surface is showing; the checklist must not open by itself. */
  autoOpenSuppressed: boolean;
  setRequestedOpen: (open: boolean) => void;
  isBlocked: () => boolean;
  isAutoOpenSuppressed: () => boolean;
}
type AcquireBlocker = () => () => void;
const VisibilityContext = createContext<Visibility | null>(null);
const BlockerContext = createContext<AcquireBlocker | null>(null);
const AutoOpenSuppressionContext = createContext<AcquireBlocker | null>(null);

/** What the checklist owner reports so other menus (the account menu) can show and open it. */
export interface GettingStartedProgress {
  completed: number;
  total: number;
  next: string | null;
  open: () => void;
}
interface ProgressSlot {
  progress: GettingStartedProgress | null;
  publish: (progress: GettingStartedProgress | null) => void;
}
const ProgressContext = createContext<ProgressSlot | null>(null);

function useCountedHolds() {
  const [count, setCount] = useState(0);
  const live = useRef(0);
  const acquire = useCallback(() => {
    live.current += 1;
    setCount(live.current);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      live.current -= 1;
      setCount(live.current);
    };
  }, []);
  const isHeld = useCallback(() => live.current > 0, []);
  return { held: count > 0, acquire, isHeld };
}

/** One owner per authenticated computer session; presentation switches keep intent. */
export function GettingStartedVisibilityProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [intent, setIntent] = useState({ scope, open: false });
  const blockers = useCountedHolds();
  const suppressions = useCountedHolds();
  const [progress, publish] = useState<GettingStartedProgress | null>(null);
  const progressSlot = useMemo(() => ({ progress, publish }), [progress]);
  if (intent.scope !== scope) setIntent({ scope, open: false });
  const requestedOpen = intent.scope === scope && intent.open;
  const setRequestedOpen = useCallback((open: boolean) => setIntent({ scope, open }), [scope]);
  const blocked = blockers.held;
  const value = useMemo(() => ({
    scope,
    requestedOpen,
    visible: requestedOpen && !blocked,
    blocked,
    autoOpenSuppressed: suppressions.held,
    setRequestedOpen,
    isBlocked: blockers.isHeld,
    isAutoOpenSuppressed: suppressions.isHeld,
  }), [scope, requestedOpen, blocked, suppressions.held, setRequestedOpen, blockers.isHeld, suppressions.isHeld]);
  return (
    <BlockerContext value={blockers.acquire}>
      <AutoOpenSuppressionContext value={suppressions.acquire}>
        <VisibilityContext value={value}>
          <ProgressContext value={progressSlot}>{children}</ProgressContext>
        </VisibilityContext>
      </AutoOpenSuppressionContext>
    </BlockerContext>
  );
}

export function useGettingStartedVisibility(): Visibility {
  const value = useContext(VisibilityContext);
  if (!value) throw new Error("Getting started requires a visibility provider");
  return value;
}

/** Latest checklist progress for this computer session; null until loaded, or without a provider. */
export function useGettingStartedProgress(): GettingStartedProgress | null {
  return useContext(ProgressContext)?.progress ?? null;
}

/** The checklist owner reports its progress (memoize it); unmounting withdraws it. */
export function usePublishGettingStartedProgress(progress: GettingStartedProgress | null): void {
  const publish = useContext(ProgressContext)?.publish;
  useLayoutEffect(() => {
    if (!publish) return;
    publish(progress);
    return () => publish(null);
  }, [progress, publish]);
}

/** Registration belongs to overlay presence, including its exit animation. */
export function useGettingStartedBlocker(active: boolean): void {
  const acquire = useContext(BlockerContext);
  useLayoutEffect(() => {
    if (active && acquire) return acquire();
  }, [acquire, active]);
}

/** Holds back automatic opening only; the checklist's own button still opens it. Safe without a provider. */
export function useGettingStartedAutoOpenSuppression(active = true): void {
  const acquire = useContext(AutoOpenSuppressionContext);
  useLayoutEffect(() => {
    if (active && acquire) return acquire();
  }, [acquire, active]);
}

/** Place inside presence-managed content, not beside an always-mounted portal. */
export function GettingStartedBlocker({ active = true }: { active?: boolean }) {
  useGettingStartedBlocker(active);
  return null;
}

/** Only explicit opening may move focus; automatic restoration never does. */
export function useGettingStartedPopoverFocus() {
  const { requestedOpen, blocked } = useGettingStartedVisibility();
  const manualOpen = useRef(false);
  useLayoutEffect(() => {
    if (blocked) manualOpen.current = false;
  }, [blocked]);
  const markManualOpen = useCallback(() => { manualOpen.current = true; }, []);
  const onOpenAutoFocus = useCallback((event: Event) => {
    if (!manualOpen.current) event.preventDefault();
    manualOpen.current = false;
  }, []);
  const onCloseAutoFocus = useCallback((event: Event) => {
    if (requestedOpen) event.preventDefault();
  }, [requestedOpen]);
  return { markManualOpen, onOpenAutoFocus, onCloseAutoFocus };
}
