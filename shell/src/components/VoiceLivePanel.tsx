"use client";

import { MessageSquareIcon, PhoneOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShellNotificationCard } from "./ShellNotificationCard";
import { ShellNotificationPortal } from "./ShellNotificationPortal";
import { useVoiceLive } from "@/hooks/useVoiceLive";
import { voiceLiveErrorMessage, type VoiceLiveTask } from "@/lib/voice-live-state";
import { useVocalStore } from "@/stores/vocal";

const TEXT_SHADOW = "0 1px 2px rgba(0,0,0,0.9), 0 2px 16px rgba(0,0,0,0.7), 0 0 44px rgba(0,0,0,0.5)";
const STATUS_LABEL = { connecting: "Connecting…", listening: "Listening", speaking: "Speaking", ended: "Call ended", error: "Voice stopped" } as const;
const TASK_LABEL: Record<VoiceLiveTask["state"], string> = {
  queued: "Queued", running: "Working", waiting_for_approval: "Needs your approval", waiting_for_input: "Needs your input",
  succeeded: "Done", failed: "Failed", cancelled: "Cancelled", timed_out: "Timed out", outcome_unknown: "Unknown",
};

interface VoiceLivePanelProps {
  /** False during the exit fade; the call ends as soon as this flips. */
  active: boolean;
  onOpenChat(chatId: string): void;
}

/** Ambient overlay for a live voice call on one Matrix Pi Chat. */
export function VoiceLivePanel({ active, onOpenChat }: VoiceLivePanelProps) {
  const chatId = useVocalStore((s) => s.chatId);
  const setActive = useVocalStore((s) => s.setActive);
  const call = useVoiceLive(active, chatId);

  const speaking = call.status === "speaking";
  const glow = call.status === "error" || call.status === "ended" ? 0.3 : speaking ? 1 : 0.68;
  const caption = speaking ? call.assistantCaption : call.userCaption || call.assistantCaption;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" data-testid="voice-live-panel" data-status={call.status}
      style={{ opacity: active ? 1 : 0, transition: "opacity 900ms cubic-bezier(0.22, 1, 0.36, 1)", animation: "voice-live-in 900ms cubic-bezier(0.22, 1, 0.36, 1)" }}>
      <div className="absolute inset-0 transition-opacity duration-700 ease-out" style={{ opacity: glow,
        background: "radial-gradient(ellipse 95% 95% at 50% 50%, transparent 60%, color-mix(in srgb, var(--primary) 38%, transparent) 80%, color-mix(in srgb, var(--primary) 95%, transparent) 100%)",
        animation: speaking ? "vocal-breathe 3.2s ease-in-out infinite" : "none" }} />
      <div className="absolute inset-0 transition-opacity duration-700 ease-out" style={{ opacity: glow * 0.85, mixBlendMode: "screen",
        boxShadow: "inset 0 0 200px 28px color-mix(in srgb, var(--primary) 55%, transparent)",
        animation: speaking ? "vocal-breathe 3.2s ease-in-out infinite 0.4s" : "none" }} />

      {call.tasks.length > 0 && (
        <div className="fixed inset-x-0 top-10 z-40 flex flex-col items-center gap-2">
          {call.tasks.map((task) => (
            <button key={task.chatId} type="button" onClick={() => onOpenChat(task.chatId)}
              className="pointer-events-auto flex max-w-md items-center gap-3 rounded-full border px-4 py-2 text-left backdrop-blur-md"
              style={{ background: "color-mix(in srgb, var(--primary) 22%, rgba(0,0,0,0.5))", borderColor: "color-mix(in srgb, var(--primary) 55%, transparent)" }}>
              <span className="text-[10px] uppercase tracking-[0.2em] text-white/80">{TASK_LABEL[task.state]}</span>
              <span className="truncate text-sm text-white">{task.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center px-8 pb-10">
        <p className="mb-3 text-[10px] uppercase tracking-[0.28em] text-white" style={{ textShadow: TEXT_SHADOW, opacity: call.status === "connecting" ? 0.45 : 0.9 }}>
          {STATUS_LABEL[call.status]} · Matrix
        </p>
        <div className="min-h-[2em] max-w-2xl text-center">
          <p className="text-xl font-light leading-relaxed text-white transition-opacity duration-300 md:text-2xl"
            style={{ fontFamily: "var(--font-serif), Georgia, serif", textShadow: TEXT_SHADOW, opacity: caption ? 1 : 0 }}>
            {caption || " "}
          </p>
        </div>
        <div className="pointer-events-auto mt-5 flex gap-2">
          {call.chatId && (
            <Button variant="secondary" size="sm" onClick={() => onOpenChat(call.chatId!)}>
              <MessageSquareIcon className="size-4" /> Open chat
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={() => { call.end(); setActive(false); }} aria-label="End voice call">
            <PhoneOffIcon className="size-4" /> End
          </Button>
        </div>
      </div>

      {call.status === "error" && (
        <ShellNotificationPortal>
          <ShellNotificationCard role="alert"
            className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive shadow-[0_18px_60px_-24px_rgba(239,68,68,0.58),0_24px_60px_-30px_rgba(0,0,0,0.38)] backdrop-blur-md">
            {voiceLiveErrorMessage(call.errorCode)}
          </ShellNotificationCard>
        </ShellNotificationPortal>
      )}

      <style>{`
        @keyframes voice-live-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes vocal-breathe {
          0%, 100% { filter: brightness(0.9) saturate(1); transform: scale(1); }
          50%       { filter: brightness(1.35) saturate(1.15); transform: scale(1.015); }
        }
      `}</style>
    </div>
  );
}
