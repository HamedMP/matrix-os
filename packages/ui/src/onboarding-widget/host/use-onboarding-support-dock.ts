import type { OnboardingWidgetEvent, OnboardingWidgetSize } from "@matrix-os/contracts";
import { useEffect, useRef } from "react";
import { onboardingSupportDockCorner, type OnboardingWidgetPosition } from "../position.js";

const BUBBLE_HEIGHT_PX = 52;
const LAUNCHER_GAP_PX = 12;

export interface OnboardingSupportDockInput {
  size: OnboardingWidgetSize;
  position: OnboardingWidgetPosition;
  visible?: boolean;
  supportOpen: boolean;
  dispatch: (event: OnboardingWidgetEvent) => void;
  closeSupport: () => void;
}

/**
 * The PostHog support chat lives in the bottom-right corner. Publishing the widget's footprint
 * on <html> lets the support styles dock above it, and while both share that corner whichever
 * panel opens last wins it. A widget moved elsewhere leaves the support chat alone.
 */
export function useOnboardingSupportDock({ size, position, visible = true, supportOpen, dispatch, closeSupport }: OnboardingSupportDockInput): void {
  const expanded = size !== "bubble";
  const corner = onboardingSupportDockCorner(position);
  const sharesCorner = corner === "right";
  const lift = sharesCorner ? position.dy + BUBBLE_HEIGHT_PX + LAUNCHER_GAP_PX : null;
  const supportOpenRef = useRef(supportOpen);
  useEffect(() => {
    supportOpenRef.current = supportOpen;
  });

  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    root.dataset.mxoOnboarding = `${expanded ? "card" : "bubble"}-${corner}`;
    if (lift !== null) root.style.setProperty("--mxo-onboarding-lift", `${lift}px`);
    return () => {
      delete root.dataset.mxoOnboarding;
      root.style.removeProperty("--mxo-onboarding-lift");
    };
  }, [corner, expanded, lift, visible]);

  useEffect(() => {
    if (supportOpen && sharesCorner) dispatch({ type: "size.changed", size: "bubble" });
  }, [dispatch, sharesCorner, supportOpen]);

  useEffect(() => {
    if (expanded && sharesCorner && supportOpenRef.current) closeSupport();
  }, [closeSupport, expanded, sharesCorner]);
}
