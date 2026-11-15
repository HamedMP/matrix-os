import { AudioLinesIcon } from "../../lib/hugeicons";
import { useDesktopVoiceCall } from "./voice-call-store";

/** Composer entry point: starts a live voice call on this Chat (or the
 * generic Matrix Pi Chat for an unsaved draft). Pressing again ends it. */
export function DesktopVoiceCallButton({ chatId, disabled }: { chatId: string | undefined; disabled?: boolean }) {
  const active = useDesktopVoiceCall((s) => s.active);
  const start = useDesktopVoiceCall((s) => s.start);
  const end = useDesktopVoiceCall((s) => s.end);
  const label = active ? "End voice call" : "Talk with Matrix";
  return (
    <button type="button" aria-label={label} aria-pressed={active} title={label} disabled={disabled}
      data-testid="chat-voice-live"
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] aria-pressed:text-[var(--accent)] disabled:opacity-50"
      onClick={() => (active ? end() : start(chatId))}>
      <AudioLinesIcon className="size-4" />
    </button>
  );
}
