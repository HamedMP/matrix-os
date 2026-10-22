"use client";

import { useCallback } from "react";
import type { ChatState } from "@/hooks/useChatState";
import { OnboardingWidgetHost, type OnboardingWidgetHostProps } from "./OnboardingWidgetHost";

type DesktopOnboardingWidgetProps = Omit<OnboardingWidgetHostProps, "onOpenChat"> & {
  chat: ChatState | undefined;
  openApp: (path: string, name?: string) => void;
};

/** Web Desktop and Web Canvas mount: opening a task's chat switches Chat to it, then brings Chat forward. */
export function DesktopOnboardingWidget({ chat, openApp, ...props }: DesktopOnboardingWidgetProps) {
  const openChat = useCallback((chatId: string | null) => {
    if (chatId) chat?.switchConversation(chatId);
    openApp("__chat__", "Chat");
  }, [chat, openApp]);
  return <OnboardingWidgetHost {...props} onOpenChat={openChat} />;
}
