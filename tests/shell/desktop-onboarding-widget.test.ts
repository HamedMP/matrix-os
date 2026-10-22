// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingWidgetHostProps } from "@/components/onboarding-widget/OnboardingWidgetHost";

const host = vi.hoisted(() => ({ props: null as OnboardingWidgetHostProps | null }));
vi.mock("@/components/onboarding-widget/OnboardingWidgetHost", () => ({
  OnboardingWidgetHost: (props: OnboardingWidgetHostProps) => {
    host.props = props;
    return null;
  },
}));

const { DesktopOnboardingWidget } = await import("@/components/onboarding-widget/DesktopOnboardingWidget");

describe("DesktopOnboardingWidget", () => {
  it("switches Chat to the task's chat before bringing Chat forward, and passes the rest through", () => {
    const calls: string[] = [];
    const chat = { switchConversation: vi.fn((id: string) => calls.push(`switch:${id}`)) };
    const openApp = vi.fn((path: string) => calls.push(`open:${path}`));
    const onOpenSettings = vi.fn();
    render(createElement(DesktopOnboardingWidget, { chat: chat as never, openApp, onOpenSettings }));

    host.props!.onOpenChat("chat_research");
    expect(calls).toEqual(["switch:chat_research", "open:__chat__"]);
    expect(openApp).toHaveBeenCalledWith("__chat__", "Chat");

    host.props!.onOpenChat(null);
    expect(chat.switchConversation).toHaveBeenCalledTimes(1);
    expect(openApp).toHaveBeenCalledTimes(2);
    expect(host.props!.onOpenSettings).toBe(onOpenSettings);
  });

  it("still opens Chat when the desktop has no chat state", () => {
    const openApp = vi.fn();
    render(createElement(DesktopOnboardingWidget, { chat: undefined, openApp, onOpenSettings: vi.fn() }));
    host.props!.onOpenChat("chat_x");
    expect(openApp).toHaveBeenCalledWith("__chat__", "Chat");
  });
});
