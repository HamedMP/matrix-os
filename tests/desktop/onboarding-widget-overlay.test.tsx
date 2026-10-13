// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useOnboardingOverlayLease } from "@desktop/renderer/src/features/onboarding-widget/use-onboarding-overlay-lease";
import { useUi } from "@desktop/renderer/src/stores/ui";

const leases = () => useUi.getState().rendererOverlayCount;

describe("onboarding widget native overlay lease", () => {
  beforeEach(() => useUi.setState({ rendererOverlayCount: 0 }));
  afterEach(cleanup);

  it("holds one lease while the widget is expanded so native app views cannot cover it", () => {
    const { rerender, unmount } = renderHook(({ expanded }) => useOnboardingOverlayLease(expanded), { initialProps: { expanded: true } });
    expect(leases()).toBe(1);
    rerender({ expanded: true });
    expect(leases()).toBe(1);

    rerender({ expanded: false });
    expect(leases()).toBe(0);

    rerender({ expanded: true });
    expect(leases()).toBe(1);
    unmount();
    expect(leases()).toBe(0);
  });

  it("takes no lease as a bubble and leaves other overlays' leases alone", () => {
    useUi.getState().acquireRendererOverlay();
    const { rerender, unmount } = renderHook(({ expanded }) => useOnboardingOverlayLease(expanded), { initialProps: { expanded: false } });
    expect(leases()).toBe(1);
    rerender({ expanded: true });
    expect(leases()).toBe(2);
    unmount();
    expect(leases()).toBe(1);
  });
});
