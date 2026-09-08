"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface Visibility {
  scope: string;
  requestedOpen: boolean;
  visible: boolean;
  blocked: boolean;
  setRequestedOpen: (open: boolean) => void;
  isBlocked: () => boolean;
}
type AcquireBlocker = () => () => void;
const VisibilityContext = createContext<Visibility | null>(null);
const BlockerContext = createContext<AcquireBlocker | null>(null);

/** One owner per authenticated computer session; presentation switches keep intent. */
export function GettingStartedVisibilityProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [intent, setIntent] = useState({ scope, open: false });
  const [blockerCount, setBlockerCount] = useState(0);
  const liveBlockerCount = useRef(0);
  if (intent.scope !== scope) setIntent({ scope, open: false });
  const requestedOpen = intent.scope === scope && intent.open;
  const acquire = useCallback(() => {
    liveBlockerCount.current += 1;
    setBlockerCount(liveBlockerCount.current);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      liveBlockerCount.current -= 1;
      setBlockerCount(liveBlockerCount.current);
    };
  }, []);
  const isBlocked = useCallback(() => liveBlockerCount.current > 0, []);
  const setRequestedOpen = useCallback((open: boolean) => setIntent({ scope, open }), [scope]);
  const blocked = blockerCount > 0;
  const value = useMemo(() => ({
    scope,
    requestedOpen,
    visible: requestedOpen && !blocked,
    blocked,
    setRequestedOpen,
    isBlocked,
  }), [scope, requestedOpen, blocked, setRequestedOpen, isBlocked]);
  return (
    <BlockerContext value={acquire}>
      <VisibilityContext value={value}>{children}</VisibilityContext>
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
