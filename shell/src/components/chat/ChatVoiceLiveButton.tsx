"use client";

import { AudioLinesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVocalStore } from "@/stores/vocal";

/** Starts a live voice call on this Chat (or the generic Matrix Pi Chat for a
 * new, unsaved composer). Toggling again ends the call. */
export function ChatVoiceLiveButton({ chatId }: { chatId: string | undefined }) {
  const active = useVocalStore((s) => s.active);
  const startInChat = useVocalStore((s) => s.startInChat);
  const setActive = useVocalStore((s) => s.setActive);
  const label = active ? "End voice call" : "Talk with Matrix";
  return (
    <Button type="button" variant={active ? "secondary" : "ghost"} size="icon" aria-label={label} aria-pressed={active} title={label}
      data-testid="chat-voice-live" className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
      onClick={() => (active ? setActive(false) : startInChat(chatId))}>
      <AudioLinesIcon className="size-4" />
    </Button>
  );
}
