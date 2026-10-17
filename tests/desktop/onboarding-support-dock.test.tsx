// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingWidgetSize } from "@matrix-os/contracts";
import { useOnboardingSupportDock } from "@desktop/renderer/src/features/onboarding-widget/use-onboarding-support-dock";
import { useUi } from "@desktop/renderer/src/stores/ui";

type DockProps = { size: OnboardingWidgetSize; side: "right" | "left"; visible?: boolean };

function renderDock(initial: DockProps) {
  const dispatch = vi.fn();
  const closeSupport = vi.fn();
  const view = renderHook(
    ({ size, side, visible }: DockProps) => useOnboardingSupportDock({ size, side, visible, dispatch, closeSupport }),
    { initialProps: initial },
  );
  return { ...view, dispatch, closeSupport };
}

describe("onboarding widget support dock", () => {
  beforeEach(() => {
    useUi.setState(useUi.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.mxoOnboarding;
  });

  it("publishes the widget size and side so the support launcher can dock beside it", () => {
    const { rerender, unmount } = renderDock({ size: "bubble", side: "right" });
    expect(document.documentElement.dataset.mxoOnboarding).toBe("bubble-right");

    rerender({ size: "corner", side: "left" });
    expect(document.documentElement.dataset.mxoOnboarding).toBe("card-left");

    unmount();
    expect(document.documentElement.dataset.mxoOnboarding).toBeUndefined();
  });

  it("releases the corner while the widget is hidden behind a maximized Chat", () => {
    const { rerender } = renderDock({ size: "bubble", side: "right" });
    expect(document.documentElement.dataset.mxoOnboarding).toBe("bubble-right");

    rerender({ size: "bubble", side: "right", visible: false });
    expect(document.documentElement.dataset.mxoOnboarding).toBeUndefined();

    rerender({ size: "bubble", side: "right", visible: true });
    expect(document.documentElement.dataset.mxoOnboarding).toBe("bubble-right");
  });

  it("shrinks the onboarding card to its bubble when the support panel opens", () => {
    const { dispatch } = renderDock({ size: "corner", side: "right" });
    expect(dispatch).not.toHaveBeenCalled();

    act(() => useUi.getState().setSupportPanelOpen(true));

    expect(dispatch).toHaveBeenCalledWith({ type: "size.changed", size: "bubble" });
  });

  it("closes the support panel when the onboarding card is expanded", () => {
    const { rerender, closeSupport } = renderDock({ size: "bubble", side: "right" });
    act(() => useUi.getState().setSupportPanelOpen(true));
    expect(closeSupport).not.toHaveBeenCalled();

    rerender({ size: "corner", side: "right" });

    expect(closeSupport).toHaveBeenCalledTimes(1);
  });
});
