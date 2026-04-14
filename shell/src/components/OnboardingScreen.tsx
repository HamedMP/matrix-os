"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useOnboarding } from "@/hooks/useOnboarding";
import { useMicPermission } from "@/hooks/useMicPermission";
import { VoiceWave } from "./onboarding/VoiceWave";
import { ApiKeyInput } from "./onboarding/ApiKeyInput";
import { MicPermissionDialog } from "./MicPermissionDialog";
import { MicIcon, KeyboardIcon } from "lucide-react";

interface OnboardingScreenProps {
  onComplete: () => void;
  onOpenTerminal: () => void;
}

export function OnboardingScreen({ onComplete, onOpenTerminal }: OnboardingScreenProps) {
  const ob = useOnboarding();
  const mic = useMicPermission();
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "dimming" | "black" | "revealing">("idle");
  const [showMicDialog, setShowMicDialog] = useState(false);
  const ambientRef = useRef<HTMLAudioElement | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Live subtitle — accumulated AI transcript fragments, synced with voice
  const subtitle = ob.currentSubtitle;

  if (ob.alreadyComplete) {
    onComplete();
    return null;
  }

  // Fade out ambient audio when done
  useEffect(() => {
    if (ob.stage === "done" && gainNodeRef.current && audioCtxRef.current) {
      const gain = gainNodeRef.current;
      const ctx = audioCtxRef.current;
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 2);
      setTimeout(onComplete, 2000);
    } else if (ob.stage === "done") {
      setTimeout(onComplete, 800);
    }
  }, [ob.stage, onComplete]);

  useEffect(() => {
    return () => {
      ambientRef.current?.pause();
      audioCtxRef.current?.close();
    };
  }, []);

  function startAmbientAudio() {
    const audio = new Audio("/onboarding-ambient.wav");
    audio.loop = true;
    ambientRef.current = audio;

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gainNodeRef.current = gain;

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 5);

    source.connect(gain);
    gain.connect(ctx.destination);
    audio.play().catch(() => {});
  }

  function handleStart(useVoice: boolean) {
    // Phase 1: dim into light (text glows and screen fades to white/black)
    setPhase("dimming");
    setTimeout(() => {
      // Phase 2: fully dark
      setPhase("black");
      setStarted(true);
      startAmbientAudio();
      ob.start(useVoice);
      setTimeout(() => {
        // Phase 3: reveal destination
        setPhase("revealing");
      }, 400);
    }, 1200);
  }

  const handleTalkToMe = useCallback(async () => {
    if (mic.state === "granted") {
      handleStart(true);
      return;
    }
    if (mic.state === "denied") {
      setShowMicDialog(true);
      return;
    }
    // "prompt" or "checking": trigger the native browser prompt directly.
    const granted = await mic.requestAccess();
    if (granted) handleStart(true);
    else setShowMicDialog(true);
  }, [mic.state, mic.requestAccess]);

  const handleMicAllow = useCallback(async () => {
    const granted = await mic.requestAccess();
    setShowMicDialog(false);
    if (granted) {
      handleStart(true);
    }
  }, [mic.requestAccess]);

  // ── Voice conversation screen (editorial style) ─────────────
  const isConversing = ob.stage === "greeting" || ob.stage === "interview" || ob.stage === "connecting";

  return (
    <>
    {/* Landing screen — stays mounted as overlay during transition */}
    {phase !== "revealing" && (
      <div className="fixed inset-0 z-[60] flex flex-col bg-background">
        <MicPermissionDialog
          open={showMicDialog}
          permissionState={mic.state}
          onAllow={handleMicAllow}
          onDismiss={() => setShowMicDialog(false)}
        />

        <div className="flex-1 flex items-center justify-center">
          <button
            onClick={handleTalkToMe}
            disabled={phase !== "idle"}
            className="text-4xl font-light tracking-tight text-foreground hover:scale-110 transition-transform duration-700 ease-out"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  phase === "dimming"
                    ? "linear-gradient(90deg, var(--primary) 0%, var(--primary) 100%)"
                    : "linear-gradient(90deg, var(--foreground) 0%, var(--foreground) 35%, var(--primary) 50%, var(--foreground) 65%, var(--foreground) 100%)",
                backgroundSize: "200% 100%",
                animation: phase === "idle" ? "shimmer 6s ease-in-out infinite" : "none",
                transition: "all 1.2s ease-in-out",
              }}
            >
              Enter Matrix OS
            </span>
          </button>
        </div>

        <div
          className="flex justify-center mb-8 transition-opacity duration-500"
          style={{ opacity: phase !== "idle" ? 0 : 1 }}
        >
          <button
            onClick={() => {
              onOpenTerminal();
              onComplete();
            }}
            className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            Skip first-time setup
          </button>
        </div>

        {/* Dimming overlay */}
        <div
          className="absolute inset-0 bg-background pointer-events-none transition-opacity ease-in-out"
          style={{
            opacity: phase === "dimming" || phase === "black" ? 1 : 0,
            transitionDuration: phase === "dimming" ? "1.2s" : "0s",
          }}
        />
      </div>
    )}

    <div className="fixed inset-0 z-50 flex flex-col bg-background overflow-hidden">
      {/* Background — subtle gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-muted/30" />

      {/* Conversing layout: transcript centered, wave below, skip at bottom */}
      {isConversing && (
        <>
          {/* Center block: label + transcript */}
          <div className="absolute inset-x-0 flex flex-col items-center px-6" style={{ bottom: "28%" }}>
            {/* Label */}
            <p
              className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground/70 mb-4"
              style={{ fontFamily: "var(--font-inter), system-ui, sans-serif" }}
            >
              Aoede · Matrix OS
            </p>

            {/* Live transcript — serif, editorial */}
            <div className="max-w-xl text-center min-h-[2em]">
              <p
                className="text-xl md:text-2xl font-light text-foreground/90 leading-relaxed transition-opacity duration-300"
                style={{
                  fontFamily: "var(--font-serif), Georgia, serif",
                  opacity: subtitle ? 1 : 0.3,
                }}
              >
                {subtitle || "..."}
              </p>
            </div>

            {/* Text input (text mode only) */}
            {!ob.isVoiceMode && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = e.currentTarget.elements.namedItem("msg") as HTMLInputElement;
                  if (input.value.trim()) {
                    ob.sendText(input.value.trim());
                    input.value = "";
                  }
                }}
                className="flex gap-2 mt-8 w-full max-w-md"
              >
                <input
                  name="msg"
                  type="text"
                  placeholder="Type your response..."
                  className="flex-1 px-4 py-3 rounded-xl bg-muted/30 border border-border/50 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/20 text-sm"
                  autoFocus
                />
                <button
                  type="submit"
                  className="px-5 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  Send
                </button>
              </form>
            )}
          </div>

          {/* Voice wave — full width, below transcript */}
          <div className="absolute inset-x-0 bottom-[8%] h-[160px]">
            <VoiceWave state={ob.voiceState} />
          </div>

          {/* Skip intro — bottom */}
          <button
            onClick={() => {
              ob.chooseClaudeCode();
              onOpenTerminal();
            }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-muted-foreground transition-colors flex items-center gap-2"
          >
            <span className="text-base leading-none">›</span> Skip Intro
          </button>
        </>
      )}

      {/* Stage: extracting profile */}
      {ob.stage === "extract_profile" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          <div className="size-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          <p
            className="text-lg font-light text-foreground/70"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Preparing your workspace...
          </p>
        </div>
      )}

      {/* Stage: suggest apps */}
      {ob.stage === "suggest_apps" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6">
          <p
            className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground/70 mb-4"
          >
            Suggested for you
          </p>
          <h2
            className="text-2xl font-light text-foreground mb-8"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Here's what I'd build for you
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg w-full mb-8">
            {ob.suggestedApps.map((app) => (
              <div
                key={app.name}
                className="p-4 rounded-xl bg-card/50 border border-border/50 hover:border-primary/30 transition-colors"
              >
                <h3 className="text-sm font-medium text-foreground">{app.name}</h3>
                <p className="text-xs text-muted-foreground mt-1">{app.description}</p>
              </div>
            ))}
          </div>
          <button
            onClick={() => ob.confirmApps(ob.suggestedApps.map((a) => a.name))}
            className="px-8 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Continue
          </button>
        </div>
      )}

      {/* Stage: API key */}
      {ob.stage === "api_key" && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <ApiKeyInput
            onSubmit={ob.sendApiKey}
            result={ob.apiKeyResult}
            onSkip={() => {
              ob.chooseClaudeCode();
              onOpenTerminal();
            }}
          />
        </div>
      )}

      {/* Stage: done */}
      {ob.stage === "done" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          <p
            className="text-2xl font-light text-foreground"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            You're all set
          </p>
          <p className="text-sm text-muted-foreground">Loading your workspace...</p>
        </div>
      )}

      {/* Error */}
      {ob.error && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs">
          {ob.error}
        </div>
      )}
    </div>
    </>
  );
}
