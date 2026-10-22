import { beforeEach, describe, expect, it } from "vitest";
import { showOnboardingTab } from "../../desktop/src/renderer/src/features/onboarding-widget/onboarding-widget-navigation";
import { useDesktopSurfaces } from "../../desktop/src/renderer/src/stores/desktop-surfaces";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const VIEWPORT = { width: 1200, height: 760 };

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
});

describe("showOnboardingTab", () => {
  it("brings back a closed Chat window on the onboarding chat", () => {
    const chatTab = useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "index", closable: false });
    useDesktopSurfaces.getState().reconcileTabs(useTabs.getState().tabs.map((tab) => tab.id), VIEWPORT);
    useDesktopSurfaces.getState().closeSurface(chatTab);
    expect(useDesktopSurfaces.getState().surfaces[chatTab]?.mode).toBe("closed");

    const shown = showOnboardingTab({ kind: "work", title: "Chat", workRoute: "chat", chatId: "chat_1", chatView: "conversation", closable: false });

    expect(shown).toBe(chatTab);
    expect(useTabs.getState().activeTabId).toBe(chatTab);
    expect(useTabs.getState().tabs.find((tab) => tab.id === chatTab)).toMatchObject({ chatId: "chat_1", chatView: "conversation" });
    expect(useDesktopSurfaces.getState().surfaces[chatTab]?.mode).toBe("window");
  });

  it("restores a minimized Settings window", () => {
    const settingsTab = useTabs.getState().openTab({ kind: "settings", title: "Settings" });
    useDesktopSurfaces.getState().reconcileTabs(useTabs.getState().tabs.map((tab) => tab.id), VIEWPORT);
    useDesktopSurfaces.getState().minimizeSurface(settingsTab);

    showOnboardingTab({ kind: "settings", title: "Settings" });

    expect(useDesktopSurfaces.getState().surfaces[settingsTab]?.mode).toBe("window");
  });
});
