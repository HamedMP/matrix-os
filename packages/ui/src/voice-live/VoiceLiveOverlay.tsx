import type { ReactNode } from "react";
import { MessageSquareIcon, PhoneOffIcon } from "lucide-react";
import { Button } from "../Button.js";
import { voiceLiveErrorMessage, type VoiceLiveTask } from "./state.js";
import type { VoiceLiveCall } from "./use-voice-live-call.js";

const TEXT_SHADOW = "0 1px 2px rgba(0,0,0,0.9), 0 2px 16px rgba(0,0,0,0.7), 0 0 44px rgba(0,0,0,0.5)";
const GLOW = "var(--voice-live-glow, var(--primary, var(--matrix-primary)))";
const STATUS_LABEL = { connecting: "Connecting…", listening: "Listening", speaking: "Speaking", ended: "Call ended", error: "Voice stopped" } as const;
const TASK_LABEL: Record<VoiceLiveTask["state"], string> = {
  queued: "Queued", running: "Working", waiting_for_approval: "Needs your approval", waiting_for_input: "Needs your input",
  succeeded: "Done", failed: "Failed", cancelled: "Cancelled", timed_out: "Timed out", outcome_unknown: "Unknown",
};

export interface VoiceLiveOverlayProps {
  /** False during the exit fade. */
  active: boolean;
  call: VoiceLiveCall;
  onEnd(): void;
  onOpenChat(chatId: string): void;
  /** Surfaces route errors through their own notification host; the default
   * renders an inline card above the controls. */
  renderError?(message: string): ReactNode;
}

function VoiceLiveGlow({ status }: { status: VoiceLiveCall["status"] }) {
  const speaking = status === "speaking";
  const glow = status === "error" || status === "ended" ? 0.3 : speaking ? 1 : 0.68;
  const breathe = (delay: string) => (speaking ? `voice-live-breathe 3.2s ease-in-out infinite${delay}` : "none");
  return (
    <>
      <div className="absolute inset-0 transition-opacity duration-700 ease-out" style={{ opacity: glow,
        background: `radial-gradient(ellipse 95% 95% at 50% 50%, transparent 60%, color-mix(in srgb, ${GLOW} 38%, transparent) 80%, color-mix(in srgb, ${GLOW} 95%, transparent) 100%)`,
        animation: breathe("") }} />
      <div className="absolute inset-0 transition-opacity duration-700 ease-out" style={{ opacity: glow * 0.85, mixBlendMode: "screen",
        boxShadow: `inset 0 0 200px 28px color-mix(in srgb, ${GLOW} 55%, transparent)`, animation: breathe(" 0.4s") }} />
    </>
  );
}

function VoiceLiveTasks({ tasks, onOpenChat }: { tasks: VoiceLiveTask[]; onOpenChat(chatId: string): void }) {
  if (tasks.length === 0) return null;
  return (
    <div className="absolute inset-x-0 top-10 z-40 flex flex-col items-center gap-2">
      {tasks.map((task) => (
        <button key={task.chatId} type="button" onClick={() => onOpenChat(task.chatId)}
          className="pointer-events-auto flex max-w-md items-center gap-3 rounded-full border px-4 py-2 text-left backdrop-blur-md"
          style={{ background: `color-mix(in srgb, ${GLOW} 22%, rgba(0,0,0,0.5))`, borderColor: `color-mix(in srgb, ${GLOW} 55%, transparent)` }}>
          <span className="text-[10px] uppercase tracking-[0.2em] text-white/80">{TASK_LABEL[task.state]}</span>
          <span className="truncate text-sm text-white">{task.label}</span>
        </button>
      ))}
    </div>
  );
}

function VoiceLiveCaption({ call }: { call: VoiceLiveCall }) {
  const caption = call.status === "speaking" ? call.assistantCaption : call.userCaption || call.assistantCaption;
  return (
    <>
      <p className="mb-3 text-[10px] uppercase tracking-[0.28em] text-white" style={{ textShadow: TEXT_SHADOW, opacity: call.status === "connecting" ? 0.45 : 0.9 }}>
        {STATUS_LABEL[call.status]} · Matrix
      </p>
      <div className="min-h-[2em] max-w-2xl text-center">
        <p className="text-xl font-light leading-relaxed text-white transition-opacity duration-300 md:text-2xl"
          style={{ fontFamily: "var(--font-serif), Georgia, serif", textShadow: TEXT_SHADOW, opacity: caption ? 1 : 0 }}>
          {caption || " "}
        </p>
      </div>
    </>
  );
}

function VoiceLiveControls({ call, onEnd, onOpenChat }: Pick<VoiceLiveOverlayProps, "call" | "onEnd" | "onOpenChat">) {
  const chatId = call.chatId;
  return (
    <div className="pointer-events-auto mt-5 flex gap-2">
      {chatId ? (
        <Button variant="secondary" size="sm" className="backdrop-blur-md"
          style={{ background: "rgba(0,0,0,0.4)", color: "#fff", borderColor: "rgba(255,255,255,0.3)" }} onClick={() => onOpenChat(chatId)}>
          <MessageSquareIcon className="size-4" /> Open chat
        </Button>
      ) : null}
      <Button variant="destructive" size="sm" onClick={() => { call.end(); onEnd(); }} aria-label="End voice call">
        <PhoneOffIcon className="size-4" /> End
      </Button>
    </div>
  );
}

const KEYFRAMES = `
  @keyframes voice-live-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes voice-live-breathe {
    0%, 100% { filter: brightness(0.9) saturate(1); transform: scale(1); }
    50%       { filter: brightness(1.35) saturate(1.15); transform: scale(1.015); }
  }
`;

/** Ambient overlay for a live voice call, shared by every OS view. Mount it
 * inside a positioned container that covers the desktop. */
export function VoiceLiveOverlay({ active, call, onEnd, onOpenChat, renderError }: VoiceLiveOverlayProps) {
  const errorMessage = call.status === "error" ? voiceLiveErrorMessage(call.errorCode) : null;
  const inlineError = errorMessage && !renderError ? errorMessage : null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" data-testid="voice-live-panel" data-status={call.status}
      style={{ opacity: active ? 1 : 0, transition: "opacity 900ms cubic-bezier(0.22, 1, 0.36, 1)", animation: "voice-live-in 900ms cubic-bezier(0.22, 1, 0.36, 1)" }}>
      <VoiceLiveGlow status={call.status} />
      <VoiceLiveTasks tasks={call.tasks} onOpenChat={onOpenChat} />
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center px-8 pb-24">
        {inlineError ? (
          <p role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-black/60 px-4 py-2 text-xs text-white backdrop-blur-md">{inlineError}</p>
        ) : null}
        <VoiceLiveCaption call={call} />
        <VoiceLiveControls call={call} onEnd={onEnd} onOpenChat={onOpenChat} />
      </div>
      {errorMessage && renderError ? renderError(errorMessage) : null}
      <style>{KEYFRAMES}</style>
    </div>
  );
}
