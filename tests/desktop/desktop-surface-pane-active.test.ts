import { describe, expect, it } from "vitest";
import { shouldActivateDesktopPane } from "@desktop/renderer/src/features/desktop-shell/DesktopSurfaceFrame";

describe("desktop native pane activation", () => {
  it("detaches native embeds while Show Desktop hides or transitions their windows", () => {
    const base = {
      active: true,
      visible: true,
      overlayOpen: false,
      isNativeEmbed: true,
    };

    expect(shouldActivateDesktopPane({
      ...base,
      isDesktopHidden: true,
      isDesktopTransition: false,
    })).toBe(false);
    expect(shouldActivateDesktopPane({
      ...base,
      isDesktopHidden: false,
      isDesktopTransition: true,
    })).toBe(false);
  });

  it("keeps ordinary visible panes active", () => {
    expect(shouldActivateDesktopPane({
      active: true,
      visible: true,
      overlayOpen: false,
      isNativeEmbed: true,
      isDesktopHidden: false,
      isDesktopTransition: false,
    })).toBe(true);
  });
});
