"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useOnboarding } from "@/hooks/useOnboarding";
import { useMicPermission } from "@/hooks/useMicPermission";
import { VoiceWave } from "./onboarding/VoiceWave";
import { ApiKeyInput } from "./onboarding/ApiKeyInput";
import { BrandFrame } from "./onboarding/BrandFrame";
import { CapabilityIntro } from "./onboarding/CapabilityIntro";
import { GoalSelector } from "./onboarding/GoalSelector";
import { ReadinessChecklist } from "./onboarding/ReadinessChecklist";
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

  // If onboarding is already complete, tell the parent to unmount us.
  // This must run as an effect -- calling onComplete() during render
  // triggers a parent setState mid-child-render, which React rejects.
  useEffect(() => {
    if (ob.alreadyComplete) {
      onComplete();
    }
  }, [ob.alreadyComplete, onComplete]);

  // Fade out ambient audio when done
  useEffect(() => {
    if (ob.alreadyComplete) return;
    if (ob.stage === "done" && gainNodeRef.current && audioCtxRef.current) {
      const gain = gainNodeRef.current;
      const ctx = audioCtxRef.current;
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 2);
      setTimeout(onComplete, 2000);
    } else if (ob.stage === "done") {
      setTimeout(onComplete, 800);
    }
  }, [ob.stage, ob.alreadyComplete, onComplete]);

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
    audio.play().catch((err: unknown) => {
      console.warn("[onboarding] ambient audio playback failed", err);
    });
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

  // Render nothing for the one frame between "alreadyComplete" becoming
  // true and the parent unmounting us via the effect above. Placing this
  // return AFTER all hooks keeps hook ordering stable.
  if (ob.alreadyComplete) {
    return null;
  }

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

        <BrandFrame>
          <div className="space-y-5">
            <CapabilityIntro />
            <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-[#111612]">Choose your first goal</h2>
                  <span className="text-xs text-[#17281f]/55">You can change this later</span>
                </div>
                <GoalSelector selectedGoalIds={ob.selectedGoalIds} onSelect={ob.selectGoal} />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-[#111612]">Readiness</h2>
                  <span className="text-xs capitalize text-[#17281f]/55">{ob.readiness?.overallStatus ?? "checking"}</span>
                </div>
                <ReadinessChecklist gates={ob.readiness?.gates ?? []} />
              </div>
            </div>

            {ob.onboardingSteps.length > 0 && (
              <div className="rounded-md border border-[#17281f]/10 bg-[#17281f]/5 p-3">
                <h2 className="text-sm font-semibold text-[#111612]">Setup path</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {ob.onboardingSteps.map((step) => (
                    <span key={step.id} className="rounded-full border border-[#17281f]/10 bg-white/55 px-3 py-1 text-xs text-[#17281f]/70">
                      {step.required ? "Required" : "Optional"} · {step.title}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                onClick={handleTalkToMe}
                disabled={phase !== "idle" || started}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-[#17281f] px-4 text-sm font-medium text-[#f4f0e8] transition hover:bg-[#23382c] disabled:opacity-55"
              >
                <MicIcon className="h-4 w-4" aria-hidden="true" />
                Start with voice
              </button>
              <button
                onClick={() => handleStart(false)}
                disabled={phase !== "idle" || started}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border border-[#17281f]/15 bg-white/55 px-4 text-sm font-medium text-[#17281f] transition hover:border-[#17281f]/30 disabled:opacity-55"
              >
                <KeyboardIcon className="h-4 w-4" aria-hidden="true" />
                Start with text
              </button>
            </div>

            </div>
            <button
              onClick={() => {
                onOpenTerminal();
                onComplete();
              }}
              className="block w-full text-center text-xs text-[#17281f]/50 transition hover:text-[#17281f]"
            >
              Skip first-time setup
            </button>
          </div>
        </BrandFrame>

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
              onComplete();
            }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-muted-foreground transition-colors flex items-center gap-2"
          >
            <span className="text-base leading-none">›</span> Skip Intro
          </button>
        </>
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
              onComplete();
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
