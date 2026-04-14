"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVocalSession, type VocalIntent } from "@/hooks/useVocalSession";
import type { ChatState } from "@/hooks/useChatState";
import { useWindowManager } from "@/hooks/useWindowManager";

const GLOW_OPACITY: Record<string, number> = {
  idle: 0.68,
  listening: 0.68,
  thinking: 0.8,
  speaking: 1,
};

interface DelegationBase {
  kind: "create_app";
  description: string;
  startedAt: number;
  messageStartIdx: number;
  appsSnapshot: Set<string>;
}
type DelegationStatus =
  | (DelegationBase & { stage: "pending" })
  | (DelegationBase & { stage: "running" })
  | (DelegationBase & { stage: "done" });

// Prefers the most recent tool invocation (tool names are more specific
// than free-form text), falling back to the latest assistant text.
// Walks backward in two passes to avoid `[...slice].reverse()` allocs on
// the 1.5s push hot path.
function deriveCurrentAction(
  messages: readonly { role: string; content: string; tool?: string }[],
  startIdx: number,
): string {
  const start = Math.max(0, startIdx);
  if (messages.length <= start) return "getting started";

  for (let i = messages.length - 1; i >= start; i--) {
    const tool = messages[i].tool;
    if (tool) return `running ${tool}`;
  }
  for (let i = messages.length - 1; i >= start; i--) {
    const m = messages[i];
    if (m.role === "assistant" && !m.tool) {
      const trimmed = m.content.replace(/\s+/g, " ").trim().slice(0, 120);
      return trimmed || "working on it";
    }
  }
  return "working on it";
}

interface VocalPanelProps {
  chat?: ChatState;
  onOpenApp?: (query: string) => { success: boolean; resolvedName?: string };
}

export function VocalPanel({ chat, onOpenApp }: VocalPanelProps) {
  // Delay WS/mic mount by one tick so React strict-mode's double-mount
  // doesn't open two sessions back-to-back.
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setEnabled(true), 0);
    return () => clearTimeout(t);
  }, []);

  const chatRef = useRef(chat);
  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);

  const onOpenAppRef = useRef(onOpenApp);
  useEffect(() => {
    onOpenAppRef.current = onOpenApp;
  }, [onOpenApp]);

  const [delegation, setDelegation] = useState<DelegationStatus | null>(null);

  const [rememberedFlash, setRememberedFlash] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleFactSaved = useCallback((fact: string) => {
    setRememberedFlash(fact);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setRememberedFlash(null);
      flashTimerRef.current = null;
    }, 2200);
  }, []);
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // `handleExecute` has to close over `notifyExecuteResult` from the hook,
  // but the hook's return is destructured after the call — so we can't
  // reference it directly in the options object. Route it through a ref
  // that's synced in an effect; the ref is set before any WS message can
  // fire `onExecute`, so the stub is always resolved by call time.
  const notifyExecuteResultRef = useRef<
    ((r: { kind: "open_app"; name: string; success: boolean; resolvedName?: string }) => void) | null
  >(null);

  const handleExecute = useCallback((intent: VocalIntent) => {
    if (intent.kind === "create_app") {
      const startIdx = chatRef.current?.messages.length ?? 0;
      const appsSnapshot = new Set(useWindowManager.getState().apps.map((a) => a.name));
      chatRef.current?.submitMessage(intent.description);
      setDelegation({
        kind: "create_app",
        description: intent.description,
        stage: "pending",
        startedAt: Date.now(),
        messageStartIdx: startIdx,
        appsSnapshot,
      });
      return;
    }
    if (intent.kind === "open_app") {
      const result = onOpenAppRef.current?.(intent.name);
      notifyExecuteResultRef.current?.({
        kind: "open_app",
        name: intent.name,
        success: result?.success ?? false,
        resolvedName: result?.resolvedName,
      });
    }
  }, []);

  const {
    voiceState,
    subtitle,
    error,
    connected,
    notifyDelegationComplete,
    notifyExecuteResult,
    pushDelegationStatus,
  } = useVocalSession(enabled, {
    onExecute: handleExecute,
    onFactSaved: handleFactSaved,
  });

  useEffect(() => {
    notifyExecuteResultRef.current = notifyExecuteResult;
  }, [notifyExecuteResult]);

  // Drive delegation state from chat.busy transitions. Reads from a ref
  // so setState calls below don't re-fire this effect (react-hooks/set-state-in-effect).
  const chatBusy = chat?.busy ?? false;
  const delegationRef = useRef(delegation);
  useEffect(() => {
    delegationRef.current = delegation;
  }, [delegation]);

  useEffect(() => {
    const current = delegationRef.current;
    if (!current) return;

    if (current.stage === "pending" && chatBusy) {
      setDelegation({ ...current, stage: "running" });
      return;
    }

    if (current.stage === "running" && !chatBusy) {
      setDelegation({ ...current, stage: "done" });

      const timers: ReturnType<typeof setTimeout>[] = [];
      let reported = false;

      const reportCompletion = (newAppName?: string) => {
        if (reported) return;
        reported = true;
        notifyDelegationComplete({
          kind: "create_app",
          description: current.description,
          success: true,
          newAppName,
        });
      };

      // Apps list may lag the kernel write by a beat (filesystem watcher
      // debounce). Retry up to 3×500ms for the diff before giving up.
      const tryFindNewApp = (attempt: number) => {
        if (reported) return;
        const appsNow = useWindowManager.getState().apps;
        const newApp = appsNow.find((a) => !current.appsSnapshot.has(a.name));
        if (newApp) {
          const opened = onOpenAppRef.current?.(newApp.name);
          reportCompletion(opened?.resolvedName ?? newApp.name);
          return;
        }
        if (attempt < 3) {
          timers.push(setTimeout(() => tryFindNewApp(attempt + 1), 500));
          return;
        }
        reportCompletion();
      };
      tryFindNewApp(0);

      timers.push(
        setTimeout(() => {
          setDelegation((prev) => (prev && prev.stage === "done" ? null : prev));
        }, 3200),
      );
      return () => {
        for (const t of timers) clearTimeout(t);
      };
    }
  }, [chatBusy, notifyDelegationComplete]);

  // Throttled status push: every 1.5s while running, compute a snapshot
  // and ship it to the gateway for `check_build_status`. Skipped when the
  // (elapsedSec, currentAction) tuple is unchanged since the last push —
  // avoids ~30 useless WS sends per typical build.
  const chatMessagesRef = useRef(chat?.messages ?? []);
  useEffect(() => {
    chatMessagesRef.current = chat?.messages ?? [];
  }, [chat?.messages]);

  const lastPushedRef = useRef<{ elapsedSec: number; currentAction: string } | null>(null);
  useEffect(() => {
    if (!delegation || delegation.stage === "done") return;
    lastPushedRef.current = null;

    function pushSnapshot() {
      if (!delegation || delegation.stage === "done") return;
      const elapsedSec = Math.floor((Date.now() - delegation.startedAt) / 1000);
      const currentAction = deriveCurrentAction(chatMessagesRef.current, delegation.messageStartIdx);
      const last = lastPushedRef.current;
      if (last && last.elapsedSec === elapsedSec && last.currentAction === currentAction) return;
      lastPushedRef.current = { elapsedSec, currentAction };
      pushDelegationStatus({
        description: delegation.description,
        stage: delegation.stage,
        elapsedSec,
        currentAction,
      });
    }

    pushSnapshot();
    const interval = setInterval(pushSnapshot, 1500);
    return () => clearInterval(interval);
  }, [delegation, pushDelegationStatus]);

  const glowOpacity = GLOW_OPACITY[voiceState] ?? 0;
  const speaking = voiceState === "speaking";

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {/* Primary edge halo */}
      <div
        className="absolute inset-0 transition-opacity duration-700 ease-out"
        style={{
          opacity: glowOpacity,
          background:
            "radial-gradient(ellipse 87% 87% at 50% 50%, transparent 37%, color-mix(in srgb, var(--primary) 25%, transparent) 68%, color-mix(in srgb, var(--primary) 66%, transparent) 100%)",
          animation: speaking ? "vocal-breathe 3.2s ease-in-out infinite" : "none",
        }}
      />

      {/* Inner bloom */}
      <div
        className="absolute inset-0 transition-opacity duration-700 ease-out"
        style={{
          opacity: glowOpacity * 0.85,
          mixBlendMode: "screen",
          boxShadow:
            "inset 0 0 290px 95px color-mix(in srgb, var(--primary) 34%, transparent)",
          animation: speaking ? "vocal-breathe 3.2s ease-in-out infinite 0.4s" : "none",
        }}
      />

      {/* Speaking-only corner aurora */}
      <div
        className="absolute inset-0 transition-opacity duration-700 ease-out"
        style={{
          opacity: speaking ? 0.7 : 0,
          background:
            "radial-gradient(circle 420px at 0% 0%, color-mix(in srgb, var(--primary) 35%, transparent), transparent 60%), radial-gradient(circle 420px at 100% 0%, color-mix(in srgb, var(--primary) 28%, transparent), transparent 60%), radial-gradient(circle 420px at 0% 100%, color-mix(in srgb, var(--primary) 28%, transparent), transparent 60%), radial-gradient(circle 420px at 100% 100%, color-mix(in srgb, var(--primary) 35%, transparent), transparent 60%)",
          animation: speaking ? "vocal-drift 6s ease-in-out infinite" : "none",
        }}
      />

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center pb-10 px-8">
        <p
          className="text-[10px] uppercase tracking-[0.28em] mb-3 transition-opacity duration-500"
          style={{
            fontFamily: "var(--font-inter), system-ui, sans-serif",
            color: "#ffffff",
            textShadow:
              "0 1px 2px rgba(0,0,0,0.85), 0 2px 10px rgba(0,0,0,0.6), 0 0 24px rgba(0,0,0,0.35)",
            opacity: connected ? 0.9 : 0.45,
          }}
        >
          {connected ? "Aoede · Matrix OS" : "Connecting…"}
        </p>
        <div className="max-w-2xl text-center min-h-[2em]">
          <p
            className="text-xl md:text-2xl font-light leading-relaxed transition-opacity duration-300"
            style={{
              fontFamily: "var(--font-serif), Georgia, serif",
              color: "#ffffff",
              textShadow:
                "0 1px 2px rgba(0,0,0,0.9), 0 2px 16px rgba(0,0,0,0.7), 0 0 44px rgba(0,0,0,0.5)",
              opacity: subtitle ? 1 : 0,
            }}
          >
            {subtitle || "\u00A0"}
          </p>
        </div>
      </div>

      {/* Delegation banner — fixed + flex-center so it anchors to the
          viewport, not the canvas slice (which is narrower than the
          viewport when the chat sidebar is open). */}
      <div
        className="fixed inset-x-0 top-10 flex justify-center transition-all duration-500 pointer-events-none z-40"
        style={{
          opacity: delegation ? 1 : 0,
          transform: `translateY(${delegation ? 0 : -6}px)`,
        }}
      >
        {delegation && (
          <div
            className="flex items-center gap-3 px-5 py-2.5 rounded-full backdrop-blur-md"
            style={{
              background: "color-mix(in srgb, var(--primary) 22%, rgba(0,0,0,0.5))",
              border: "1px solid color-mix(in srgb, var(--primary) 55%, transparent)",
              boxShadow: "0 4px 24px rgba(0,0,0,0.35), 0 0 40px color-mix(in srgb, var(--primary) 25%, transparent)",
            }}
          >
            <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
              {delegation.stage !== "done" && (
                <span
                  className="absolute inline-flex h-full w-full rounded-full opacity-75"
                  style={{
                    background: "#ffffff",
                    animation: "vocal-dot-ping 1.4s cubic-bezier(0,0,0.2,1) infinite",
                  }}
                />
              )}
              <span
                className="relative inline-flex rounded-full size-2.5"
                style={{
                  background: delegation.stage === "done" ? "#6ee7b7" : "#ffffff",
                }}
              />
            </span>

            <span
              className="text-[10px] uppercase tracking-[0.25em]"
              style={{
                color: "#ffffff",
                fontFamily: "var(--font-inter), system-ui, sans-serif",
              }}
            >
              {delegation.stage === "pending"
                ? "Dispatching"
                : delegation.stage === "running"
                  ? "Building"
                  : "Built"}
            </span>

            <span
              className="text-xs max-w-[360px] truncate"
              style={{
                color: "rgba(255,255,255,0.78)",
                fontFamily: "var(--font-inter), system-ui, sans-serif",
              }}
            >
              {delegation.description}
            </span>
          </div>
        )}
      </div>

      {/* Remembered flash — shifts down when the delegation banner is visible. */}
      <div
        className="fixed inset-x-0 flex justify-center transition-all duration-500 pointer-events-none z-40"
        style={{
          top: delegation ? "5.5rem" : "2.5rem",
          opacity: rememberedFlash ? 1 : 0,
          transform: `translateY(${rememberedFlash ? 0 : -6}px)`,
        }}
      >
        <div
          className="flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-sm"
          style={{
            background: "color-mix(in srgb, var(--primary) 18%, rgba(0,0,0,0.35))",
            border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)",
          }}
        >
          <span
            className="text-[10px] uppercase tracking-[0.25em]"
            style={{ color: "#ffffff", fontFamily: "var(--font-inter), system-ui, sans-serif" }}
          >
            Remembered
          </span>
          <span
            className="text-xs max-w-[320px] truncate"
            style={{ color: "rgba(255,255,255,0.75)", fontFamily: "var(--font-inter), system-ui, sans-serif" }}
          >
            {rememberedFlash}
          </span>
        </div>
      </div>

      {error && (
        <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs">
          {error}
        </div>
      )}

      <style jsx global>{`
        @keyframes vocal-breathe {
          0%, 100% { filter: brightness(0.9) saturate(1); transform: scale(1); }
          50%       { filter: brightness(1.35) saturate(1.15); transform: scale(1.015); }
        }
        @keyframes vocal-drift {
          0%, 100% { filter: hue-rotate(0deg) brightness(1); }
          50%      { filter: hue-rotate(12deg) brightness(1.2); }
        }
        @keyframes vocal-dot-ping {
          0%   { transform: scale(1);   opacity: 0.75; }
          75%, 100% { transform: scale(2.2); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
