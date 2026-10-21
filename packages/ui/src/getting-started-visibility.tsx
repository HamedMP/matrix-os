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
        <VisibilityContext value={value}>{children}</VisibilityContext>
      </AutoOpenSuppressionContext>
    </BlockerContext>
  );
}

export function useGettingStartedVisibility(): Visibility {
  const value = useContext(VisibilityContext);
  if (!value) throw new Error("Getting started requires a visibility provider");
  return value;
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
  return {
    markManualOpen: () => { manualOpen.current = true; },
    onOpenAutoFocus: (event: Event) => {
      if (!manualOpen.current) event.preventDefault();
      manualOpen.current = false;
    },
    onCloseAutoFocus: (event: Event) => {
      if (requestedOpen) event.preventDefault();
    },
  };
}
