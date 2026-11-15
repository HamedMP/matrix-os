"use client";

import { VoiceLiveOverlay } from "@matrix-os/ui/voice-live";
import { ShellNotificationCard } from "./ShellNotificationCard";
import { ShellNotificationPortal } from "./ShellNotificationPortal";
import { useVoiceLive } from "@/hooks/useVoiceLive";
import { useVocalStore } from "@/stores/vocal";

interface VoiceLivePanelProps {
  /** False during the exit fade; the call ends as soon as this flips. */
  active: boolean;
  onOpenChat(chatId: string): void;
}

function renderShellVoiceError(message: string) {
  return (
    <ShellNotificationPortal>
      <ShellNotificationCard role="alert"
        className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive shadow-[0_18px_60px_-24px_rgba(239,68,68,0.58),0_24px_60px_-30px_rgba(0,0,0,0.38)] backdrop-blur-md">
        {message}
      </ShellNotificationCard>
    </ShellNotificationPortal>
  );
}

/** Web shell placement of the shared live voice overlay. */
export function VoiceLivePanel({ active, onOpenChat }: VoiceLivePanelProps) {
  const chatId = useVocalStore((s) => s.chatId);
  const setActive = useVocalStore((s) => s.setActive);
  const call = useVoiceLive(active, chatId);
  return (
    <VoiceLiveOverlay active={active} call={call} onEnd={() => setActive(false)} onOpenChat={onOpenChat}
      renderError={renderShellVoiceError} />
  );
}
