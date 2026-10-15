import type { OnboardingWidgetEvent, OnboardingWidgetSize } from "@matrix-os/contracts";
import { useEffect, useRef } from "react";

export interface OnboardingSupportDockInput {
  size: OnboardingWidgetSize;
  side: "right" | "left";
  visible?: boolean;
  supportOpen: boolean;
  dispatch: (event: OnboardingWidgetEvent) => void;
  closeSupport: () => void;
}

/**
 * The PostHog support chat shares the widget's screen corner. Publishing the widget's footprint
 * on <html> lets the support styles dock above it, and whichever panel opens last wins the corner.
 */
export function useOnboardingSupportDock({ size, side, visible = true, supportOpen, dispatch, closeSupport }: OnboardingSupportDockInput): void {
  const expanded = size !== "bubble";
  const supportOpenRef = useRef(supportOpen);
  useEffect(() => {
    supportOpenRef.current = supportOpen;
  });

  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    root.dataset.mxoOnboarding = `${expanded ? "card" : "bubble"}-${side}`;
    return () => { delete root.dataset.mxoOnboarding; };
  }, [expanded, side, visible]);

  useEffect(() => {
    if (supportOpen) dispatch({ type: "size.changed", size: "bubble" });
  }, [dispatch, supportOpen]);

  useEffect(() => {
    if (expanded && supportOpenRef.current) closeSupport();
  }, [closeSupport, expanded]);
}
