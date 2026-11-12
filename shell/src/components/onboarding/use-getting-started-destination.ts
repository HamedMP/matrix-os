"use client";

import { useCallback } from "react";
import type { ChatState } from "@/hooks/useChatState";
import { catalogAppLaunchPath } from "@/lib/app-catalog-launch";
import type { GettingStartedDestination } from "./GettingStartedPopover";

const APP_GALLERY_PATH = catalogAppLaunchPath({ slug: "app-gallery", path: "apps/app-gallery/index.html" }) ?? "apps/app-gallery/index.html";

/** Carries out a Getting started row on the web desktop: Chat (a bot's chat or a ready prompt) or App Gallery. */
export function useGettingStartedDestination(chat: ChatState | undefined, openAppOrFocus: (path: string, name?: string) => void) {
  return useCallback((destination?: GettingStartedDestination) => {
    if (destination?.kind === "app-gallery") {
      openAppOrFocus(APP_GALLERY_PATH, "App Gallery");
      return;
    }
    if (destination?.chatId) chat?.switchConversation(destination.chatId);
    openAppOrFocus("__chat__", "Chat");
    if (destination?.prompt && chat) {
      // A fresh chat with the prompt typed in; nothing is sent until the owner sends it.
      const prompt = destination.prompt;
      // merge: the owner's own unsent text stays, with the suggestion below it.
      void chat.newChat().then(() => chat.requestComposerDraft(prompt, { merge: true }), (error: unknown) => {
        console.warn("[getting-started] unable to start a chat:", error instanceof Error ? error.name : typeof error);
      });
    }
  }, [chat, openAppOrFocus]);
}
