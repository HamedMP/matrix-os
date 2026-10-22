import type { OnboardingWidgetEvent, OnboardingWidgetSize } from "@matrix-os/contracts";
import { useEffect, useRef } from "react";
import {
  onboardingEdgeGaps,
  onboardingFittedEdgeGaps,
  onboardingPlacement,
  onboardingSupportDockCorner,
  type OnboardingWidgetBox,
  type OnboardingWidgetPosition,
} from "../position.js";
import { useViewportSize } from "../use-widget-position.js";

const BUBBLE_HEIGHT_PX = 52;
const LAUNCHER_GAP_PX = 12;

export interface OnboardingSupportDockInput {
  size: OnboardingWidgetSize;
  position: OnboardingWidgetPosition;
  /** The widget's measured size from `OnboardingWidget`'s `onSizeChange`; docking follows the saved `position` alone until then. */
  widgetSize?: OnboardingWidgetBox | null;
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
export function useOnboardingSupportDock({ size, position, widgetSize, visible = true, supportOpen, dispatch, closeSupport }: OnboardingSupportDockInput): void {
  const expanded = size !== "bubble";
  const viewport = useViewportSize();
  const gaps = widgetSize && viewport
    ? onboardingFittedEdgeGaps(onboardingPlacement(position, widgetSize, viewport), widgetSize, viewport)
    : onboardingEdgeGaps(position);
  const corner = onboardingSupportDockCorner(gaps);
  const sharesCorner = corner === "right";
  const lift = sharesCorner ? Math.round(gaps.bottom) + BUBBLE_HEIGHT_PX + LAUNCHER_GAP_PX : null;
  const supportOpenRef = useRef(supportOpen);
  const sharesCornerRef = useRef(sharesCorner);
  useEffect(() => {
    supportOpenRef.current = supportOpen;
    sharesCornerRef.current = sharesCorner;
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

  // Only the act of opening support shrinks the widget. When the widget comes to share the corner
  // any other way (expanding, a move, a resize, mounting), the widget wins and support closes below.
  const supportWasOpenRef = useRef(supportOpen);
  useEffect(() => {
    const opened = supportOpen && !supportWasOpenRef.current;
    supportWasOpenRef.current = supportOpen;
    if (opened && sharesCornerRef.current) dispatch({ type: "size.changed", size: "bubble" });
  }, [dispatch, supportOpen]);

  // A widget hidden behind a maximized Chat claims no corner, so a resize then must not close support.
  useEffect(() => {
    if (visible && expanded && sharesCorner && supportOpenRef.current) closeSupport();
  }, [closeSupport, expanded, sharesCorner, visible]);
}
