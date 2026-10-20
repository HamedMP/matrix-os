// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingWidgetSize } from "@matrix-os/contracts";
import { DEFAULT_ONBOARDING_POSITION, onboardingCornerPosition, type OnboardingWidgetPosition } from "@matrix-os/ui";
import { useOnboardingSupportDock } from "@desktop/renderer/src/features/onboarding-widget/use-onboarding-support-dock";
import { useUi } from "@desktop/renderer/src/stores/ui";

type DockProps = {
  size: OnboardingWidgetSize;
  position?: OnboardingWidgetPosition;
  widgetSize?: { width: number; height: number } | null;
  visible?: boolean;
};

function renderDock(initial: DockProps) {
  const dispatch = vi.fn();
  const closeSupport = vi.fn();
  const view = renderHook(
    ({ size, position = DEFAULT_ONBOARDING_POSITION, widgetSize, visible }: DockProps) =>
      useOnboardingSupportDock({ size, position, widgetSize, visible, dispatch, closeSupport }),
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

  it("publishes the widget size and whether it shares the support launcher's corner", () => {
    const { rerender, unmount } = renderDock({ size: "bubble" });
    expect(document.documentElement.dataset.mxoOnboarding).toBe("bubble-right");

    rerender({ size: "corner", position: onboardingCornerPosition("left") });
    expect(document.documentElement.dataset.mxoOnboarding).toBe("card-away");

    rerender({ size: "corner", position: { x: "right", y: "top", dx: 24, dy: 24 } });
    expect(document.documentElement.dataset.mxoOnboarding).toBe("card-away");

    unmount();
    expect(document.documentElement.dataset.mxoOnboarding).toBeUndefined();
  });

  it("lifts the support launcher just above a bubble nudged off its corner", () => {
    const style = document.documentElement.style;
    const { rerender, unmount } = renderDock({ size: "bubble" });
    expect(style.getPropertyValue("--mxo-onboarding-lift")).toBe("88px");

    rerender({ size: "bubble", position: { x: "right", y: "bottom", dx: 30, dy: 50 } });
    expect(style.getPropertyValue("--mxo-onboarding-lift")).toBe("114px");

    rerender({ size: "bubble", position: { x: "right", y: "bottom", dx: 30, dy: 300 } });
    expect(style.getPropertyValue("--mxo-onboarding-lift")).toBe("");

    unmount();
    expect(style.getPropertyValue("--mxo-onboarding-lift")).toBe("");
  });

  it("docks by where the widget really shows once a smaller window pushes it into the support corner", () => {
    const savedLeft = { x: "left", y: "bottom", dx: 600, dy: 24 } as const;
    const card = { width: 392, height: 624 };
    const resizeTo = (width: number) => act(() => {
      window.innerWidth = width;
      window.dispatchEvent(new Event("resize"));
    });
    const startWidth = window.innerWidth;
    try {
      resizeTo(1920);
      const { rerender, dispatch } = renderDock({ size: "corner", position: savedLeft });
      expect(document.documentElement.dataset.mxoOnboarding).toBe("card-away");

      rerender({ size: "corner", position: savedLeft, widgetSize: card });
      expect(document.documentElement.dataset.mxoOnboarding).toBe("card-away");

      resizeTo(1000);
      expect(document.documentElement.dataset.mxoOnboarding).toBe("card-right");
      expect(document.documentElement.style.getPropertyValue("--mxo-onboarding-lift")).toBe("88px");
      act(() => useUi.getState().setSupportPanelOpen(true));
      expect(dispatch).toHaveBeenCalledWith({ type: "size.changed", size: "bubble" });

      resizeTo(1920);
      expect(document.documentElement.dataset.mxoOnboarding).toBe("card-away");
    } finally {
      resizeTo(startWidth);
    }
  });

  it("keeps the card and closes support when expanding fits the card into the support corner", () => {
    const high = { x: "right", y: "top", dx: 24, dy: 500 } as const;
    const bubble = { width: 260, height: 52 };
    const card = { width: 392, height: 624 };
    const start = { width: window.innerWidth, height: window.innerHeight };
    const resizeTo = (width: number, height: number) => act(() => {
      window.innerWidth = width;
      window.innerHeight = height;
      window.dispatchEvent(new Event("resize"));
    });
    try {
      resizeTo(1024, 768);
      const { rerender, dispatch, closeSupport } = renderDock({ size: "bubble", position: high, widgetSize: bubble });
      act(() => useUi.getState().setSupportPanelOpen(true));
      expect(document.documentElement.dataset.mxoOnboarding).toBe("bubble-away");

      rerender({ size: "corner", position: high, widgetSize: bubble });
      rerender({ size: "corner", position: high, widgetSize: card });

      expect(document.documentElement.dataset.mxoOnboarding).toBe("card-right");
      expect(closeSupport).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      resizeTo(start.width, start.height);
    }
  });

  it("leaves an open support chat alone when a resize moves the hidden card into its corner", () => {
    const savedLeft = { x: "left", y: "bottom", dx: 600, dy: 24 } as const;
    const card = { width: 392, height: 624 };
    const startWidth = window.innerWidth;
    const resizeTo = (width: number) => act(() => {
      window.innerWidth = width;
      window.dispatchEvent(new Event("resize"));
    });
    try {
      resizeTo(1920);
      // The card sits away from support, then Chat is maximized and hides the widget.
      const { rerender, closeSupport } = renderDock({ size: "corner", position: savedLeft, widgetSize: card, visible: false });
      act(() => useUi.getState().setSupportPanelOpen(true));
      resizeTo(1000);
      rerender({ size: "corner", position: savedLeft, widgetSize: card, visible: false });
      expect(closeSupport).not.toHaveBeenCalled();
    } finally {
      resizeTo(startWidth);
    }
  });

  it("keeps a card that shows up in the support corner while support is already open, and closes support", () => {
    act(() => useUi.getState().setSupportPanelOpen(true));
    const { dispatch, closeSupport } = renderDock({ size: "corner" });
    expect(closeSupport).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("releases the corner while the widget is hidden behind a maximized Chat", () => {
    const { rerender } = renderDock({ size: "bubble" });
    expect(document.documentElement.dataset.mxoOnboarding).toBe("bubble-right");

    rerender({ size: "bubble", visible: false });
    expect(document.documentElement.dataset.mxoOnboarding).toBeUndefined();

    rerender({ size: "bubble", visible: true });
    expect(document.documentElement.dataset.mxoOnboarding).toBe("bubble-right");
  });

  it("shrinks the onboarding card to its bubble when the support panel opens", () => {
    const { dispatch } = renderDock({ size: "corner" });
    expect(dispatch).not.toHaveBeenCalled();

    act(() => useUi.getState().setSupportPanelOpen(true));

    expect(dispatch).toHaveBeenCalledWith({ type: "size.changed", size: "bubble" });
  });

  it("closes the support panel when the onboarding card is expanded", () => {
    const { rerender, closeSupport } = renderDock({ size: "bubble" });
    act(() => useUi.getState().setSupportPanelOpen(true));
    expect(closeSupport).not.toHaveBeenCalled();

    rerender({ size: "corner" });

    expect(closeSupport).toHaveBeenCalledTimes(1);
  });

  it("leaves the support chat alone while the widget sits away from its corner", () => {
    const away = onboardingCornerPosition("left");
    const { rerender, dispatch, closeSupport } = renderDock({ size: "bubble", position: away });
    act(() => useUi.getState().setSupportPanelOpen(true));
    expect(dispatch).not.toHaveBeenCalled();

    rerender({ size: "corner", position: away });
    expect(closeSupport).not.toHaveBeenCalled();
  });
});
