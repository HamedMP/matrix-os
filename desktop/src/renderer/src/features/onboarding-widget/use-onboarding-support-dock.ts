import type { OnboardingWidgetEvent, OnboardingWidgetSize } from "@matrix-os/contracts";
import { useEffect } from "react";
import { useUi } from "../../stores/ui";

export function useOnboardingSupportDock({ size, side, visible = true, dispatch, closeSupport }: {
  size: OnboardingWidgetSize;
  side: "right" | "left";
  visible?: boolean;
  dispatch(event: OnboardingWidgetEvent): void;
  closeSupport(): void;
}): void {
  const supportPanelOpen = useUi((state) => state.supportPanelOpen);
  const expanded = size !== "bubble";

  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    root.dataset.mxoOnboarding = `${expanded ? "card" : "bubble"}-${side}`;
    return () => {
      delete root.dataset.mxoOnboarding;
    };
  }, [expanded, side, visible]);

  useEffect(() => {
    if (supportPanelOpen) dispatch({ type: "size.changed", size: "bubble" });
  }, [dispatch, supportPanelOpen]);

  useEffect(() => {
    if (expanded && useUi.getState().supportPanelOpen) closeSupport();
  }, [closeSupport, expanded]);
}
