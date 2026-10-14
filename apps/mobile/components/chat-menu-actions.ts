import { useEffect, useRef, type ReactElement } from "react";
import { Share, type PressableProps } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

import { showToast } from "@/lib/toast";

export type ChatMenuAction =
  | { id: "copy-text" | "copy-chat-id"; label: string; onSelect: () => void }
  // iOS hands `text` to the system's own Share row; Android's `onSelect` opens the share sheet.
  | { id: "share"; label: string; text: string; onSelect: () => void };

export type ChatMenuActionId = ChatMenuAction["id"];

/**
 * How what the menu opens on sits in its row: across the whole row, or at
 * its own size against the row's end (its styles may cap it at a share of the
 * row). iOS lifts exactly this area out of the screen as the menu opens.
 */
export type ChatMenuFit = "fill" | "end";

/** What draws the menu: a native context menu on iOS, an alert elsewhere. */
export interface ChatMenuTriggerProps {
  /** Heads the menu where the platform shows a title: "Message" or "Chat". */
  title: string;
  /** At least one. */
  actions: readonly ChatMenuAction[];
  /** Called as the menu opens. */
  onOpen: () => void;
  fit: ChatMenuFit;
  /** The corners of what is lifted, matching what it draws. */
  cornerRadius: number;
  /** Room left around the content inside what is lifted. It does not move the content on screen. */
  inset: number;
  /**
   * Fills what is lifted when the content has no background of its own. iOS
   * draws the lift's shadow behind it, which shows through anything clear.
   */
  backgroundColor?: string;
  /** What a long press opens the menu on. */
  children: ReactElement<PressableProps>;
}

interface MenuTarget {
  chatId: string | null;
  text: string | null;
}

// The latest copy or share chosen from any chat menu. Only its result is
// shown, so a slow earlier one cannot replace it.
let latestAttempt = 0;

/** A light tap of feedback as the menu opens. */
export function chatMenuOpenHaptic(): void {
  void Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).catch((error: unknown) => {
    console.warn("[chat] Menu haptic unavailable", error instanceof Error ? error.name : "UnknownError");
  });
}

/**
 * The menu's actions for one message, or for a chat as a whole when there is
 * no text: Copy text and Share for the text, Copy chat ID for a chat that exists.
 */
export function useChatMenuActions(chatId: string | null, text: string | null): ChatMenuAction[] {
  // What is on screen now. A menu opened for something that has since changed
  // or gone does nothing, so it cannot copy the wrong chat's ID.
  const shown = useRef<MenuTarget | null>(null);
  useEffect(() => {
    shown.current = { chatId, text };
    return () => { shown.current = null; };
  }, [chatId, text]);

  // Each action checks, when chosen, that its message is still the one shown,
  // and again before it tells the person how it went.
  const ifShown = (run: (current: () => boolean) => Promise<void>) => () => {
    const isShown = () => shown.current?.chatId === chatId && shown.current?.text === text;
    if (!isShown()) return;
    const attempt = ++latestAttempt;
    void run(() => attempt === latestAttempt && isShown());
  };
  return [
    ...(text ? [
      { id: "copy-text" as const, label: "Copy text", onSelect: ifShown((current) => copy(text, "text", current)) },
      { id: "share" as const, label: "Share", text, onSelect: ifShown((current) => share(text, current)) },
    ] : []),
    ...(chatId ? [
      {
        id: "copy-chat-id" as const,
        label: "Copy chat ID",
        onSelect: ifShown((current) => copy(chatId, "chat ID", current)),
      },
    ] : []),
  ];
}

/** `current` says whether the result still belongs on screen. */
async function copy(value: string, what: "text" | "chat ID", current: () => boolean) {
  try {
    const copied = await Clipboard.setStringAsync(value);
    if (copied === false) throw new Error("Clipboard unavailable");
    if (current()) showToast(what === "text" ? "Text copied" : "Chat ID copied");
  } catch (error: unknown) {
    // The platform's own words can name internals; the person gets ours.
    console.warn("[chat] Clipboard copy failed", error instanceof Error ? error.name : "UnknownError");
    if (current()) showToast(`Could not copy ${what}. Try again.`, "error");
  }
}

async function share(text: string, current: () => boolean) {
  try {
    await Share.share({ message: text });
  } catch (error: unknown) {
    console.warn("[chat] Share failed", error instanceof Error ? error.name : "UnknownError");
    if (current()) showToast("Could not share. Try again.", "error");
  }
}
